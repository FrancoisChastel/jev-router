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

Named upstreams the relay forwards to. Each has `base_url`, `api_key_env`, optional `forward_auth` (pass the caller's credentials instead of the configured key), and optional `pi_provider` (Pi provider name when it differs from the egress name). Both OpenRouter and Vercel serve the Anthropic, OpenAI chat, and Responses dialects for any model, so the relay never translates formats.

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
| `default` | required | Candidate used when nothing else applies |
| `order` | by `price.in` | Tier order for `up`, `at_least`, and escalation |
| `min_confidence` | 0.6 | Below this, on any choice or score answer a rule depends on, the current tier is kept |
| `hold_turns` | 2 | Turns a forced escalation is held |
| `confidence_threshold` | 0.5 | Ambiguous band for the deterministic tool-signal score. Must be at least 0.462, the value one axis alone can reach |
| `recent_turn_window` | 3 | Tool-outcome batches considered by the scorer |
| `est_output_tokens` | 600 | Used for counterfactual cost estimates at decision time |
| `switch.cache_penalty` | false | Reserved for expected-value switching |
| `switch.prefer_effort_over_model` | false | Turn a one-tier escalation into a higher effort on the current model when it has headroom |
| `tool_semantics` | built-in per harness | Extra tool names per class: `observe`, `mutate`, `plan`, `new`, `shell` |

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
  { "when": "difficulty >= 2 or needs_reasoning > 0.8", "then": { "at_least": "mid" } },
  { "when": "stakes >= 2.5", "then": { "at_least": "mid" } },
  { "when": "stakes >= 2 and difficulty >= 3", "then": { "at_least": "frontier", "effort": "high" } },
  { "when": "tools_failed > 0.7 or spinning > 0.7", "then": { "up": 1 } },
  { "when": "producing > 0.8 and tools_failed < 0.2", "then": { "allow_down": true } }
]
```

Compaction is handled by a built-in override and is not a rule identifier.
