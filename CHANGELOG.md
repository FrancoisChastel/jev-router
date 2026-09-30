# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Cascade within a turn, off by default: `policies.<id>.cascade` retries a routed request one tier up the policy's `order` when the answer is an upstream error (429, 5xx, 529, error event), empty, a short refusal, or truncated, before the client sees anything. Options `on`, `max_retries`, `buffer`, `buffer_max_bytes`, `buffer_max_ms`, `budget_usd`, all validated at load. A buffer cap flushes the response unchanged and abandons the cascade with a warning on stderr. Passthrough, `count_tokens`, shadow mode, and top-tier requests never cascade.
- `x-jev-router-cascade` response header (for example `fast->mid (empty)`), and an additive `cascade` field on decision records listing every attempt with its outcome, usage, and cost.
- `stats` reports cascaded requests, retries, and the cost of attempts the client never saw.

### Changed

- A cascaded record's `usage` is the sum over its attempts, and `stats` and `replay` charge every attempt in the actual cost while pricing single-candidate baselines on the served answer alone. After a cascade the session continues on the tier that served.
- The relay's forwarding code moved from `src/daemon/relay.ts` to `src/daemon/forward.ts`, split into call and delivery steps; behaviour is unchanged.

## [0.2.0] - 2026-09-27

### Added

- One-command install: `jev-router setup` asks for the judge key once (stored in `~/.jev-router/env`, mode 600, read by every command), detects Claude Code and Codex logins and which harnesses are installed, writes the policy, configures each harness, installs the relay as a background service (launchd on macOS, systemd user unit on Linux), and checks that it answers. `jev-router service install|uninstall|status` manages the service; `--no-service`, `--no-prompt`, `--judge-key`, `--dry-run` cover the rest.
- Plan-backed inference. A Claude Code login (Pro, Max) routes `claude-code/auto` over Haiku, Sonnet, and Opus through Claude Code's own OAuth, forwarded unchanged to api.anthropic.com. A Codex ChatGPT login routes `auto` over the models the plan lists, through a provider marked `requires_openai_auth` and a relay mount at `/backend-api/codex` that proxies Codex's catalog (with an `auto` entry added) and its other backend calls. Nothing is copied or stored: `init` reads only the plan type, and the relay forwards each harness's credentials at request time.
- Policy: egress `mount` and `billing` fields; policies may use a subset of candidates via `order`; Codex `thread-id` / `session-id` headers key sessions.
- Claude Code `modelPicker` row for `claude-code/auto` with `behavesAs`, so the picker shows `auto (jev-router)` and Claude Code stops warning about an unknown model.
- Usage is captured from Responses streams (`response.completed`), not only chat completions and Anthropic messages.
- `scripts/bench-batch.sh` chains benchmark configurations with an OpenRouter spend guard (`BENCH_MAX_SPEND_USD`).
- `BENCH_ATTEMPTS` and `BENCH_RUN_NAME` for the benchmark runner; `scripts/bench-report.mjs` attributes relay sessions to tasks, so every task shows its own upstream cost and served tiers, and aggregates repeated attempts.
- First measured results in `docs/evaluation.md`: a 12-task Terminal-Bench 2.0 subset with Pi, four configurations, $4 total.

### Changed

- Default rules escalate on evidence instead of an upfront guess: `difficulty >= 2.5 and needs_reasoning > 0.8` (was `difficulty >= 2 or needs_reasoning > 0.8`) and `spinning > 0.7 or (tools_failed > 0.7 and spinning > 0.5)` (was `tools_failed > 0.7 or spinning > 0.7`). On the benchmark subset the old thresholds escalated a quarter of the tasks for no gain in success at 180x the cost per solved task; the new ones match the fast tier's success and cost. Existing `policy.json` files keep their rules; `jev-router init --force` regenerates.
- `scripts/bench-terminal-bench.sh` passes `--force-build` to Harbor when the Docker daemon is not amd64, so Terminal-Bench images are rebuilt natively on Apple Silicon and the verifier no longer segfaults under emulation. `BENCH_HARBOR_ARGS` appends extra Harbor flags.

## [0.1.0] - 2026-09-27

First public release. Early software: the mechanics are tested live against OpenRouter, the routing quality is not yet benchmarked.

### Added

- Pure decision engine: policy loader with a whitelisted rule language and load-time identifier checks, Switchyard-style stage scorer over tool outcomes, bounded judge dossier, task and execution question sets, session and lease handling, counterfactual costs.
- Judge transports for TypeSafe direct, Vercel AI Gateway, and OpenRouter Decisions, with timeout, bounded retry, cancellation, and answer validation.
- Pi extension that switches model and thinking level in-process and pauses on a manual model pick.
- Local relay speaking Anthropic Messages, OpenAI chat, and OpenAI Responses, forwarding unchanged to OpenRouter or Vercel AI Gateway with only model and effort rewritten. Streams byte-for-byte, echoes the requested model id, captures usage, passes errors through, propagates client cancellation under Node.
- Native hook ingest for Claude Code and Codex, plus `/observe` and `/decide` for plugins.
- Claude Code plugin (marketplace in this repo), Codex hooks pack, OpenCode plugin, and `jev-router setup` installer with dry-run and backups.
- Zero-config `init` from the keys in the environment with live catalog prices, `ping` for a real judge call, and auto-init in `up` and `setup`.
- Measurement: `stats` against every single-candidate baseline, `replay` under a new policy from recorded judge answers, shadow mode.
- Harbor evaluation runbook.

### Known limitations

- Under Bun's Node-compatibility layer a client cancellation does not propagate upstream; run the relay with Node.
- OpenRouter's Anthropic-compatible surface has no token-counting endpoint; Claude Code falls back to an estimate.
- Vercel and TypeSafe transports are tested against their documented shapes, not with live keys.
- Cached input is priced as ordinary input in `stats`.

[Unreleased]: https://github.com/FrancoisChastel/jev-router/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/FrancoisChastel/jev-router/releases/tag/v0.1.0
