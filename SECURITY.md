# Security

## Reporting a vulnerability

Email francois@chastel.co with a description and, if you can, a reproduction. Please do not open a public issue for anything that could expose credentials or let a third party route traffic through someone else's relay. You will get an acknowledgement within a few days and a fix or a plan before any public disclosure.

## What the relay does with secrets

- Provider keys are read from environment variables named in the policy, else from `~/.jev-router/env`, a file `setup` writes only when you give it a key, with mode 600, so the background service can find it. Keys are never written to the policy, the decision log, or any harness file.
- The env file may also hold `GEMINI_API_KEY`: when Gemini CLI routes over an API key, `setup` copies it there from your shell so the background relay can inject it.
- Harness logins (Claude Code's claude.ai OAuth, Codex's ChatGPT login, Gemini CLI's Google login) are forwarded unchanged, per request, to the provider that harness already talks to, and only for that harness. The relay never reads, stores, or reuses them. `init` reads the plan type from Claude Code's account record and from the plan claim in Codex's id token to know which models to offer; the token itself is decoded in memory and discarded. For Gemini CLI it reads only the auth type from `~/.gemini/settings.json`.
- The relay binds to `127.0.0.1` by default. Binding anywhere else requires `--token`, which every request must present, because the relay injects your real provider key into upstream calls. A `--token` bind cannot forward harness logins.
- Every POST must declare `content-type: application/json`, else 415, so a web page cannot use a browser's preflight-free text/plain POST to spend keys through a loopback relay.
- The judge receives a bounded dossier: the last user ask, a short assistant-intent tail, tool names, and up to three short tool-output excerpts. Never the full conversation, file contents, or system prompt. A redaction hook runs before anything leaves the process.
- The decision log stores digests, vocabularies, and token counts, not prompt text.

## Supported versions

The latest minor release receives fixes. Earlier versions do not.
