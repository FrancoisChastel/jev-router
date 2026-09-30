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

`init` writes `anthropic-subscription` (`https://api.anthropic.com`, forward_auth) when Claude Code is logged in and `chatgpt-subscription` (`https://chatgpt.com/backend-api/codex`, mounted, forward_auth) when Codex is.

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
| `switch.cache_penalty` | false | Reserved for expected-value switching |
| `switch.prefer_effort_over_model` | false | Turn a one-tier escalation into a higher effort on the current model when it has headroom |
| `tool_semantics` | built-in per harness | Extra tool names per class: `observe`, `mutate`, `plan`, `new`, `shell` |
| `cascade` | off | Retry a failed-looking response one tier up within the same turn; see [Cascade](#cascade) |

### Cascade

A cascade re-runs a routed request on the next tier of `order` when the first answer looks like a failed attempt, before the client sees anything. The cheap tier serves most turns; the expensive one is paid only when the cheap one visibly fails.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turn the cascade on for this policy |
| `on` | `["upstream_error", "empty"]` | What counts as a failed attempt, checked in the order listed. `upstream_error`: HTTP 429, 5xx, 529 "overloaded", an unreachable upstream, or an error event in the stream. `empty`: no assistant text and no tool call (thinking alone is empty). `refusal`: a reply of at most 400 characters, with no tool call, containing "I can't", "I cannot", "I'm unable", "I won't", or "as an AI", or a refusal the provider flagged (OpenAI `refusal`, Anthropic `stop_reason: refusal`). `truncated`: stop reason `max_tokens`, `length`, or an incomplete Responses status |
| `max_retries` | 1 | How many further tiers to try. The ladder is `order`, after the capability filter; effort is clamped to each tier as for any decision |
| `buffer` | `true` | Hold the first attempt's response back until it is complete and assessed. With `false`, answers stream through unassessed and only `upstream_error` can trigger (an `on` list with anything else is rejected); `on` then defaults to `["upstream_error"]` |
| `buffer_max_bytes` | 262144 | Stop buffering past this many bytes: the bytes so far are sent as received, the rest streams through, and the cascade is abandoned for that request (logged to stderr and in the record) |
| `buffer_max_ms` | 20000 | Same, measured from the moment the response headers arrive |
| `budget_usd` | none | Do not start a retry whose estimate (estimated input tokens times the next tier's `price.in`, plus `est_output_tokens` times its `price.out`) would take the request's spend so far above this |

Only routed requests cascade: never passthrough ids, `count_tokens`, shadow mode, or a request already on the most capable eligible tier. The last permitted attempt streams straight through. If it also fails, the client gets that response; if it cannot be reached at all, the client gets the response held from the attempt before it. Nothing is merged: the client receives exactly one upstream response, with only the model id echoed as usual.

```json
"policies": {
  "default": {
    "default": "fast",
    "order": ["fast", "mid", "frontier"],
    "rules": [],
    "cascade": {
      "enabled": true,
      "on": ["upstream_error", "empty", "refusal"],
      "max_retries": 1,
      "buffer": true,
      "buffer_max_bytes": 262144,
      "buffer_max_ms": 15000,
      "budget_usd": 0.5
    }
  }
}
```

**Latency.** Buffering means the client sees nothing until the first attempt has finished: a streamed answer arrives all at once instead of token by token, and pings are held back with it. For a short tool call from a fast tier that is a fraction of a second; for a long answer it is the whole generation time, and a retry adds the next tier's time on top. `buffer_max_ms` bounds the wait before the router gives up and streams, which keeps Claude Code and Codex from timing out on a silent connection, and `buffer_max_bytes` lets a long answer through as soon as it is clearly not empty. If time to first token matters more than catching empty or refusing answers, set `buffer: false` and keep the cascade for upstream errors only, which cost no latency because an error arrives before any byte is streamed.

A cascaded request's log record keeps the router's original `decision` and adds `cascade: { attempts, served, abandoned? }`, one entry per upstream call with its outcome, usage, and list-price cost. The record's `usage` is the sum over attempts. The response carries `x-jev-router-cascade`, for example `fast->mid (empty)`, and `x-jev-router-candidate` names the tier that served. The session continues on the tier that served. `stats` charges every attempt in the actual cost, prices the single-candidate baselines on the served answer's tokens alone, and reports what the discarded attempts cost.

### Rules

Rules are evaluated in order. Expressions use a tiny language: identifiers, numbers, strings, `>=` `<=` `>` `<` `==` `!=`, `in [a, b]`, `and`, `or`, `not`, parentheses. Nothing executes. A missing identifier makes its sub-expression unknown, and unknown never fires a rule, even under `not`.

Identifiers the engine always provides: `harness`, `request_class`, `has_images`, `is_new_user_turn`, `est_tokens`, `consecutive_failures`, `requested_effort`, and the deterministic tool signals `signal.score`, `signal.severity`, `signal.spinning`, `signal.exploring`, `signal.production`.

Judge answers by question id. Task phase, asked on each new user turn: `difficulty` (score 0 to 3), `needs_reasoning` (probability), `stakes` (score 0 to 3), `output_kind` (choice: `short_answer`, `code_edit`, `long_generation`, `plan`, `tool_plan`), `long_context` (probability). Execution phase, asked when the tool signals are ambiguous: `tools_failed`, `spinning`, `producing` (probabilities). Choice and score answers also expose `<id>.confidence`.

Actions:

| Action | Effect |
|---|---|
| `pin` | Final candidate; later rules are skipped |
| `at_least` | Raise the target to at least this tier |
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
