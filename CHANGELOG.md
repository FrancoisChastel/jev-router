# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Plan-window awareness. The relay reads how full a plan's usage windows are from the response headers of subscription egresses (Anthropic `anthropic-ratelimit-unified-5h-utilization` / `-7d-utilization`; Codex `x-codex-primary-used-percent` / `x-codex-secondary-used-percent`, verified live) and exposes them to rules as `plan_5h` and `plan_7d` (0..1, absent until observed). New rule action `at_most` caps the tier after every other action. Policies generated for a Claude Code or Codex login cap at the middle tier from 80% of the five-hour window and at the cheapest from 95%. `JEV_ROUTER_DEBUG_HEADERS=1` prints rate-limit and usage-like response headers.
- `GET /status` on the relay: latest plan window per egress, the last decision per session with its cost and saving, and today's totals.
- `jev-router why [--session <key>] [--last N] [--log <path>]` explains logged decisions: tier, model, effort, source, reasons, judge answers, cost, counterfactuals, plan window.
- `jev-router statusline` for Claude Code's `statusLine`, for example `jev-router · sonnet-5 · saved $0.42 today · plan 5h 43%`; silent when the relay is down. `setup` adds it when `settings.json` has no status line.
- A free local tier: `init` detects Ollama on `127.0.0.1:11434`, adds an `ollama` egress and a `local` candidate (a pulled coding model), and pins auxiliary and compaction calls to it in the default policy.
- Egress `no_auth` (send no credentials) and `dialects` (wire formats the upstream accepts; other requests skip its candidates). Decision records carry the `plan` window they saw.

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
