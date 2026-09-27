# Harness setup

`jev-router setup` does all of this for you, with `--dry-run` to preview and `.bak` backups of every file it changes. This page is the manual version and the explanation of what each harness can and cannot do.

The relay listens on `http://127.0.0.1:4141` by default. Start it with `jev-router up`.

## Claude Code

Claude Code hooks cannot change the model, so routing happens in the relay and the hooks act as sensors.

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4141
export ANTHROPIC_AUTH_TOKEN=jev-router          # the relay ignores the value unless it runs with --token
export ANTHROPIC_API_KEY=""
export ANTHROPIC_MODEL=claude-code/auto
export CLAUDE_CODE_GATEWAY_HINT_HEADERS=1       # request class, compaction, and tool durations reach the relay
```

Install the plugin for the sensors and a status command:

```bash
claude plugin marketplace add FrancoisChastel/jev-router
claude plugin install jev-router@jev-router
```

The hooks post to `http://127.0.0.1:4141/hooks/claude-code` with a two-second timeout. A stopped relay costs at most that per event and never blocks a tool. `/jev-router:status` shows recent decisions.

Route ids shown in Claude Code's `/model` picker must contain `claude`, which is why the default policy has `claude-code/auto`. OpenRouter's Anthropic-compatible surface has no token-counting endpoint; Claude Code falls back to its own estimate.

## Codex

Codex speaks the Responses API only. The relay serves it and forwards to a gateway that does too.

```toml
# ~/.codex/config.toml
model = "auto"
model_provider = "jev-router"

[model_providers.jev-router]
name = "jev-router"
base_url = "http://127.0.0.1:4141/v1"
wire_api = "responses"
env_key = "JEV_ROUTER_TOKEN"
```

`export JEV_ROUTER_TOKEN=anything` before starting Codex, or the relay token when the relay runs with `--token`. Codex hooks are command-only, so `~/.codex/hooks.json` runs `jev-router hook codex`, which forwards each event to the relay and always exits 0. Copy `plugins/codex/hooks.json` or let `setup` write it.

## OpenCode

```json
{
  "provider": {
    "jev-router": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "jev-router",
      "options": { "baseURL": "http://127.0.0.1:4141/v1", "apiKey": "jev-router" },
      "models": { "auto": { "name": "jev-router auto", "limit": { "context": 200000, "output": 65536 } } }
    }
  },
  "model": "jev-router/auto"
}
```

`setup` also drops a plugin into `~/.config/opencode/plugins/jev-router.js` that tags requests with the session id and reports tool results, compaction, and API errors. The relay applies reasoning effort for the chat dialect, so the plugin does not need to.

## Pi

Pi exposes its model and thinking level to extensions, so the router runs inside Pi with no relay.

```bash
export OPENROUTER_API_KEY=sk-or-...   # or AI_GATEWAY_API_KEY, or TYPESAFE_API_KEY; Pi needs no egress
jev-router init
pi install npm:@french-castle/jev-router
```

Candidates are looked up in Pi's own registry by provider and id. `via: openrouter` maps to Pi's `openrouter` provider and `via: vercel` to `vercel-ai-gateway`; set `pi.provider` or `pi.model` on a candidate to override. `/jev-router status`, `/jev-router off`, and `/jev-router on` control it, and a manual `/model` pick pauses routing until `/jev-router on`.

## Anything OpenAI-compatible

Point the tool at `http://127.0.0.1:4141/v1` with model `auto`. Without harness hooks the router still has the tool results carried in the request body and the judge; it lacks only compaction notices and explicit error flags.

## Reaching the relay from containers or other machines

Bind wider than loopback only with a token:

```bash
export JEV_ROUTER_TOKEN=$(openssl rand -hex 16)
jev-router up --host 0.0.0.0 --token "$JEV_ROUTER_TOKEN"
jev-router setup --token "$JEV_ROUTER_TOKEN"     # writes it as each harness's credential
```

Every request must then carry it as a bearer token or `x-api-key`, because the relay injects your real provider key upstream.
