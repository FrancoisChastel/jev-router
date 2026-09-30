# Harness setup

`jev-router setup` does all of this for you, with `--dry-run` to preview and `.bak` backups of every file it changes. This page is the manual version and the explanation of what each harness can and cannot do.

The relay listens on `http://127.0.0.1:4141` by default. `jev-router setup` configures everything below for the harnesses it finds installed and installs the relay as a background service; the sections that follow describe what it writes, for anyone who prefers to do it by hand or to check the result.

## One command

```bash
jev-router setup                 # asks for the judge key, detects logins, keys, and harnesses, configures, installs the service
jev-router setup --dry-run       # prints every file it would write, writes nothing, installs nothing
jev-router setup --agent codex   # one harness only
jev-router setup --agent cursor  # prints the Cursor steps; Cursor's settings live in the app
jev-router service status        # is the background relay up
jev-router service uninstall     # stop and remove it
```

The judge key is asked for once and stored in `~/.jev-router/env` with mode 600, because a background service has no shell to inherit it from. Every command reads that file and fills in only what the environment lacks. `--judge-key <key>` sets it without a prompt, `--no-prompt` skips the question, and `--no-service` leaves the relay for you to start with `jev-router up`.

With a Claude Code or Codex login on the machine, `init` builds the tiers from the models that plan includes and routes that harness through its own login (see below). A gateway key still serves the judge and any harness without a login.

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

Route ids shown in Claude Code's `/model` picker must contain `claude`, which is why the default policy has `claude-code/auto`. `setup` also adds a `modelPicker` row so the picker shows `auto (jev-router)`, with `behavesAs` set to the tier the route starts on, which gives Claude Code the right client-side defaults for an id it does not know. OpenRouter's Anthropic-compatible surface has no token-counting endpoint; Claude Code falls back to its own estimate.

### With a claude.ai login (Pro, Max)

When Claude Code is logged in with a claude.ai account, `init` adds an `anthropic-subscription` egress with `forward_auth` and routes `claude-code/auto` to a policy over `claude-haiku-4-5`, `claude-sonnet-5`, and `claude-opus-5-5`, starting on Sonnet. Claude Code keeps sending its own OAuth bearer; the relay forwards it unchanged to `api.anthropic.com` and rewrites only the model. `setup` then writes no `ANTHROPIC_AUTH_TOKEN` (one would replace the login) and removes a stale one it wrote earlier:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:4141", "ANTHROPIC_MODEL": "claude-code/auto", "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1" } }
```

The relay never sees a token at rest and the log records tokens and API-equivalent cost, never credentials. This needs the relay on loopback: a `--token` bind would reject Claude Code's own bearer.

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

### With a ChatGPT login

When Codex is logged in with ChatGPT, `init` adds a `chatgpt-subscription` egress mounted at `/backend-api/codex` and a `codex` policy whose tiers are the models your plan lists (from Codex's own catalog cache, ordered by API list price, for example `gpt-6-luna < gpt-6-sol < gpt-6-astra`). Codex refuses a model outside that catalog, so the relay proxies the catalog request and adds an `auto` entry to it. The provider block becomes:

```toml
[model_providers.jev-router]
name = "jev-router"
base_url = "http://127.0.0.1:4141/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
```

`requires_openai_auth` makes Codex attach its ChatGPT login to requests to this provider, exactly as it does for `chatgpt.com/backend-api/codex`; the relay forwards them there with the model rewritten. No `JEV_ROUTER_TOKEN` is involved.

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

## Cursor

Cursor is the one harness `setup` cannot configure: `jev-router setup --agent cursor` (or a detected `~/.cursor`, `cursor`, or `cursor-agent`) prints the steps below and writes nothing. Two facts shape everything here, both from Cursor's documentation and the gateways that support it as of September 2026:

- **Requests come from Cursor's servers, not your machine.** Cursor's API-key docs say every request is routed through Cursor's backend for prompt building, and that backend is what calls the "Override OpenAI Base URL". `http://127.0.0.1:4141` is unreachable from there; the relay needs a public HTTPS URL.
- **The settings live inside the app.** There is no config file for the base URL, key, or custom models that we could back up and edit safely.

### Steps

```bash
export JEV_ROUTER_TOKEN=$(openssl rand -hex 24)
jev-router up --port 4142 --token "$JEV_ROUTER_TOKEN"   # a second relay, token required on every call
jev-router expose --port 4142                           # another terminal, same JEV_ROUTER_TOKEN; needs cloudflared or ngrok
```

`expose` checks that the relay answers, rejects a request without the token, and accepts one with it; anything else and it refuses to start. It then runs `cloudflared tunnel --url http://127.0.0.1:4142` (or `ngrok http 4142` when cloudflared is missing; `--tunnel ngrok` picks it), reads the public URL from the tunnel's output, and prints what to paste into **Cursor Settings > Models**:

| Field | Value |
|---|---|
| OpenAI API Key | the relay token |
| Override OpenAI Base URL | `<public URL>/v1`, override switched on |
| Custom model | `jev-router/auto` |

The model is `jev-router/auto` rather than `auto`: Cursor rejects a custom model whose name matches one of its built-in models, and it has its own Auto, so a prefixed name avoids the clash. Any `<prefix>/auto` id routes like `auto`, so the policy needs no change. The relay recognizes Cursor's calls by their `User-Agent: Cursor/1.0`, uses Cursor's tool names for the tool signals, and keys sessions by the conversation prefix, since Cursor sends no session header. `expose` runs until Ctrl-C, and it re-checks the relay every five seconds and stops the tunnel if the relay starts answering without the token.

The second relay is there because the background service runs without a token. Plan-backed routing depends on that: a token relay would reject Claude Code's and Codex's own logins. Keep the service for local harnesses and use the token relay only for Cursor.

### What works and what does not

- **Routed:** Chat and Agent requests on `jev-router/auto`, streaming included. With OpenRouter as the egress, Cursor's requests go to OpenRouter's Cursor endpoint (`/api/v1/cursor/chat/completions`). Cursor's agent sometimes sends a Responses-API body to the chat-completions path; that endpoint accepts both shapes, and the relay reads and rewrites effort in whichever shape arrives.
- **Not routed:** Tab completion, which always uses Cursor's own models, and anything Cursor serves with its own models, including parts of Composer and its Auto mode. Background agents and the Cursor CLI (`cursor-agent`) cannot use a custom base URL at all: the CLI's `--endpoint` picks which Cursor backend it logs in to. Cursor's hooks (`~/.cursor/hooks.json`) cannot change the model and are not wired up.
- **Vercel AI Gateway egress:** chat-shaped requests work. A Responses-shaped body goes to Vercel's chat endpoint unchanged and should be expected to fail, because Vercel has no Cursor endpoint. Use OpenRouter for Cursor's GPT-family agent traffic.
- **Other OpenAI models in Cursor:** with the OpenAI key and the override on, Cursor sends its other OpenAI model names through the relay too. They pass through unrouted and usually fail at a gateway that names models differently. Pick `jev-router/auto`.

### Security model

- The relay injects your real gateway key upstream. Only the token stands between the public URL and your bill. `expose` never publishes a relay that accepts a request without it.
- Treat the public URL and the token as secrets. The token is stored in Cursor's settings and is sent to Cursor's backend with every request. Cursor's zero-data-retention policy does not apply to requests made with your own key. Use a token made for this and nothing else.
- Quick tunnels get a new URL each time they start. Stopping `expose` takes the URL offline, and rotating the token cuts off every copy of it.
- A token relay answers CORS preflights, and tags responses to browser requests with `access-control-allow-origin: *`, so the desktop app can verify the key. The real request still needs the token. A relay without a token never sends CORS headers.

## Anything OpenAI-compatible

Point the tool at `http://127.0.0.1:4141/v1` with model `auto`. Without harness hooks the router still has the tool results carried in the request body and the judge; it lacks only compaction notices and explicit error flags.

## Background service

`setup` installs the relay as a per-user service: `~/Library/LaunchAgents/ai.jev-router.relay.plist` on macOS (`launchctl`), `~/.config/systemd/user/jev-router.service` on Linux (`systemctl --user`). It starts at login, restarts if it exits, runs `jev-router up` with the same Node and CLI path `setup` ran from, and logs to `~/.jev-router/relay.log`. `jev-router service install|uninstall|status` manages it; on other platforms `setup` says so and leaves `jev-router up` to you. After upgrading the package, run `jev-router service install` again so the service points at the new files.

## Reaching the relay from containers or other machines

Bind wider than loopback only with a token:

```bash
export JEV_ROUTER_TOKEN=$(openssl rand -hex 16)
jev-router up --host 0.0.0.0 --token "$JEV_ROUTER_TOKEN"
jev-router setup --token "$JEV_ROUTER_TOKEN"     # writes it as each harness's credential
```

Every request must then carry it as a bearer token or `x-api-key`, because the relay injects your real provider key upstream. For callers on the public internet, such as Cursor's servers, keep the relay on loopback and publish it with `jev-router expose` (see [Cursor](#cursor)) instead of binding `0.0.0.0`.
