# Security

## Reporting a vulnerability

Email francois@chastel.co with a description and, if you can, a reproduction. Please do not open a public issue for anything that could expose credentials or let a third party route traffic through someone else's relay. You will get an acknowledgement within a few days and a fix or a plan before any public disclosure.

## What the relay does with secrets

- Provider keys are read from environment variables named in the policy. They are never written to the policy, the decision log, or any file the installer creates.
- The relay binds to `127.0.0.1` by default. Binding anywhere else requires `--token`, which every request must present, because the relay injects your real provider key into upstream calls.
- The judge receives a bounded dossier: the last user ask, a short assistant-intent tail, tool names, and up to three short tool-output excerpts. Never the full conversation, file contents, or system prompt. A redaction hook runs before anything leaves the process.
- The decision log stores digests, vocabularies, and token counts, not prompt text.

## Supported versions

The latest minor release receives fixes. Earlier versions do not.
