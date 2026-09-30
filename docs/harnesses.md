# Harness setup

`jev-router setup` does all of this for you, with `--dry-run` to preview and `.bak` backups of every file it changes. This page is the manual version and the explanation of what each harness can and cannot do.

The relay listens on `http://127.0.0.1:4141` by default. `jev-router setup` configures everything below for the harnesses it finds installed and installs the relay as a background service; the sections that follow describe what it writes, for anyone who prefers to do it by hand or to check the result.

## One command

```bash
jev-router setup                 # asks for the judge key, detects logins, keys, and harnesses, configures, installs the service
jev-router setup --dry-run       # prints every file it would write, writes nothing, installs nothing
jev-router setup --agent codex   # one harness only
jev-router service status        # is the background relay up
jev-router service uninstall     # stop and remove it
```

The judge key is asked for once and stored in `~/.jev-router/env` with mode 600, because a background service has no shell to inherit it from. Every command reads that file and fills in only what the environment lacks. `--judge-key <key>` sets it without a prompt, `--no-prompt` skips the question, and `--no-service` leaves the relay for you to start with `jev-router up`.

With a Claude Code, Codex, or Gemini CLI login on the machine, `init` builds the tiers from the models that plan includes and routes that harness through its own login (see below). A gateway key still serves the judge and any harness without a login.

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

## Gemini CLI

Gemini CLI speaks Google's own dialect, which no gateway serves, so it routes among Gemini models only: over a `GEMINI_API_KEY`, or over its Google login. Its hooks cannot change the model, so the relay is the actuator, as for Claude Code and Codex.

Set the model to `jev-router/auto`, not `auto`. `auto` (like `pro`, `flash`, `flash-lite`) is Gemini CLI's own alias: the CLI resolves it locally, after a classifier call of its own, and never sends it. Any other id is sent verbatim in the request path, and `<prefix>/auto` maps onto the `auto` route.

### With GEMINI_API_KEY

`init` adds a `google` egress (`https://generativelanguage.googleapis.com`, key from `GEMINI_API_KEY`, mounted at `/gemini`) and a `gemini` policy over `gemini-3.1-flash-lite < gemini-3.8-flash < gemini-3.1-pro-preview`, the flash-lite, flash, and pro models Gemini CLI 0.62 offers, starting on flash-lite. The key serves Gemini CLI only; it is never used for the judge. `setup --agent gemini` writes:

```json
// ~/.gemini/settings.json (merged; everything else is kept)
{ "model": { "name": "jev-router/auto" }, "security": { "auth": { "selectedType": "gemini-api-key" } } }
```

```bash
# ~/.gemini/.env
GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4141/gemini
```

The auth type is set only when none is chosen: with `GOOGLE_GEMINI_BASE_URL` and no explicit type, Gemini CLI 0.62 picks a `gateway` type that `gemini -p` then rejects ("Invalid auth method selected"). Gemini CLI reads `~/.gemini/.env` only in trusted folders and only when no project `.env` is found walking up from the working directory, so `setup` also prints `export GOOGLE_GEMINI_BASE_URL=...` for a shell profile. Gemini CLI keeps sending its own `GEMINI_API_KEY` (it refuses to start without one); the relay drops it and injects the key from its own environment. Because the background service has no shell, `setup` stores the key in `~/.jev-router/env` (mode 600) next to the judge key.

Everything under `/gemini` that is not a generate call (`countTokens`, model listing) is proxied to Google with the key swapped. A model id the policy does not route, such as an explicit `-m gemini-3.5-flash-lite`, passes through unchanged.

### With a Google login

When Gemini CLI is logged in with Google (`security.auth.selectedType` is `oauth-personal` in `~/.gemini/settings.json`), `init` instead adds a `gemini-code-assist` egress (`https://cloudcode-pa.googleapis.com`, mounted at `/code-assist`, forward_auth, billed as a subscription) over `gemini-3.1-flash-lite < gemini-3-flash < gemini-3.1-pro-preview`, the ids Gemini CLI itself sends to that backend. `setup` points `CODE_ASSIST_ENDPOINT` at `http://127.0.0.1:4141/code-assist`; Gemini CLI keeps attaching its own OAuth bearer, which the relay forwards unchanged. The account housekeeping calls (`loadCodeAssist`, `retrieveUserQuota`, `listExperiments`) are proxied as they are. Only the auth type is read from the settings file; no token is.

`setup` also adds two command hooks to `settings.json` that run `jev-router hook gemini` (copy `plugins/gemini/settings.json` to do it by hand): `AfterTool` reports tool results, with `tool_response.error` or a shell `Exit Code: N` marking a failure, and `BeforeAgent` reports a new prompt. They join the relay session because Code Assist requests carry `request.session_id`, the same id the hook payloads carry. There is no compaction signal: `PreCompress` fires on every turn, before Gemini CLI checks whether the history needs compressing.

### What the relay sees

Captured from Gemini CLI 0.62.0 against a local fake upstream with a fake key:

- API key: `POST {GOOGLE_GEMINI_BASE_URL}/v1beta/models/{model}:streamGenerateContent?alt=sse`, and `:generateContent` for side calls such as its own `auto` classifier. Headers: `user-agent: GeminiCLI-tui/0.62.0/{model} (darwin; arm64; terminal)` (the prefix is `GeminiCLI` or `GeminiCLI-{client}`; the VS Code form ends in `proxy_client=geminicli`), `x-goog-api-key`, `x-goog-api-client: google-genai-sdk/1.30.0 gl-node/...`. No session header.
- Body: `contents[]` with roles `user` and `model` and parts `text` (with `thought: true` for thoughts), `functionCall` (with `id` and `thoughtSignature`), `functionResponse` (`{ name, id, response: { output } }` or `{ response: { error } }`), `inlineData` / `fileData`; `systemInstruction.parts`; `tools[].functionDeclarations`; `generationConfig` with `temperature`, `topP`, `topK`, and `thinkingConfig` (`includeThoughts`, plus `thinkingLevel` for the models Gemini CLI knows, none for a custom id).
- Stream: `data: {...}\r\n\r\n` chunks with `candidates[].content.parts`, `finishReason` on the last one, `usageMetadata` (`promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount`, `thoughtsTokenCount`, `totalTokenCount`), `modelVersion`, `responseId`. No terminal event.
- Google login: `POST {CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse` with `authorization: Bearer ...` and `{ model, project, user_prompt_id, request: { ...the same request..., session_id } }`; each chunk is `{ response: {...the same chunk...}, traceId }`.
- Tool names: `read_file`, `read_many_files`, `list_directory`, `glob`, `grep_search`, `replace`, `write_file`, `run_shell_command`, `web_fetch`, `google_web_search`, `write_todos`, `enter_plan_mode`, `invoke_agent`, `update_topic`, `activate_skill`, and the background-process and tracker tools.

The relay rewrites the model in the path (API key) or in `model` (Code Assist) and, only when the client sent a `thinkingLevel`, the level; it echoes the requested id in `modelVersion`, reads usage from `usageMetadata` (thinking tokens count as output, `cachedContentTokenCount` as cache reads), and takes tool outcomes from the trailing `functionResponse` parts. With an API key the session is keyed on the system instruction and the first user message; Vertex AI mode (`GOOGLE_VERTEX_BASE_URL`) is not routed.

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

## Background service

`setup` installs the relay as a per-user service: `~/Library/LaunchAgents/ai.jev-router.relay.plist` on macOS (`launchctl`), `~/.config/systemd/user/jev-router.service` on Linux (`systemctl --user`). It starts at login, restarts if it exits, runs `jev-router up` with the same Node and CLI path `setup` ran from, and logs to `~/.jev-router/relay.log`. `jev-router service install|uninstall|status` manages it; on other platforms `setup` says so and leaves `jev-router up` to you. After upgrading the package, run `jev-router service install` again so the service points at the new files.

## Reaching the relay from containers or other machines

Bind wider than loopback only with a token:

```bash
export JEV_ROUTER_TOKEN=$(openssl rand -hex 16)
jev-router up --host 0.0.0.0 --token "$JEV_ROUTER_TOKEN"
jev-router setup --token "$JEV_ROUTER_TOKEN"     # writes it as each harness's credential
```

Every request must then carry it as a bearer token, `x-api-key`, or `x-goog-api-key`, because the relay injects your real provider key upstream. Gemini CLI sends its `GEMINI_API_KEY` as `x-goog-api-key`, so give it the token there and keep the real key in the relay's environment.
