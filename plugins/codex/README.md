# jev-router hooks for Codex

Codex hooks are command-only, so each event runs `jev-router hook codex`, which forwards the payload to the relay and always exits 0. Install with `npx jev-router setup --agent codex`, which writes `~/.codex/hooks.json` and the `jev-router` model provider into `~/.codex/config.toml` with backups, or copy `hooks.json` into `~/.codex/` yourself and add:

```toml
model = "auto"
model_provider = "jev-router"

[model_providers.jev-router]
name = "jev-router"
base_url = "http://127.0.0.1:4141/v1"
wire_api = "responses"
env_key = "JEV_ROUTER_TOKEN"
```

Codex requires the Responses API; the relay serves it and forwards to a gateway that does too.
