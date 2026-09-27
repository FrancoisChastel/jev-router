# jev-router

Harness-agnostic LLM router for agentic coding. It routes each turn to the cheapest model and reasoning effort that can finish the job, using Switchyard-style execution signals from tool results and TypeSafe's jev as a fast, calibrated judge.

Status: early. The core decision engine, the judge transports, and the Pi extension exist. Claude Code, Codex, and OpenCode adapters, the local relay, and the measurement tooling are next. See [DESIGN.md](./DESIGN.md).

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
