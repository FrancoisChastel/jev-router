# Evaluating jev-router with Harbor

No savings claim without this. `stats` and `replay` tell you what routing did to cost; only a benchmark tells you what it did to task success. The design follows Switchyard's method: run Terminal-Bench through Harbor with real coding harnesses, once routed and once per single-model baseline, and compare success rate and cost per solved task.

## Prerequisites

- Python 3.12 or later, [uv](https://docs.astral.sh/uv/), Docker, and Harbor: `uv tool install --upgrade harbor`
- A gateway key for the egress in your policy, for example `OPENROUTER_API_KEY`, and the same or another key for the judge
- The relay: `bun run build` in this repo, or `npm i -g @french-castle/jev-router`

## Apple Silicon: rebuild the task images natively

The prebuilt Terminal-Bench images are x86-64 only. Under QEMU emulation on an Apple Silicon Mac the agent runs fine, but the verifier, which downloads a standalone CPython through `uv` and runs pytest, segfaults (`qemu: uncaught target signal 11`) and every trial scores zero. Observed on a full eight-task run: eight of eight verifiers died this way.

Every Terminal-Bench task ships its `environment/Dockerfile`, and Harbor's `--force-build` rebuilds from it instead of pulling the prebuilt image. The rebuild targets the Docker daemon's own architecture, so on Apple Silicon the task image, the agent and the verifier all run as native arm64 and the segfault disappears. `scripts/bench-terminal-bench.sh` turns `--force-build` on automatically when the Docker daemon is not amd64 (`BENCH_FORCE_BUILD=0` disables it). The first run of each task pays for the build, typically one to three minutes for apt-based images; Harbor caches the result by content hash.

Three tasks (`filter-js-from-html`, `qemu-startup`, `qemu-alpine-ssh`) install x86-64 binaries in their Dockerfile and cannot be rebuilt for arm64. Enabling Rosetta in Docker Desktop (**Settings, General, Use Rosetta for x86_64/amd64 emulation**) is the alternative that keeps the prebuilt images. On Linux x86-64 hosts none of this applies.

## Make the relay reachable from the sandbox

Harbor runs each task in a Docker container. `127.0.0.1` inside the container is not your machine.

- macOS and Windows: bind the relay to all interfaces and let containers reach it through `host.docker.internal`.
- Linux: either run Harbor's containers with host networking, or bind to the Docker bridge address (`docker network inspect bridge` shows it, usually `172.17.0.1`).

```bash
export JEV_ROUTER_TOKEN=$(openssl rand -hex 16)
jev-router up --host 0.0.0.0 --port 4141          # refuses a non-loopback bind without a token
export RELAY=http://host.docker.internal:4141     # Linux with a bridge bind: http://172.17.0.1:4141
```

The relay injects your real provider key, so a non-loopback bind requires a token, and every request must present it. Pass it as the harness credential below. Stop the relay after the run.

## Scripted runs

Two scripts in `scripts/` do everything below for one configuration at a time and produce the comparison table:

```bash
export OPENROUTER_API_KEY=sk-or-...   # judge and egress
export JEV_ROUTER_HOME=/tmp/jev-bench/home && jev-router init
scripts/bench-terminal-bench.sh fast           # pinned baseline via --shadow, default eight-task subset
scripts/bench-terminal-bench.sh routed
scripts/bench-terminal-bench.sh mid
node scripts/bench-report.mjs --jobs /tmp/jev-bench/jobs --logs /tmp/jev-bench --policy /tmp/jev-bench/home/policy.json fast routed mid
```

The runner starts the relay on all interfaces with a generated token, runs Harbor with the Pi adapter (`BENCH_AGENT=opencode` switches harness), and stops the relay. Pass task names as extra arguments to change the subset. The report joins each trial's verifier reward with the relay's decision log for that configuration.

`scripts/bench-batch.sh fast routed mid -- <task ...>` chains configurations and stops when the OpenRouter key's usage since the batch started exceeds `BENCH_MAX_SPEND_USD` (default 5). It reads the key only from the environment; nothing is written to disk but `$BENCH_DIR/batch.log`.

One trial per task is noise: identical configurations differ by a task or two between runs. `BENCH_ATTEMPTS=3` runs every task three times (job and log are then named `<config>-k3`), and `BENCH_RUN_NAME` names a run explicitly, for example `routed` under an alternative `JEV_ROUTER_POLICY`. Before spending on a live re-run, `jev-router replay --policy candidate.json --log routed.jsonl` shows what the candidate policy would have decided on the recorded judge answers.

## Routed runs

The relay checks the credential Harbor passes against its token, then swaps in the egress key.

Claude Code, Anthropic Messages format, one task to start:

```bash
harbor run --dataset terminal-bench@2.0 --agent claude-code \
  --model claude-code/auto \
  --ae "ANTHROPIC_API_KEY=$JEV_ROUTER_TOKEN" \
  --ae "ANTHROPIC_BASE_URL=$RELAY" \
  --ae "CLAUDE_CODE_GATEWAY_HINT_HEADERS=1" \
  --n-tasks 1
```

Codex, Responses API:

```bash
harbor run --dataset terminal-bench@2.0 --agent codex \
  --model auto \
  --ae "OPENAI_API_KEY=$JEV_ROUTER_TOKEN" \
  --ae "OPENAI_BASE_URL=$RELAY/v1" \
  --n-tasks 1
```

OpenCode and Pi, OpenAI chat format (the leading `openai/` selects the harness's OpenAI-compatible provider):

```bash
harbor run --dataset terminal-bench@2.0 --agent opencode \
  --model openai/auto --ae "OPENAI_API_KEY=$JEV_ROUTER_TOKEN" --ae "OPENAI_BASE_URL=$RELAY/v1" --n-tasks 1

harbor run --dataset terminal-bench@2.0 --agent pi \
  --model openai/auto --ae "OPENAI_API_KEY=$JEV_ROUTER_TOKEN" --ae "OPENAI_BASE_URL=$RELAY/v1" \
  --ak model_api=openai-completions --n-tasks 1
```

Remove `--n-tasks 1` for the full dataset. `terminal-bench@2.1` and other Harbor Hub datasets work the same way. Pass verifier credentials separately with `--ve` when a task uses a model to judge results.

## Baselines

Run the same commands with the relay still in the path but pinned, so the harness, prompts, and tool set stay identical and only the model changes:

```bash
jev-router up --host 0.0.0.0 --port 4141 --shadow fast       # then the routed command above
jev-router up --host 0.0.0.0 --port 4141 --shadow frontier   # both still need JEV_ROUTER_TOKEN set
```

Shadow mode serves the pinned candidate for every request and still logs what the router would have chosen, so a single baseline run also yields a counterfactual routing trace. Alternatively point Harbor straight at the gateway with a fixed `--model`, as the Vercel and Switchyard guides show; that removes the relay from the baseline entirely.

## What to compare

| Metric | Source |
|---|---|
| Task success rate per configuration | Harbor's run output |
| Actual cost of the routed run | `jev-router stats` on the routed run's log |
| Cost of each baseline | `jev-router stats` on that run's log, or the gateway's dashboard |
| Cost per solved task | success count divided into cost, per configuration |
| Judge overhead | the judge line in `stats` |
| Routing mix | `by candidate` and `by source` in `stats` |

Use a separate `JEV_ROUTER_LOG` per run so logs do not mix:

```bash
JEV_ROUTER_LOG=~/.jev-router/tb-routed.jsonl jev-router up --host 0.0.0.0
```

Report every baseline, including the ones the router loses to. A router that is cheaper than always-frontier but less successful than always-mid has not won; the honest figure is cost per solved task against the best single model.

## Results

Terminal-Bench 2.0 through Harbor, Pi agent, 2026-09-27. Twelve easy and medium tasks (`fix-git`, `prove-plus-comm`, `cobol-modernization`, `openssl-selfsigned-cert`, `overfull-hbox`, `regex-log`, `log-summary-date-ranges`, `sqlite-db-truncate`, `constraints-scheduling`, `kv-store-grpc`, `vulnerable-secret`, `polyglot-c-py`), images rebuilt natively on an Apple Silicon Mac, inference and judge (`typesafe/jev-1.13`) through OpenRouter with the candidates `init` generates: fast `openai/gpt-6-luna`, mid `anthropic/claude-sonnet-5`, frontier `anthropic/claude-opus-5.5`. Four configurations: the fast tier pinned (one and three attempts per task), routed under the rules 0.1.0 shipped (one attempt), and routed under the rules that are now the default (three attempts). Total spend for everything below, including a mid-pinned baseline stopped after 20 requests ($0.21) to stay within a few dollars: $4.05, of which the judge cost about half a cent.

| config | trials | solved | success | errored | upstream cost | cost / solved | judge calls | judge p50 | judge cost | served |
|---|---|---|---|---|---|---|---|---|---|---|
| fast | 12 | 11 | 92% | 0 | $0.027 | $0.0025 | 21 | 247 ms | $0.0007 | fast 87 |
| fast-k3 | 36 | 32 | 89% | 0 | $0.091 | $0.0028 | 62 | 225 ms | $0.0020 | fast 280 |
| routed | 12 | 8 | 67% | 0 | $3.62 | $0.45 | 25 | 214 ms | $0.0008 | fast 68, mid 32, frontier 19 |
| routed-tuned-k3 | 36 | 30 | 83% | 0 | $0.088 | $0.0029 | 62 | 236 ms | $0.0020 | fast 290 |

| task | fast | fast-k3 | routed | routed-tuned-k3 |
|---|---|---|---|---|
| cobol-modernization | pass · 47s · $0.0042 · fast 9 | 3/3 · 44s · $0.0039 · fast 25 | pass · 897s · $3.21 · mid 18, frontier 19 | 3/3 · 57s · $0.0049 · fast 37 |
| constraints-scheduling | pass · 11s · $0.0010 · fast 3 | 3/3 · 11s · $0.0008 · fast 9 | pass · 78s · $0.13 · mid 4 | 3/3 · 10s · $0.0008 · fast 9 |
| fix-git | pass · 17s · $0.0014 · fast 8 | 3/3 · 24s · $0.0020 · fast 28 | pass · 21s · $0.0019 · fast 9 | 3/3 · 25s · $0.0017 · fast 32 |
| kv-store-grpc | pass · 21s · $0.0011 · fast 7 | 3/3 · 22s · $0.0011 · fast 24 | fail · 23s · $0.0012 · fast 8 | 3/3 · 24s · $0.0012 · fast 25 |
| log-summary-date-ranges | pass · 11s · $0.0016 · fast 5 | 3/3 · 11s · $0.0014 · fast 14 | fail · 6s · $0.0013 · fast 3 | 3/3 · 11s · $0.0015 · fast 13 |
| openssl-selfsigned-cert | pass · 12s · $0.0008 · fast 4 | 3/3 · 13s · $0.0009 · fast 13 | pass · 13s · $0.0009 · fast 4 | 3/3 · 17s · $0.0009 · fast 14 |
| overfull-hbox | pass · 60s · $0.0054 · fast 13 | 1/3 · 90s · $0.0086 · fast 58 | fail · 117s · $0.012 · fast 22 | 1/3 · 65s · $0.0063 · fast 52 |
| polyglot-c-py | fail · 42s · $0.0035 · fast 7 | 1/3 · 45s · $0.0038 · fast 21 | fail · 27s · $0.0023 · fast 5 | 0/3 · 50s · $0.0043 · fast 21 |
| prove-plus-comm | pass · 28s · $0.0017 · fast 12 | 3/3 · 19s · $0.0011 · fast 29 | pass · 11s · $0.0006 · fast 5 | 3/3 · 20s · $0.0011 · fast 32 |
| regex-log | pass · 24s · $0.0017 · fast 4 | 3/3 · 20s · $0.0016 · fast 12 | pass · 25s · $0.0020 · fast 4 | 2/3 · 23s · $0.0018 · fast 12 |
| sqlite-db-truncate | pass · 25s · $0.0025 · fast 7 | 3/3 · 29s · $0.0031 · fast 21 | pass · 82s · $0.26 · mid 10 | 3/3 · 25s · $0.0024 · fast 19 |
| vulnerable-secret | pass · 16s · $0.0020 · fast 8 | 3/3 · 18s · $0.0019 · fast 26 | pass · 17s · $0.0017 · fast 8 | 3/3 · 18s · $0.0025 · fast 24 |

What it shows:

- On tasks this size the fast tier already solves about nine in ten. The best any router can do here is match it at the same cost; the upside of escalation needs harder tasks than this budget allowed.
- The 0.1.0 rules escalated three tasks to mid on the judge's first-turn difficulty estimate (`difficulty >= 2 or needs_reasoning > 0.8`) and one of those to frontier after a single failed tool call. Success did not improve; the three fast-served failures in that run are the same trial-to-trial variance the three-attempt fast run shows. Cost per solved task rose from $0.0025 to $0.45, most of it one frontier session that ran to the 900 s agent timeout ($3.21).
- Replaying the recorded judge answers under the tuned rules predicted the routed run's cost would drop from $2.12 to $0.13 on the same tokens. The live three-attempt re-run confirmed it: every request stayed on the fast tier, 30 of 36 solved against 32 of 36 for fast pinned, $0.0029 per solved task against $0.0028, judge overhead $0.002 in total at a median 236 ms.
- The judge's first-turn difficulty scores on these tasks ran from 1.1 to 2.3 with confidence 0.3 to 0.77. The tuned rule (`difficulty >= 2.5 and needs_reasoning > 0.8`) leaves the first-turn escalation for tasks the judge is sure are hard and need careful reasoning; `spinning > 0.7 or (tools_failed > 0.7 and spinning > 0.5)` waits for repeated failure instead of one bad call. The built-in override for three consecutive all-failure batches still applies.

Caveats, so nobody over-reads this:

- The tuned rules were calibrated on these twelve tasks and then measured on the same twelve. That is an in-sample result. The subset has no hard tasks, so it cannot show the case routing exists for: a fast tier that fails and a capable tier that recovers.
- Three attempts per task is still small. `overfull-hbox` passed one of three in both three-attempt runs, `polyglot-c-py` zero or one of three, `regex-log` two or three of three.
- Repeated attempts of one task produce identical prompt prefixes, so the relay keyed them to one session and leases carried across attempts in the three-attempt runs; the harnesses that send session headers (Claude Code, OpenCode) do not have this problem outside Harbor.
- Rewards are Terminal-Bench's own verifier results; agent time is Harbor's agent phase, excluding image build and agent install.

## Known gaps

- Cached input is priced as ordinary input in `stats`. Provider cache discounts make the real numbers lower for long sessions; per-provider cache pricing is planned.
- `replay` assumes the same tokens would have flowed through a different model, which understates the difference for models that are more or less verbose.
- Harbor adapters change; check each adapter's endpoint and model handling against the Harbor source before trusting a run.
