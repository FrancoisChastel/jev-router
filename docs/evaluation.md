# Evaluating jev-router with Harbor

No savings claim without this. `stats` and `replay` tell you what routing did to cost; only a benchmark tells you what it did to task success. The design follows Switchyard's method: run Terminal-Bench through Harbor with real coding harnesses, once routed and once per single-model baseline, and compare success rate and cost per solved task.

## Prerequisites

- Python 3.12 or later, [uv](https://docs.astral.sh/uv/), Docker, and Harbor: `uv tool install --upgrade harbor`
- A gateway key for the egress in your policy, for example `OPENROUTER_API_KEY`, and the same or another key for the judge
- The relay: `bun run build` in this repo, or `npm i -g @french-castle/jev-router`

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

## Known gaps

- Cached input is priced as ordinary input in `stats`. Provider cache discounts make the real numbers lower for long sessions; per-provider cache pricing is planned.
- `replay` assumes the same tokens would have flowed through a different model, which understates the difference for models that are more or less verbose.
- Harbor adapters change; check each adapter's endpoint and model handling against the Harbor source before trusting a run.
