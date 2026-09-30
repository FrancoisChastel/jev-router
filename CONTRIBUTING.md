# Contributing

Thanks for taking a look. jev-router is small on purpose, and the bar is: every change keeps the router honest about what it does and measurable in what it costs.

## Setup

```bash
git clone https://github.com/FrancoisChastel/jev-router
cd jev-router
bun install
bun run check      # typecheck, lint, tests, build, Node cancellation smoke
```

Bun runs the tests and builds; the published package runs on Node 22 or later and on Bun. Keep `src/core` and `src/judge` free of Node-only imports, since a test bundles them for the browser target to prove it.

## How the code is laid out

| Directory | What lives there | Rule |
|---|---|---|
| `src/core` | Pure decision engine: policy, signals, dossier, decide | No I/O, no clock, no randomness. Everything testable from fixtures |
| `src/judge` | Judge interface and transports | Same request shape for TypeSafe, Vercel, OpenRouter |
| `src/daemon` | Relay, dialects, session store, hook ingest, plan windows, `/status` | Format-preserving. Rewrite `model` and effort, nothing else |
| `src/adapters` | Pi extension, OpenCode plugin | Fail open; a broken router must look like an uninstalled one |
| `src/runtime` | Key, login, and Ollama detection, policy init, env file, log | Reads plan metadata only; never keeps a credential |
| `src/cli` | `init`, `ping`, `setup`, `service`, `up`, `hook`, `stats`, `replay`, `why`, `statusline` | Pure planners in `plans.ts` and `service.ts`, file I/O and process calls in `setup.ts` and `main.ts` |
| `src/measure` | stats and replay | Report every baseline, including the unflattering ones |

[DESIGN.md](./DESIGN.md) explains the decisions and their rationale. Read it before proposing a change to routing behavior.

## Working on a change

1. Write the test first. The suite is `bun test`; fixtures live in `test/fixtures`.
2. Keep functions small and files focused. Prefer returning new objects over mutating.
3. Run `bun run check` before pushing. CI runs the same command plus a pack-and-install of the tarball under Node.
4. Update docs in the same change: README for user-facing behavior, DESIGN.md for decisions, `docs/` for references.

## Adding a harness

A harness adapter is either in-process (the harness can switch its own model) or a hook pack plus relay (it cannot). Start from `src/adapters/pi` for the first kind and `plugins/codex` for the second. Add a harness profile for tool semantics in `src/core/signals/tool-semantics.ts`, a session-key rule in `src/core/session.ts`, and a detection rule in `src/daemon/http-util.ts`.

## Adding a judge transport

Implement the `Judge` interface in `src/judge`. Answers must validate against the questions asked; see `parseAnswers` in `http.ts`. Add the endpoint to `endpointFor` and a key mapping to `src/runtime/defaults.ts`.

## Releasing

Maintainers only. Bump `version` in `package.json`, add a section to `CHANGELOG.md`, run `bun run check`, then `npm publish` (which runs the check and build again through `prepublishOnly`), tag `vX.Y.Z`, push the tag, and create the GitHub release from the changelog section.

## Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
