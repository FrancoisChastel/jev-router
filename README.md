# jev-router

[![CI](https://github.com/FrancoisChastel/jev-router/actions/workflows/ci.yml/badge.svg)](https://github.com/FrancoisChastel/jev-router/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@french-castle/jev-router)](https://www.npmjs.com/package/@french-castle/jev-router)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Route every turn of your coding agent to the cheapest model that can finish it.

<p align="center">
  <img src="https://raw.githubusercontent.com/FrancoisChastel/jev-router/main/docs/assets/flow.svg" width="880" alt="Requests from Claude Code, Codex, OpenCode, or Pi pass through jev-router, where tool signals, the jev judge, and a policy pick the fast, mid, or frontier tier via OpenRouter or Vercel AI Gateway.">
</p>

jev-router sits between Claude Code, Codex, OpenCode, or Pi and your model gateway. It watches how the agent is doing, asks [TypeSafe's jev](https://typesafe.ai) a few typed questions when the situation is unclear, and picks a model and reasoning effort per turn. It logs every decision with what it would have cost on every other model, so you can see whether routing pays before you trust it.

- **One key, one bill.** An OpenRouter or Vercel AI Gateway key serves both the judge and inference.
- **Nothing rewritten but the model.** Requests are forwarded in the client's own wire format. Streaming, tools, thinking, and prompt caching pass through untouched.
- **Fails open.** Judge down, key missing, model not found: the request goes through on the default model and the log says why.
- **Honest numbers.** `stats` compares against always-cheap and always-frontier alike, including when the router loses.

## Requirements

- Node 22 or later
- One of the harnesses: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [OpenCode](https://opencode.ai), or [Pi](https://github.com/earendil-works/pi)
- A key that can reach jev, for the judge: an [OpenRouter](https://openrouter.ai/keys) key or a [Vercel AI Gateway](https://vercel.com/ai-gateway) key. It also serves inference for harnesses that have no login of their own

## Quick start

```bash
npm install -g @french-castle/jev-router
jev-router setup
```

`setup` asks once for a judge key (an OpenRouter or Vercel AI Gateway key; jev costs about $0.00003 a decision), finds your Claude Code and Codex logins and any gateway keys, writes `~/.jev-router/policy.json` with live prices, points every installed harness at the relay, installs the relay as a background service (launchd on macOS, systemd on Linux), and checks that it answers. Preview everything with `--dry-run`. `npx @french-castle/jev-router setup` works without a global install.

Then use your harness as usual. Claude Code shows `auto (jev-router)` in `/model` and is set to it; Codex and OpenCode use the `auto` model; Pi runs the extension in-process. The pieces are also available one at a time: `init`, `ping`, `up`, `service`; see `jev-router help`.

To undo it: `jev-router service uninstall` stops and removes the background relay, every harness file `setup` changed has a `.bak` copy next to it, and `~/.jev-router` holds the policy, the decision log, and the judge key file; delete it and the package is gone.

## What you get

| What you have | Judge | Inference |
|---|---|---|
| `OPENROUTER_API_KEY` | jev through OpenRouter Decisions | OpenRouter |
| `AI_GATEWAY_API_KEY` | jev through Vercel AI Gateway | Vercel AI Gateway |
| `TYPESAFE_API_KEY` plus one of the above | jev direct from TypeSafe (`init --judge typesafe`) | that gateway |
| `TYPESAFE_API_KEY` only | jev direct from TypeSafe | none for the relay; the Pi extension still routes with Pi's own providers |
| Claude Code logged in with a claude.ai plan (Pro, Max) | one of the keys above | your plan, through Claude Code's own login: Haiku, Sonnet, Opus |
| Codex logged in with ChatGPT | one of the keys above | your plan, through Codex's own login: the models your plan lists |

Logins are never copied or stored. The harness sends its own credentials, the relay forwards them unchanged to Anthropic or OpenAI and only chooses the model, and `init` reads nothing but the plan type to know which models to offer. Costs for plan-backed models are shown at API list prices, the same scale a plan's allowance is consumed on.

The generated policy has three candidates on models available on both gateways:

| Tier | Model | When it is chosen |
|---|---|---|
| fast | `openai/gpt-6-luna` | Default. Routine edits, lookups, auxiliary calls, compaction |
| mid | `anthropic/claude-sonnet-5` | Substantial work, anything needing careful reasoning, high stakes such as auth or payments |
| frontier | `anthropic/claude-opus-5.5` | Deep problems with high stakes, and recovery after repeated tool failures |

Edit `~/.jev-router/policy.json` to change models, prices, or rules. `jev-router policy` validates it. See [docs/policy.md](./docs/policy.md).

## How it decides

1. **Hard overrides.** A request right after context compaction, three consecutive all-failure tool batches, or a critical error escalates one tier and holds it for two turns.
2. **Holds and leases.** A clean tool continuation reuses the last decision. Nothing is re-judged mid-chain unless something went wrong.
3. **Tool signals.** Recent tool outcomes are scored the way NVIDIA's Switchyard does it: error severity, spinning, and exploring push toward a capable model, steady production pushes toward a cheap one. A decisive score skips the judge.
4. **The judge.** On a new user turn, or when the signals are ambiguous, one jev call answers five task questions or three execution questions against a bounded summary. jev never sees the full conversation. It costs about three thousandths of a cent and returns in a few hundred milliseconds.
5. **Policy.** Plain rules map the answers to a candidate and an effort. Low confidence on a question a rule depends on keeps the current tier.
6. **Switch cost.** An escalation first raises reasoning effort on the current model and changes model only once effort is maxed out. A downgrade that would drop more prompt cache than it saves over the next few turns is skipped. Stakes rules and hard overrides still switch at once.

Every decision is one line in `~/.jev-router/decisions.jsonl`: raw answers, the decision and its reasons, whether it took effect, the tokens the upstream reported, and the cost on every other candidate.

## Harnesses

| Harness | How routing is applied | What the harness tells the router |
|---|---|---|
| Claude Code | Local relay via `ANTHROPIC_BASE_URL`, on your claude.ai login or a gateway key | Plugin hooks report tool successes and failures, compaction, subagents, API errors; gateway hint headers carry request class |
| Codex | Local relay as a Responses-API model provider, on your ChatGPT login or a gateway key | Hooks report tool results, compaction, prompts |
| OpenCode | Local relay as an OpenAI-compatible provider | Plugin tags requests with the session and reports tool results, compaction, API errors |
| Pi | In-process extension, no relay | Everything: prompts, tool results, compaction, model changes |
| Cursor (Chat and Agent) | A token-guarded relay published by `jev-router expose`, set as Cursor's OpenAI base URL; Tab and the Cursor CLI are not routed | The request body only: its tool results; no hooks |

`jev-router setup` configures whichever of the first four are installed, backs up every file it touches, and keeps the relay running as a background service. Cursor calls the relay from its own servers, so `setup` prints its steps instead of writing files. [docs/harnesses.md](./docs/harnesses.md) has the manual steps, the service commands, and the Claude Code marketplace install.

## Measure before believing

```bash
jev-router stats                       # actual cost versus every single-model baseline
jev-router replay --policy new.json    # re-decide the same log under another policy, no judge calls
jev-router up --shadow frontier        # serve one model, log what the router would have done
```

None of this is a benchmark. [docs/evaluation.md](./docs/evaluation.md) is the runbook for Terminal-Bench through Harbor with each harness against single-model baselines. Until that has been run, treat any savings figure as unproven.

## Library

```ts
import { plan, loadPolicy, emptySession } from "@french-castle/jev-router/core";
import { HttpJudge } from "@french-castle/jev-router/judge";

const policy = loadPolicy(JSON.parse(await readFile("policy.json", "utf8")));
const judge = new HttpJudge({ transport: "openrouter", apiKey: process.env.OPENROUTER_API_KEY! });

const outcome = plan({ request, session: emptySession(), policy, policyId: "default" });
const { decision } = outcome.kind === "decision" ? outcome : outcome.conclude((await judge.evaluate(outcome.judgeRequest)).answers);
```

`plan` is pure: no network, no clock. The core and judge modules run on Node, Bun, and edge runtimes.

## Status and limits

Early. The mechanics have been verified live against OpenRouter, and against Claude Code's and Codex's own logins: real judge decisions, and Anthropic streaming, OpenAI chat, and Responses requests routed and echoed correctly. What has not been done: the benchmark that would justify a savings claim, live runs against Vercel and TypeSafe, and the AI SDK middleware. Run the relay with Node; under Bun a client cancellation does not propagate to the upstream. The relay binds to localhost; binding wider requires `--token`, and a `--token` bind cannot forward a harness's own login, so plan-backed routing stays on loopback.

## Documentation

- [Design](./DESIGN.md): the architecture, the decision pipeline, and every decision with its rationale
- [Policy reference](./docs/policy.md)
- [Harness setup](./docs/harnesses.md)
- [Evaluation runbook](./docs/evaluation.md)
- [Changelog](./CHANGELOG.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). `bun install && bun run check` runs everything CI runs. Security reports go to the address in [SECURITY.md](./SECURITY.md).

## Acknowledgements

The execution-phase routing idea comes from [NVIDIA Switchyard](https://github.com/NVIDIA-NeMo/Switchyard). The judge is [jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) by TypeSafe. The OpenRouter Decisions and Vercel AI Gateway evaluation surfaces make one-key setups possible.

MIT licensed.
