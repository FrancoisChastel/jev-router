# jev-router design

Status: draft v0.1, agreed in brainstorm on 2026-09-27. This document records what we decided, why, and what is still open. It is the reference for v1 implementation.

## 1. What this is

An open, auditable, harness-agnostic LLM router for agentic coding workloads. It combines two ideas:

- NVIDIA Switchyard's insight that routing during agent execution, using tool-outcome signals, beats single-turn difficulty classification.
- TypeSafe's jev as the judge: a System One model that answers typed questions in one parallel pass, in 70 to 500 ms, for about $0.042 per million input tokens, with calibrated probabilities and a confidence score.

It installs into the harnesses people already use (Pi, Claude Code, Codex, OpenCode, later Hermes and others), applies decisions in-process where the harness allows and through a small local relay where it does not, and measures itself honestly with counterfactual cost accounting.

## 2. Why it should exist

The space already has at least eight open-source jev routers, TypeSafe's own `typesafe/jev-router` on OpenRouter, and Vercel's `auto()` model in the eve framework. Almost all of them are single-turn difficulty classifiers on a chat proxy. None combines:

1. Execution-phase signals from tool results (Switchyard stage router) with a fast calibrated judge (jev) instead of a slow LLM judge.
2. Deterministic policy where jev classifies the task and code picks the model, so decisions are replayable offline when the policy or catalog changes.
3. Costed switching that accounts for price delta, lost prompt cache, and lost thinking-signature continuity.
4. Honest measurement: counterfactual cost per candidate, stats against every baseline, shadow mode, offline replay, and Harbor-based agentic benchmarks.
5. Native harness plugins for install and signals, with a shared core.

The official OpenRouter router is free but a black box: no candidate constraints, no published eval, OpenRouter-only. tiershift's own README concedes that frontier models earn their price on long agentic tasks, which is exactly where single-turn routers are blind.

## 3. Principles

- One core, two actuators. The decision engine is a pure function. A decision is applied in-process (Pi, Hermes, OpenCode effort) or by the relay (Claude Code, Codex, OpenCode model).
- jev classifies, code decides. jev never sees the candidate list in the default mode. An option-pick mode exists per route for users who want eve-style descriptions.
- Format-preserving relay. v1 egress goes only to gateways that speak the client's own wire format (OpenRouter, Vercel AI Gateway) or to a direct provider when the format already matches. No cross-format translation in v1.
- Fail open, invisibly. Judge timeout, error, or low confidence leaves the request on the policy default. A broken router must be indistinguishable from an uninstalled one.
- Measure before claiming. Every decision logs raw judge answers, decision source, actual usage, and counterfactual cost for every candidate.
- Bounded dossier. The judge receives a capped summary, never the full conversation. Redaction hook available.
- Lightweight. Zero-dependency core on native fetch. Single npm package with subpath exports. Runs on Node 22+, Bun, and edge runtimes.

## 4. Architecture

```
                 ┌──────────────────────────────────────────┐
 harness plugins │  pi ext │ claude-code │ codex │ opencode │  sensors + (where possible) actuators
                 └────┬────┴──────┬──────┴───┬───┴────┬─────┘
                      │ in-proc   │ hooks    │ hooks  │ hooks + chat.params
                      ▼           ▼          ▼        ▼
                 ┌──────────────────────────────────────────┐
                 │ core: normalize → signals → policy → decision (pure, no I/O) │
                 └──────────────┬───────────────────────────┘
                                │ judge interface (typesafe | vercel | openrouter | mock | custom)
                 ┌──────────────┴───────────────────────────┐
                 │ daemon: /v1/messages, /v1/responses, /v1/chat/completions (relay) │
                 │         /decide (advisory), /observe (sensor ingest), /v1/models  │
                 │         decision log, stats, replay, shadow                       │
                 └──────────────┬───────────────────────────┘
                                │ same wire format, model + effort rewritten
                 ┌──────────────┴───────────────────────────┐
                 │ OpenRouter · Vercel AI Gateway · direct provider (format match) │
                 └──────────────────────────────────────────┘
```

### 4.1 Core (`jev-router/core`)

Pure decision engine. Inputs: a normalized request (messages digest, tools, image flag, estimated tokens, requested model, harness profile), session state (prior decision, turn index, tool-outcome ledger, hold counter, cache-affinity evidence), and judge answers. Output: a `Decision`.

```ts
type Decision = {
  candidate: string;            // policy candidate id
  model: string;                // upstream model id
  effort?: "minimal"|"low"|"medium"|"high"|"xhigh"|"max";
  source: "override"|"hold"|"signals"|"judge"|"rules"|"fallback"|"shadow";
  confidence?: number;          // judge confidence when source = judge
  reasons: string[];            // human-readable, stable vocabulary
  counterfactuals: Record<string, { estCostUsd: number }>;
  lease: "one_call"|"tool_chain"|"user_turn";
};
```

No network, no clock, no randomness. Fully testable against recorded fixtures.

### 4.2 Judge (`jev-router/judge`)

Interface with transports:

| Transport | Endpoint | Model id | Notes |
|---|---|---|---|
| TypeSafe direct | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest` | Official SDKs: `@typesafe-ai/sdk`, `typesafe-sdk` |
| Vercel AI Gateway | `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` | Same request shape. Also `/v1/evaluate`. Supports evaluation fallbacks (`confidenceBelow`, `probabilityBetween`) |
| OpenRouter Decisions | `POST https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` or `~typesafe/jev-latest` | Adds `session_id`, `user`, `usage.cost`. 32k context |
| Mock | in-memory | | Fixture-driven for tests |

One request per decision, all questions in the same call (speculative fan-out). Timeout 1.5 s default. Retry once on 429/529 with jitter, then fail open.

Question types: `choice` (up to 255 options, returns choice, probabilities, confidence), `score` (2 to 10 ordered levels, returns probability-weighted score, probabilities, confidence), `noul` (yes/no, returns P(true)). Confidence is a concentration statistic of the distribution; for three options it is `(3 * p_max - 1) / 2`.

The interface is deliberately generic so a local small model with structured output can be dropped in later.

### 4.3 Daemon (`jev-router/daemon`)

Local service, started on demand by adapters or the CLI.

- Relay: `POST /v1/messages` (Anthropic Messages), `POST /v1/responses` (OpenAI Responses), `POST /v1/chat/completions` (OpenAI chat). Streaming SSE preserved byte-for-byte except the `model` field and effort. Echoes the requested model id in responses; real model in `x-jev-router-model`. Also `GET /v1/models` in each dialect, `POST /v1/messages/count_tokens` passthrough, `HEAD /api/hello`.
- `POST /decide`: advisory decision for in-process plugins in any language.
- `POST /observe`: sensor ingest from harness hooks (tool outcome, compaction, API failure, subagent start, prompt submit).
- Decision log (JSONL), `stats`, `replay`, shadow mode.

### 4.4 Adapters (`jev-router/adapters/*`)

| Harness | Actuator | Sensors | Install |
|---|---|---|---|
| Pi | In-process. `ctx.modelRegistry.find(provider, id)` then `pi.setModel(model)`, `pi.setThinkingLevel(level)`. A manual `/model` pick pauses routing until `/jev-router on`. Optional virtual `auto` model via `pi.registerProvider` is deferred | `before_agent_start`, `turn_end` (tool results), `tool_execution_end` (`isError`), `session_compact` (reason), `model_select`, `before_provider_headers` | `pi install npm:@french-castle/jev-router` (package exposes the extension via the `pi` key) |
| Claude Code | Relay via `ANTHROPIC_BASE_URL`, written by the installer or the user | Plugin hooks (command or http) for `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `PostCompact`, `SubagentStart`, `Stop`, `StopFailure`, `UserPromptSubmit`. Payloads carry `session_id`, `prompt_id`, `agent_id`, `effort.level`. Plus opt-in gateway hint headers | Marketplace plugin with hooks, a status skill, `userConfig` for keys |
| Codex | Relay configured as `model_providers.jev-router` with `wire_api = "responses"` (the only supported value) | Hooks: `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `Stop`, `SessionStart` | Plugin with hooks and skill; installer writes `config.toml` |
| OpenCode | Effort in-process via `chat.params` output `options`; model via relay configured as a provider in `opencode.json` | `tool.execute.after`, `event` (`session.compacted`, `session.error`), `chat.headers` injects session id | `plugin: ["jev-router/adapters/opencode"]` in `opencode.json` |
| Hermes (later) | In-process via `llm_request` middleware (Python) calling `/decide` | middleware | `hermes plugins install` |

Harness hooks in Claude Code and Codex cannot change the model, reasoning effort, or the outgoing request. That is why the relay stays the actuator there.

### 4.5 Installer (`jev-router/cli`)

`bunx jev-router setup [--agent pi|claude-code|codex|opencode] [--dry-run]`. Detects installed harnesses, shows a diff, backs up files as `.bak`, writes base URLs or provider entries, installs the native plugin. Mirrors `vercel ai-gateway setup`.

### 4.6 AI SDK middleware (later)

`wrapLanguageModel` middleware for app developers. No open-source equivalent exists today. After v1.

## 5. Decision pipeline

1. Normalize the request. Detect harness profile from user agent and headers, or from route config.
2. Resolve session key: `x-claude-code-session-id` → Codex `session_id` / `conversation_id` → Pi `x-session-id` → OpenCode `X-Opencode-Session` → generic `x-session-id` → hash of conversation prefix. Claude Code subagents get their own key from `x-claude-code-agent-id`.
3. Apply hard overrides: capability filter (vision, context, tools), request class (Claude Code `auxiliary` and `compaction` go to the cheap tier without a judge call), post-compaction escalation, repeated tool failures, critical error markers.
4. Honor an active lease or capable-hold. Provider retries inside one call keep the call's decision.
5. Deterministic execution-phase score from the tool ledger (Switchyard stage router): recovery axes `severity`, `spinning`, `exploring` push toward capable; `production_intensity` pushes toward efficient. Signed score tanh-squashed to confidence in [0, 1]. Ambiguous band is `[-threshold, +threshold]`, default 0.5. `recent_turn_window` 3, `capable_hold_turns` 2.
6. If new user turn, or score ambiguous, or no history: one judge call with the question set in section 6, on a bounded dossier.
7. Policy rules map answers to a candidate and effort. Confidence gate: below `min_confidence`, keep current tier.
8. Switch cost: switch only if expected gain beats price delta plus lost prompt cache plus lost thinking continuity. v1 uses thresholds and hold turns. v2 uses expected value with measured `cache_read_input_tokens`. Prefer switching at user-turn boundaries. For Codex, prefer adjusting effort over switching models.
9. Execute through the relay or hand the decision to the in-process actuator. Fallback chain on 429 and 5xx.
10. Log one JSONL line with raw answers, decision, source, usage, and counterfactual cost per candidate.

## 6. Judge question set v1

Task phase, asked on each new user turn against a dossier of the last user ask, a short assistant-intent tail, and tool names:

| id | type | instructions (draft) | criteria |
|---|---|---|---|
| `difficulty` | score | How hard is this request for a coding agent? | trivial ack or lookup / routine bounded edit / multi-file change with judgment / deep debugging, design, or research |
| `needs_reasoning` | noul | Does this need extended step-by-step reasoning to get right? | |
| `stakes` | score | How costly is a wrong or sloppy answer here? | cosmetic / rework / breaks builds or data / security, auth, payments, migrations |
| `output_kind` | choice | What kind of output is expected? | short_answer, code_edit, long_generation, plan, tool_plan |
| `long_context` | noul | Does the task require reading or holding a lot of context? | |

Execution phase, asked only when the deterministic score is ambiguous, against a tool-result digest (counts plus at most three short excerpts, errors first):

| id | type | instructions (draft) |
|---|---|---|
| `tools_failed` | noul | Did the most recent tool calls fail or produce errors? |
| `spinning` | noul | Is the agent repeating the same actions without making progress? |
| `producing` | noul | Is the agent now writing or editing files rather than exploring? |

Option-pick mode (per route, opt-in): one `choice` over candidate ids with user-authored descriptions, eve style. Not replayable across catalog changes; documented as such.

## 7. Policy schema v1

The on-disk format is JSON at `~/.jev-router/policy.json`; YAML is accepted under Bun or when the optional `yaml` package is installed. The sketch below is YAML for readability. `examples/policy.json` is the reference file.

```yaml
version: 1

judge:
  transport: openrouter            # typesafe | vercel | openrouter | mock
  model: typesafe/jev-1.13
  timeout_ms: 1500
  on_error: fail_open
  mode: signals                    # signals | option_pick

egress:
  openrouter: { base_url: https://openrouter.ai/api, api_key_env: OPENROUTER_API_KEY }
  vercel:     { base_url: https://ai-gateway.vercel.sh, api_key_env: AI_GATEWAY_API_KEY }

candidates:
  fast:     { via: openrouter, model: openai/gpt-5.4-mini,       price: { in: 0.15, out: 0.60 } }
  mid:      { via: openrouter, model: anthropic/claude-sonnet-5, price: { in: 3.00, out: 15.0 }, effort: [low, medium, high] }
  frontier: { via: openrouter, model: openai/gpt-6-astra,        price: { in: 10.0, out: 40.0 }, effort: [medium, high, xhigh] }

routes:
  - id: claude-code/auto                # advertised model id; must contain "claude" for Claude Code's picker
    harness: claude-code
    policy: default
  - id: auto
    harness: any
    policy: default

policies:
  default:
    default: fast
    min_confidence: 0.6
    hold_turns: 2
    confidence_threshold: 0.5           # ambiguous band for the deterministic score
    rules:
      - when: request_class in [auxiliary, compaction]      then: { pin: fast }
      - when: difficulty >= 2 or needs_reasoning > 0.8       then: { at_least: mid }
      - when: stakes >= 2 and difficulty >= 3                 then: { at_least: frontier, effort: high }
      - when: tools_failed > 0.7 or spinning > 0.7            then: { up: 1 }
      - when: context_compacted                               then: { up: 1, hold_turns: 2 }
      - when: producing > 0.8 and tools_failed < 0.2          then: { allow_down: true }
    switch:
      cache_penalty: true
      prefer_effort_over_model: true    # Codex
```

Rule expressions are a tiny, whitelisted grammar: identifiers, numeric comparisons, `in`, `and`, `or`, `not`. No code execution. Identifiers are checked at load time against the deterministic context keys and the judge question ids, so a typo fails the policy load instead of silently never matching. A missing identifier makes its sub-expression unknown, and unknown never fires a rule, even under `not`. Compaction is a built-in override, not a rule input. `confidence_threshold` must be at least tanh(0.5), about 0.462, so a single tool-signal axis can never decide alone. `judge.on_error: fail_closed` sends an unjudged turn to the most capable candidate; `fail_open` keeps the current tier.

## 8. Wire-format handling in the relay

- Ingress dialects: Anthropic Messages, OpenAI Responses, OpenAI chat. Streaming in every dialect.
- Egress: same dialect to a gateway that serves it for any model. OpenRouter serves `/api/v1/messages`, `/api/v1/responses`, `/api/v1/chat/completions`. Vercel serves `/v1/messages`, `/v1/responses`, `/v1/chat/completions`, plus `/claude-code` and `/codex/v1` surfaces. Direct provider only when the dialect matches.
- The relay rewrites `model` and effort, nothing else. OpenAI chat uses `reasoning_effort`, Responses uses `reasoning.effort`, and Anthropic uses `output_config.effort` with values low, medium, high, xhigh, max. The Anthropic field is only rewritten when the client already sent it. Anthropic invalidates the prompt cache when top-level effort changes between requests, so effort changes count as a cache loss in the switch cost, and per-message effort (beta) is the v2 path for cache-preserving changes.
- Responses echo the requested model id. Real routing goes in headers: `x-jev-router-model`, `x-jev-router-candidate`, `x-jev-router-source`, `x-jev-router-decision-id`.

### 8.1 Claude Code conformance checklist (from Anthropic's gateway compatibility guide)

- Serve `/v1/messages` (requests arrive as `/v1/messages?beta=true`). Optional `count_tokens`. Reject `HEAD /api/hello` harmlessly.
- Forward `anthropic-version` and `anthropic-beta` verbatim. Treat `anthropic-*` headers and body fields as open lists.
- Never reshape the `system` array. Keep the attribution block first and separate.
- Never buffer. Forward `ping` events. Preserve event order. End with `message_delta` and `message_stop`.
- Return `text/event-stream`, integer `retry-after`, pass through `x-should-retry` and `anthropic-ratelimit-unified-*`.
- Forward error bodies unmodified.
- `GET /v1/models?limit=1000` within 3 s, no redirects. Only ids containing `claude` or `anthropic` are shown.
- Rewriting `system`, `tools`, or earlier `messages` triggers the preserved-thinking rejection. Strip prior thinking blocks only when the model family changes, and prefer switching at user-turn boundaries.

### 8.2 Codex

- Responses API only. `/v1/models` is read at startup.
- `reasoning.effort` accepts `low`, `medium`, `high`, `xhigh`, `max`, `ultra` depending on model.
- Community-reported headers `session_id`, `conversation_id`, `originator: codex_cli_rs`, and body `prompt_cache_key`. To verify against a live capture.

## 9. Privacy

- The judge sees a bounded dossier only: last user ask, a short assistant-intent tail, tool names, tool-result counts, up to three short excerpts prioritizing errors, image flag. Hard cap well under the 32k judge context.
- Never the full conversation, file contents, or system prompt.
- Redaction hook before the dossier leaves the process.
- Decision log stores digests, not content, unless the user opts in.

## 10. Measurement

Decision log, one JSONL line per decision:

```json
{ "id": "...", "ts": 0, "session": "sha256:...", "harness": "claude-code", "turn": 12,
  "requestClass": "main", "signals": { "score": -0.62, "severity": 0.1, "spinning": 0, "exploring": 0.3, "production": 0.8 },
  "judge": { "transport": "openrouter", "latencyMs": 140, "answers": { "...": {} }, "costUsd": 0.00002 },
  "decision": { "candidate": "fast", "model": "...", "effort": "medium", "source": "signals", "lease": "tool_chain" },
  "usage": { "in": 0, "out": 0, "cacheRead": 0, "cacheWrite": 0, "costUsd": 0 },
  "counterfactuals": { "fast": 0.0, "mid": 0.0, "frontier": 0.0 } }
```

- `stats`: savings against every baseline, including the ones that make the router look bad.
- `replay`: re-run a policy over recorded judge answers offline. Free policy iteration.
- `shadow`: pin a model, log what the router would have done.
- `bench`: labeled fixtures to accuracy, calibration, and threshold-coverage tables.
- Agentic eval: Harbor with Terminal-Bench, adapters for Claude Code, Codex, OpenCode, Pi, pointed at the relay, versus single-model baselines. Same methodology as Switchyard's benchmark. Runbook: `docs/evaluation.md`.

## 11. Package layout

Single npm package `jev-router`, ESM, subpath exports. Built and tested with Bun; runtime target Node 22+, Bun, edge.

```
src/
  core/        decision engine, policy schema, signals, session state
  judge/       interface + transports (typesafe, vercel, openrouter, mock)
  daemon/      relay, /decide, /observe, models endpoints, log, stats, replay
  adapters/
    pi/        extension entry
    claude-code/ hooks.json, skill, scripts
    codex/     hooks, skill
    opencode/  plugin
  cli/         setup, up, stats, replay, bench
```

Exports: `jev-router/core`, `jev-router/judge`, `jev-router/daemon`, `jev-router/adapters/pi`, `jev-router/adapters/opencode`, `jev-router/cli`.

## 12. Build order

Progress as of 2026-09-27: steps 1 to 6 below exist and are tested (core, Pi extension, relay daemon with the three dialects, Claude Code and Codex hook packs with the installer, OpenCode plugin, stats/replay/shadow). Step 7 onward is open.

Deviations from the plan worth knowing:

- OpenCode: reasoning effort is not set in-process after all. OpenCode reaches the relay through a provider, and the relay already rewrites `reasoning_effort` for the chat dialect, so the plugin only injects the session header and reports signals.
- Compaction is a built-in override and is no longer an identifier rules can reference; rule identifiers are validated against a known set at load time.
- The relay serves unknown model ids as untouched passthrough to the default egress.

1. Core: types, policy loader and validator, deterministic signals, decision function, fixtures. Mock judge.
2. Pi extension: in-process reference. Judge via OpenRouter Decisions. Proves the whole loop with no daemon.
3. Daemon: relay for Anthropic Messages first (strictest), then OpenAI chat, then Responses. `/decide`, `/observe`, models endpoints. Decision log.
4. Claude Code and Codex plugins (hook packs, status skills) and the installer.
5. OpenCode plugin: effort in-process, sensors, relay provider entry.
6. `stats`, `replay`, `shadow`, `bench`.
7. Harbor evaluation.
8. AI SDK middleware. Hermes adapter. Direct-provider egress with translation. Expected-value switching with cache affinity.

## 13. Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | TypeScript, Bun for dev, Node 22+ at runtime | AI SDK ecosystem, edge-capable, Bun compiles the daemon to a binary for the installer |
| Surface | Library first, thin relay, native plugins | Core is testable; relay only where harnesses cannot switch in-process |
| Judge role | Atomic signals by default, option-pick per route | Deterministic and replayable; eve-style available for those who want it |
| Agentic in v1 | Yes | This is the differentiator against every existing jev router |
| Certified harnesses | Claude Code, Codex, Pi, OpenCode | Covers all three wire formats and both actuator styles |
| Egress | Gateways only in v1 | OpenRouter and Vercel serve all dialects for any model, so no translation is needed |
| Shape | Hybrid: one core, in-process where possible, relay elsewhere | Hooks in Claude Code and Codex cannot change the model |
| Reference adapter | Pi extension | Fully in-process, richest API, smallest surface |
| OpenCode v1 | Effort in-process, model via relay | `chat.params` allows options, no hook changes the model |
| Name | jev-router | User preference; collisions accepted |
| License | MIT | Ecosystem norm |
| Layout | Single package, subpath exports | Simplest start; revisit if adapters need conflicting peers |
| Relay auth | Loopback needs no token; any other bind requires a bearer token on every endpoint but health | The relay injects real provider keys, so an open bind would be an open proxy |
| Token counting | Passthrough with the session's current model, never routed, logged, or counted as a turn | Keeps the count on the tokenizer in use and keeps hold and lease bookkeeping honest |
| Hook signals | Consumed only when a decision takes effect | A failed request should not eat the evidence that made it fail |
| Cancellation | Client disconnect aborts the upstream call under Node; not detectable under Bun's node:http today | Verified by probing both runtimes; the Node path is covered by a smoke script in the check |
| Same-session concurrency | Last writer wins in the in-memory store | Rare in practice (retries, duplicate sends); documented rather than serialized, since a stream can take minutes |
| Plan-backed inference | The harness's own login is forwarded unchanged; `init` reads only the plan type; tiers come from the plan's models | A Claude Max or ChatGPT user already pays for the models; routing among them stretches the allowance without a second bill. The relay never holds a token, which also keeps it out of the harness's auth flow. Only the harness that owns the login uses it (Claude Code to Anthropic, Codex to OpenAI), never another harness or the judge. |
| Install as one command | `setup` asks for the judge key once, stores it in a 600 file, detects logins and installed harnesses, configures them, and installs a launchd or systemd user service | Nothing to remember, no terminal to keep open, and every step is individually available (`init`, `up`, `service`) for people who want to see it. `--dry-run` shows every file first. |
| Default rule thresholds | Escalate on evidence: `difficulty >= 2.5 and needs_reasoning > 0.8`, `spinning > 0.7 or (tools_failed > 0.7 and spinning > 0.5)` | First Terminal-Bench run (12 easy/medium tasks, Pi): the 0.1.0 thresholds escalated a quarter of the tasks on first-turn guesses or a single failed call, gained nothing in success, and cost 180x more per solved task. Replay predicted and a live re-run confirmed the tuned rules match the fast tier. In-sample; hard tasks still to run. See docs/evaluation.md. |

## 14. Open questions and risks

- Codex request headers for session identity are community-reported; capture a live session to confirm.
- OpenCode virtual provider via `auth.loader` custom `fetch` is feasible in source but requires a stored auth entry; deferred.
- Judge is a proprietary API. The interface stays generic; a local judge is a v2 target.
- Routing quality on hard tasks is unmeasured. The first Harbor run covered easy and medium tasks only, where "always cheap" is the ceiling; the 0.1.0 rules lost to it, as zDud4s's classifier did, and the tuned rules tie it. The upside case needs tasks the fast tier fails.
- Claude Code hint headers require `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`; the installer sets it.
- Vercel and OpenRouter surfaces evolve; the relay must not allowlist headers or fields.

## 15. References

- Switchyard: https://github.com/NVIDIA-NeMo/Switchyard (stage router, llm classifier, TOML schema, benchmark)
- TypeSafe jev: https://typesafe.ai/blog/introducing-system-one-models-and-jev · https://docs.typesafe.ai/
- OpenRouter Decisions: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
- Vercel TypeSafe API and evaluation fallbacks: https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe · https://vercel.com/docs/ai-gateway/models-and-providers/evaluation-fallbacks
- Claude Code gateway compatibility: https://code.claude.com/docs/en/llm-gateway-protocol · hooks: https://code.claude.com/docs/en/hooks · plugins: https://code.claude.com/docs/en/plugins/components
- Codex config reference: https://learn.chatgpt.com/docs/config-file/config-reference · hooks: https://learn.chatgpt.com/docs/hooks
- Pi extensions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts
- OpenCode plugins: https://github.com/sst/opencode/blob/dev/packages/plugin/src/index.ts
- Prior art: prismhq/jev-router, lucianfialho/jev-model-router, whitesheep/typesafe-llm-router, iamvatsalpatel/tiershift, 1arley/jev-codex-router, zDud4s/jev-model-router, FlorianRiquelme/jev-kit, Hermes jev-effort-router, eve `auto()`
