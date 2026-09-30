# jev-router hooks for Gemini CLI

Gemini CLI hooks are commands that read a JSON payload on stdin. Each event here runs `jev-router hook gemini`, which forwards the payload to the relay and always prints `{}` (carry on). `AfterTool` reports tool results and failures, `BeforeAgent` reports a new prompt. There is no compaction hook: Gemini CLI fires `PreCompress` on every turn, before it decides whether to compress, so it cannot tell the relay that a compaction happened.

The hooks only help when Gemini CLI is logged in with Google: its Code Assist requests carry `request.session_id`, the same id the hook payloads carry, so the relay joins them into one session. With an API key the requests carry no session id, the relay keys the session on the conversation prefix instead, and it reads tool outcomes from the `functionResponse` parts in each request, so `setup` leaves the hooks out.

Install with `npx @french-castle/jev-router setup --agent gemini`, which merges these hooks into `~/.gemini/settings.json` (Google login only), sets `model.name` to `jev-router/auto`, and writes the relay endpoint into `~/.gemini/.env`, with backups. By hand, merge `settings.json` from this folder into `~/.gemini/settings.json` and export one of:

```bash
export CODE_ASSIST_ENDPOINT=http://127.0.0.1:4141/code-assist   # logged in with Google
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4141/gemini       # GEMINI_API_KEY
```

Use `jev-router/auto` as the model, not `auto`: Gemini CLI resolves `auto` itself and never sends it.
