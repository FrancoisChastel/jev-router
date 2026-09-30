# Policy reference

The policy is a JSON file at `~/.jev-router/policy.json` (`JEV_ROUTER_POLICY` overrides the path; YAML works under Bun or with the `yaml` package). `jev-router init` generates one; `jev-router policy` validates one. Loading is strict: unknown candidates, unknown rule identifiers, out-of-range knobs, and malformed shapes fail with a message that names the field.

## Shape

```jsonc
{
  "version": 1,
  "judge": { "transport": "openrouter", "model": "typesafe/jev-1.13", "api_key_env": "OPENROUTER_API_KEY", "timeout_ms": 1500, "on_error": "fail_open", "mode": "signals" },
  "egress": { "openrouter": { "base_url": "https://openrouter.ai/api", "api_key_env": "OPENROUTER_API_KEY" } },
  "candidates": {
    "fast": { "via": "openrouter", "model": "openai/gpt-6-luna", "price": { "in": 0.1, "out": 0.5 }, "effort": ["low", "medium", "high"], "capabilities": { "vision": true, "tools": true, "context": 1050000 } }
  },
  "routes": [{ "id": "auto", "harness": "any", "policy": "default" }],
  "policies": { "default": { "default": "fast", "rules": [] } }
}
```

## judge

| Field | Values | Notes |
|---|---|---|
| `transport` | `openrouter`, `vercel`, `typesafe`, `mock` | `mock` means no judge: deterministic routing only |
| `model` | transport-specific id | Defaults: `typesafe/jev-1.13`, `typesafe-ai/jev`, `jev-latest` |
| `api_key_env` | env var name | Defaults per transport: `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY` |
| `timeout_ms` | integer | Per attempt; one retry on 429, 529, or 5xx |
| `on_error` | `fail_open`, `fail_closed` | Open keeps the current tier when the judge is unavailable; closed sends the turn to the most capable candidate |
| `mode` | `signals`, `option_pick` | Signals: jev answers atomic questions and rules pick the model. Option pick: one choice over candidate ids with their descriptions |

## egress

Named upstreams the relay forwards to. Both OpenRouter and Vercel serve the Anthropic, OpenAI chat, and Responses dialects for any model, so the relay never translates formats.

| Field | Notes |
|---|---|
| `base_url` | Upstream root; the request path is appended |
| `api_key_env` | Environment variable holding the key the relay injects |
| `forward_auth` | Forward the caller's own `Authorization` / `x-api-key` instead of injecting a key. How Claude Code's and Codex's logins reach their providers |
| `mount` | Relay path prefix served by this egress, for example `/backend-api/codex`. An inference sub-path (`/responses`, `/chat/completions`, `/messages`) is routed; anything else under it is proxied unchanged, credentials aside. A proxied Codex catalog gains an `auto` entry |
| `billing` | `usd` (default) or `subscription`. The latter marks prices as API list-price equivalents, the scale a plan's allowance is consumed on; `stats` says so |
| `pi_provider` | Pi provider name when it differs from the egress name |
| `no_auth` | Send no credentials at all, and strip the caller's. For a local server such as Ollama |
| `dialects` | Wire formats the upstream accepts, among `anthropic`, `openai-chat`, `openai-responses`. Default: all. Candidates behind this egress are filtered out for requests in any other format, the way capabilities filter them |

`init` writes `anthropic-subscription` (`https://api.anthropic.com`, forward_auth) when Claude Code is logged in, `chatgpt-subscription` (`https://chatgpt.com/backend-api/codex`, mounted, forward_auth) when Codex is, and `ollama` (`http://127.0.0.1:11434`, no_auth, `dialects: ["openai-chat"]`) when a local Ollama server answers.

### Plan windows

A `subscription` egress reports how full the plan's usage windows are on every response, and the relay keeps the latest values in memory (never on disk). Observed live:

| Upstream | Headers | Format |
|---|---|---|
| Anthropic (Claude Code login) | `anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-7d-utilization`, `anthropic-ratelimit-unified-5h-reset` | Fraction `0.65`; reset in Unix seconds |
| ChatGPT Codex backend | `x-codex-primary-used-percent`, `x-codex-secondary-used-percent`, `x-codex-{primary,secondary}-window-minutes` (300, 10080), `x-codex-primary-reset-at` | Percent `43`; reset in Unix seconds |

Both are normalized to 0..1 and exposed to rules as `plan_5h` and `plan_7d` for the egress the session bills (its current candidate's, else the policy default's). Until a response has reported them they are absent, so rules that read them never fire; the five-hour value is withdrawn again once its reset time passes. `GET /status` on the relay shows the latest window per egress. `JEV_ROUTER_DEBUG_HEADERS=1` prints every rate-limit or usage-like response header name and value to stderr (credentials never match).

## candidates

| Field | Notes |
|---|---|
| `model` | The `creator/model` slug the egress understands |
| `via` | Egress name. Defaults to the first egress |
| `price.in`, `price.out` | USD per million tokens. Used for counterfactuals and `stats`; `init` refreshes them from the live catalog |
| `effort` | Levels the model accepts among `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Decisions are clamped to this list before anything is written upstream |
| `default_effort` | Applied when no rule and no request sets one |
| `capabilities.vision`, `.tools`, `.context` | Candidates that cannot serve a request are filtered out before routing |
| `description` | Used only in `option_pick` mode |
| `pi.provider`, `pi.model` | Overrides for how the Pi extension looks the model up |

## routes

Client-visible model ids. `auto` is the generic route, and any `<prefix>/auto` maps onto it. `harness` restricts a route to one harness or `any`. A route id of `*` catches everything else; without it, unknown model ids pass straight through to the default egress with nothing rewritten.

## policies

| Field | Default | Meaning |
|---|---|---|
| `default` | required | Candidate used when nothing else applies; must be in `order` |
| `order` | by `price.in` | The candidates this policy may use, cheapest first; the ladder for `up`, `at_least`, and escalation. A subset keeps, say, plan-backed Claude models out of the gateway policy; rule targets must be in it |
| `min_confidence` | 0.6 | Below this, on any choice or score answer a rule depends on, the current tier is kept |
| `hold_turns` | 2 | Turns a forced escalation is held |
| `confidence_threshold` | 0.5 | Ambiguous band for the deterministic tool-signal score. Must be at least 0.462, the value one axis alone can reach |
| `recent_turn_window` | 3 | Tool-outcome batches considered by the scorer |
| `est_output_tokens` | 600 | Used for counterfactual cost estimates at decision time |
| `switch.cache_penalty` | false | Weigh the prompt cache a model switch drops against what the switch saves; see [switch](#switch) |
| `switch.prefer_effort_over_model` | false | Raise effort on the current model before escalating to the next one; see [switch](#switch) |
| `tool_semantics` | built-in per harness | Extra tool names per class: `observe`, `mutate`, `plan`, `new`, `shell` |

### Rules

Rules are evaluated in order. Expressions use a tiny language: identifiers, numbers, strings, `>=` `<=` `>` `<` `==` `!=`, `in [a, b]`, `and`, `or`, `not`, parentheses. Nothing executes. A missing identifier makes its sub-expression unknown, and unknown never fires a rule, even under `not`.

Identifiers the engine always provides: `harness`, `request_class`, `has_images`, `is_new_user_turn`, `est_tokens`, `consecutive_failures`, `requested_effort`, and the deterministic tool signals `signal.score`, `signal.severity`, `signal.spinning`, `signal.exploring`, `signal.production`. On plan-billed egresses, once observed: `plan_5h` and `plan_7d`, the five-hour and seven-day window utilization from 0 to 1 (see [Plan windows](#plan-windows)).

Judge answers by question id. Task phase, asked on each new user turn: `difficulty` (score 0 to 3), `needs_reasoning` (probability), `stakes` (score 0 to 3), `output_kind` (choice: `short_answer`, `code_edit`, `long_generation`, `plan`, `tool_plan`), `long_context` (probability). Execution phase, asked when the tool signals are ambiguous: `tools_failed`, `spinning`, `producing` (probabilities). Choice and score answers also expose `<id>.confidence`.

Actions:

| Action | Effect |
|---|---|
| `pin` | Final candidate; later rules are skipped |
| `at_least` | Raise the target to at least this tier |
| `at_most` | Cap: never serve above this tier this turn. Applied after every other action and on every path, overrides, holds, and leases included; the lowest matching cap wins. A cap on a tier the request cannot use falls to the nearest usable tier below it |
| `up` | Raise the target this many tiers above the current one |
| `allow_down` | Permit moving below the current tier on a tool continuation |
| `effort` | Set the effort, clamped to the candidate's list |
| `hold_turns` | Hold the resulting tier this many turns |

The default rules:

```json
[
  { "when": "request_class in [auxiliary, compaction]", "then": { "pin": "fast" } },
  { "when": "difficulty >= 2.5 and needs_reasoning > 0.8", "then": { "at_least": "mid" } },
  { "when": "stakes >= 2.5", "then": { "at_least": "mid" } },
  { "when": "stakes >= 2 and difficulty >= 3", "then": { "at_least": "frontier", "effort": "high" } },
  { "when": "spinning > 0.7 or (tools_failed > 0.7 and spinning > 0.5)", "then": { "up": 1 } },
  { "when": "producing > 0.8 and tools_failed < 0.2", "then": { "allow_down": true } }
]
```

These thresholds were calibrated on a Terminal-Bench subset (see [evaluation.md](./evaluation.md#results)): a single failed tool call or a moderately hard-looking task is not enough to leave the fast tier; repeated failure, spinning, or a hard task that also needs careful reasoning is.

Compaction is handled by a built-in override and is not a rule identifier.

Policies `init` generates for a Claude Code or Codex login end with two caps, so the router shifts down as the five-hour window fills and the user does not hit the wall mid-task:

```json
[
  { "when": "plan_5h >= 0.8", "then": { "at_most": "claude-sonnet" } },
  { "when": "plan_5h >= 0.95", "then": { "at_most": "claude-haiku" } }
]
```

(`codex-mid` and `codex-fast` for Codex; with only two Codex tiers, just the second rule.)

### A free local tier

When Ollama is running, `init` adds a `local` candidate (the first installed of `qwen3-coder`, `qwen2.5-coder`, `deepseek-coder`, `devstral`, `codestral`, `codellama`, else the first tag; price 0) at the bottom of the `default` policy's `order`, and a first rule `request_class in [auxiliary, compaction]` → `pin: local`. The `ollama` egress speaks OpenAI chat only, so Anthropic-format and Responses requests skip `local` and the pin lands on `fast`. To make it the default tier for chat-format harnesses, set `"default": "local"` in `policies.default`; rules still escalate to the gateway tiers when a turn earns it.

### switch

Two switches decide how a policy moves between models. Both are off in a hand-written policy that leaves them out, and both are on in every policy `init` and `setup` generate (`default`, `claude-code`, `codex`).

**`prefer_effort_over_model`: effort first, model second.** When a decision would move up the ladder because of an `up` action or a decisive tool-signal escalation, the router first raises the reasoning effort on the current candidate by one level and keeps it, with the reason `effort_first`. The level in use is the session's current effort, else the request's effort, else the candidate's `default_effort`, else the middle of its `effort` list. Only when effort is already at the candidate's top level (or it has no `effort` list) does the model switch. A `pin`, an `at_least` (the stakes rules), a `default` above the current tier, and the hard overrides (compaction, repeated failures, critical errors) always switch model. Downward moves are unaffected. Effort is cheaper than a new model and keeps the prompt cache.

**`cache_penalty`: cache-aware switching.** Prompt caches are per model, so a switch re-sends the cached prefix at full price. The daemon keeps the usage the upstream reported for the session's previous response; when it includes cache reads and the decision would move to another model, the router estimates:

- `penaltyUsd`, paid once: the cached prefix re-sent at the new model's full input price, minus the discounted read staying would have paid, never below zero: `cacheRead × (to.in − 0.1 × from.in) / 1M`. The 0.1 is the usual 90% cache-read discount.
- `savingUsd`, over the horizon: after the first turn the prefix is read at cached rates on either model, so only the new input tokens and the output pay full price: `((from.in − to.in) × (0.1 × cacheRead + max(0, estInput − cacheRead)) + (from.out − to.out) × est_output_tokens) / 1M`, times `recent_turn_window` turns. `estInput` is the request's estimated input tokens.

Worked example, Opus to Sonnet at the plan-backed default prices (Opus $4 in / $20 out, Sonnet $2 / $10 per million), a 40k-token cached prefix, 2k new input tokens (42k in total), `est_output_tokens` 600:

| | Formula | USD |
|---|---|---|
| Penalty | 40,000 × (2 − 0.1 × 4) / 1M | 0.064 |
| Saving per turn | ((4 − 2) × (0.1 × 40,000 + 2,000) + (20 − 10) × 600) / 1M | 0.018 |
| Saving, `recent_turn_window` 3 | 3 × 0.018 | 0.054: below the penalty, the downgrade is blocked |
| Saving, `recent_turn_window` 4 | 4 × 0.018 | 0.072: above the penalty, the session moves to Sonnet |

With a 20k cached prefix and the same 2k new tokens, the penalty falls to 0.032 and the three-turn saving is 3 × ((2 × (2,000 + 2,000) + 6,000) / 1M) = 0.042, so the downgrade goes through.

When the rules move a judged turn down to a cheaper model and the saving is below the penalty, the current model is kept, with the reason `cache_penalty_blocked`. Upgrades are never blocked: quality comes first. A `pin` (such as auxiliary requests to the fast tier) is not weighed. Every decision that switches model with known cache reads, and every blocked one, carries both numbers as `decision.cache: { penaltyUsd, savingUsd }` in the log, so the reason can be checked. Without reported usage (first turn, a harness whose responses carry none, or the in-process Pi adapter) nothing changes. `replay` feeds the recorded usage back, so it sees what the live router saw.
