# jev-router

Harness-agnostic LLM router for agentic coding. It routes each turn to the cheapest model and reasoning effort that can finish the job, using Switchyard-style execution signals from tool results and TypeSafe's jev as a fast, calibrated judge.

Status: early. The core decision engine, judge transports, Pi extension, local relay, hook packs for Claude Code and Codex, OpenCode plugin, installer, and measurement tooling (stats, replay, shadow mode) exist. Not yet done: the Harbor benchmark run that would justify any savings claim, the AI SDK middleware, and expected-value switching with cache affinity. See [DESIGN.md](./DESIGN.md).

## How it decides

1. Hard overrides: a post-compaction request, three consecutive all-failure tool batches, or a critical error escalate one tier and hold it.
2. Holds and leases: a clean tool continuation reuses the last decision; nothing is re-judged mid-chain unless something went wrong.
3. Deterministic signals: recent tool outcomes are scored the Switchyard way (severity, spinning, exploring versus producing). Decisive scores skip the judge.
4. Judge: on a new user turn, or when the signals are ambiguous, one jev call answers five task questions or three execution questions against a bounded dossier. jev never sees the full conversation.
5. Policy: plain rules map the answers to a candidate and an effort. Low judge confidence keeps the current tier. Every decision logs raw answers and a counterfactual cost for each candidate.

## Pi extension

Requires Pi 0.87 or later and an OpenRouter, Vercel AI Gateway, or TypeSafe key for the judge.

```bash
# 1. policy
mkdir -p ~/.jev-router
cp examples/policy.json ~/.jev-router/policy.json   # edit candidates and rules to taste
export OPENROUTER_API_KEY=sk-or-...                  # judge key; see judge.transport in the policy

# 2. load the extension
pi install npm:jev-router          # once published
pi -e ./dist/adapters/pi/index.js  # from a checkout, after `bun run build`
```

Inside Pi, `/jev-router status`, `/jev-router off`, and `/jev-router on` control it. Picking a model by hand with `/model` pauses routing until you run `/jev-router on`; the router never fights a manual choice.

Decisions are appended to `~/.jev-router/decisions.jsonl`. Set `JEV_ROUTER_HOME` to move both files, or `JEV_ROUTER_POLICY` and `JEV_ROUTER_LOG` individually.

Candidate models are looked up in Pi's own registry by provider and id. `via: openrouter` maps to Pi's `openrouter` provider and `via: vercel` to `vercel-ai-gateway`; set `pi.provider` or `pi.model` on a candidate to override.

## Local relay for Claude Code, Codex, OpenCode, and any OpenAI-compatible client

The relay speaks each client's own wire format and forwards it unchanged to OpenRouter or Vercel AI Gateway, rewriting only the model and effort. No cross-format translation, so streaming, tool use, thinking, and prompt caching pass through as the client sent them.

```bash
mkdir -p ~/.jev-router && cp examples/policy.json ~/.jev-router/policy.json
export OPENROUTER_API_KEY=sk-or-...        # both the judge and the egress in the example policy
npx jev-router up --port 4141
```

### One-command setup

```bash
npx jev-router setup --dry-run              # show every change first
npx jev-router setup                        # claude-code, codex, opencode, pi
npx jev-router setup --agent claude-code    # one harness
```

Setup seeds `~/.jev-router/policy.json` from the example if missing, points each installed harness at the relay, installs its hook pack, and backs up every file it touches as `.bak`. Hook packs are sensors: Claude Code and Codex hooks cannot change the model, so they report tool outcomes, compaction, subagent starts, and API failures to the relay, which then has better evidence than body parsing recovers. Claude Code uses HTTP hooks with a two-second timeout; Codex uses `jev-router hook codex` as a command hook. A stopped relay never blocks a tool.

The Claude Code plugin is also installable from this repo as a marketplace: `claude plugin marketplace add FrancoisChastel/jev-router`, then `claude plugin install jev-router@jev-router`. It adds `/jev-router:status`.

Clients pick a route by model id. `auto` is the generic route; `claude-code/auto` exists because Claude Code's picker only shows ids containing `claude`. Any other model id passes straight through to the default egress.

| Harness | Configuration |
|---|---|
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:4141`, `ANTHROPIC_AUTH_TOKEN=anything`, `ANTHROPIC_API_KEY=""`, `ANTHROPIC_MODEL=claude-code/auto`. Set `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` so the relay receives request class and compaction hints. |
| Codex | In `~/.codex/config.toml`: `model_provider = "jev"`, `model = "auto"`, and `[model_providers.jev]` with `base_url = "http://127.0.0.1:4141/v1"`, `wire_api = "responses"`, `env_key = "JEV_ROUTER_TOKEN"` (any value). |
| OpenCode | `npx jev-router setup --agent opencode` adds a `jev-router` provider with an `auto` model and drops a plugin into `~/.config/opencode/plugins/` that tags requests with the session id and reports tool results, compaction, and API errors to the relay. |
| Pi | Prefer the in-process extension above. To use the relay instead, add a provider with `api: openai-completions`, `baseUrl: http://127.0.0.1:4141/v1`, and a model `auto`. |

Responses carry `x-jev-router-model`, `x-jev-router-candidate`, `x-jev-router-effort`, and `x-jev-router-source`, and every decision is appended to `~/.jev-router/decisions.jsonl` with the usage the upstream reported.

Two more endpoints serve plugins: `POST /decide` returns a decision for a request a plugin describes itself, and `POST /observe` accepts hook events such as `{ "session": "cc:<id>", "event": "compaction" }` or `{ "event": "tool_result", "tool": { "name": "Bash", "isError": true, "text": "..." } }` so harness hooks can feed higher-fidelity signals than body parsing recovers.

The relay binds to localhost and does not authenticate callers. Keep it there.

## Measure before believing

Every decision is one JSONL line: the raw judge answers, the decision and why, whether it was applied, and the tokens the upstream reported. Three commands read it.

```bash
jev-router stats                       # actual cost versus "always fast", "always mid", "always frontier"
jev-router replay --policy new.json    # re-decide the same log under another policy, no judge calls
jev-router up --shadow frontier        # serve one model for everything, log what the router would have done
```

`stats` reports savings against every single-candidate baseline, including the ones the router loses to. `replay` reuses the recorded judge answers so policy iteration is free, with the caveat that it assumes the same tokens would have flowed through the other model. Shadow mode is how to trial the router on real traffic without letting it touch anything.

None of this is a benchmark. The design calls for Harbor runs on Terminal-Bench with Claude Code, Codex, OpenCode, and Pi against single-model baselines, and no savings claim should be made before those exist.

## Policy file

`examples/policy.json` is the reference. JSON always works; YAML works under Bun or with the optional `yaml` package installed. Rule expressions are a tiny whitelisted language: identifiers, numbers, strings, comparisons, `in [...]`, `and`, `or`, `not`. Nothing executes.

```json
{ "when": "stakes >= 2 and difficulty >= 3", "then": { "at_least": "frontier", "effort": "high" } }
```

Actions: `pin`, `at_least`, `up`, `allow_down`, `effort`, `hold_turns`.

## Library

```ts
import { plan, loadPolicy, emptySession } from "jev-router/core";
import { HttpJudge } from "jev-router/judge";

const policy = loadPolicy(JSON.parse(await Bun.file("policy.json").text()));
const judge = new HttpJudge({ transport: "openrouter", apiKey: process.env.OPENROUTER_API_KEY! });

const outcome = plan({ request, session: emptySession(), policy, policyId: "default" });
const { decision, session } = outcome.kind === "decision"
  ? outcome
  : outcome.conclude((await judge.evaluate(outcome.judgeRequest)).answers);
```

`plan` is pure: no network, no clock. It either returns a decision or a judge request plus a `conclude` continuation.

## Development

```bash
bun install
bun run check     # typecheck, lint, tests
bun run build
```

MIT licensed.
