#!/usr/bin/env bash
# Run one benchmark configuration: start the relay (routed or pinned via --shadow), run Harbor against it, stop the relay.
#
#   OPENROUTER_API_KEY=... JEV_ROUTER_HOME=/tmp/jev-bench/home \
#   scripts/bench-terminal-bench.sh <config> [task ...]
#
#   config   routed | fast | mid | frontier     (anything but "routed" pins that candidate with --shadow)
#   tasks    Terminal-Bench task names; default is the eight-task subset used in docs/evaluation.md
#
# Env: BENCH_AGENT (pi|opencode, default pi), BENCH_DATASET (default terminal-bench@2.0), BENCH_CONCURRENCY (default 4),
#      BENCH_PORT (default 4141), BENCH_DIR (default /tmp/jev-bench), JEV_ROUTER_TOKEN (generated if unset).
set -euo pipefail

CONFIG=${1:?config required: routed | fast | mid | frontier}
shift || true
TASKS=("$@")
if [ ${#TASKS[@]} -eq 0 ]; then
  TASKS=(fix-git cobol-modernization overfull-hbox prove-plus-comm regex-log log-summary-date-ranges openssl-selfsigned-cert sqlite-db-truncate)
fi

BENCH_AGENT=${BENCH_AGENT:-pi}
BENCH_DATASET=${BENCH_DATASET:-terminal-bench@2.0}
BENCH_CONCURRENCY=${BENCH_CONCURRENCY:-4}
BENCH_PORT=${BENCH_PORT:-4141}
BENCH_DIR=${BENCH_DIR:-/tmp/jev-bench}
export JEV_ROUTER_TOKEN=${JEV_ROUTER_TOKEN:-$(openssl rand -hex 12)}
export JEV_ROUTER_HOME=${JEV_ROUTER_HOME:-$BENCH_DIR/home}
export JEV_ROUTER_LOG="$BENCH_DIR/$CONFIG.jsonl"
mkdir -p "$BENCH_DIR/jobs" "$JEV_ROUTER_HOME"

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI="node $ROOT/dist/cli/index.js"
if ! [ -f "$ROOT/dist/cli/index.js" ]; then echo "build first: bun run build" >&2; exit 1; fi

if lsof -nP -iTCP:"$BENCH_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $BENCH_PORT is busy; stop the other relay first" >&2; exit 1; fi

SHADOW=()
[ "$CONFIG" != "routed" ] && SHADOW=(--shadow "$CONFIG")
: > "$JEV_ROUTER_LOG"
$CLI up --host 0.0.0.0 --port "$BENCH_PORT" "${SHADOW[@]}" < /dev/null 2> "$BENCH_DIR/relay-$CONFIG.err" &
RELAY_PID=$!
trap 'kill -TERM $RELAY_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "authorization: Bearer $JEV_ROUTER_TOKEN" "http://127.0.0.1:$BENCH_PORT/v1/models" || true)
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || { echo "relay did not come up (models -> $code); see $BENCH_DIR/relay-$CONFIG.err" >&2; exit 1; }
echo "relay up on :$BENCH_PORT config=$CONFIG log=$JEV_ROUTER_LOG"

INCLUDE=()
for t in "${TASKS[@]}"; do INCLUDE+=(--include-task-name "$t"); done

case "$BENCH_AGENT" in
  pi)       AGENT_ARGS=(--agent pi --model openai/auto --ak model_api=openai-completions) ;;
  opencode) AGENT_ARGS=(--agent opencode --model openai/auto) ;;
  *) echo "unknown BENCH_AGENT $BENCH_AGENT" >&2; exit 1 ;;
esac

harbor run --dataset "$BENCH_DATASET" "${AGENT_ARGS[@]}" \
  --ae "OPENAI_API_KEY=$JEV_ROUTER_TOKEN" --ae "OPENAI_BASE_URL=http://host.docker.internal:$BENCH_PORT/v1" \
  --allow-agent-host host.docker.internal --allow-agent-host 192.168.65.0/24 \
  "${INCLUDE[@]}" --n-concurrent "$BENCH_CONCURRENCY" --jobs-dir "$BENCH_DIR/jobs" --job-name "tb-$BENCH_AGENT-$CONFIG" -y -q

echo "done: config=$CONFIG decisions=$(wc -l < "$JEV_ROUTER_LOG" | tr -d ' ') job=$BENCH_DIR/jobs/tb-$BENCH_AGENT-$CONFIG"
