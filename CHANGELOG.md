# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
