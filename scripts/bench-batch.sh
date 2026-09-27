#!/usr/bin/env bash
# Run several benchmark configurations back to back with a spend guard.
#
#   OPENROUTER_API_KEY=... JEV_ROUTER_HOME=/tmp/jev-bench/home scripts/bench-batch.sh fast routed mid [-- task ...]
#
# Runs scripts/bench-terminal-bench.sh once per configuration, in order. Before each configuration it reads the
# OpenRouter credits endpoint and stops when the spend since the batch started exceeds BENCH_MAX_SPEND_USD (default 5).
# Env: everything bench-terminal-bench.sh reads, plus BENCH_MAX_SPEND_USD. Progress goes to $BENCH_DIR/batch.log.
set -uo pipefail

CONFIGS=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do CONFIGS+=("$1"); shift; done
[ "${1:-}" = "--" ] && shift
TASKS=("$@")
[ ${#CONFIGS[@]} -gt 0 ] || { echo "usage: bench-batch.sh <config>... [-- task ...]" >&2; exit 2; }

BENCH_DIR=${BENCH_DIR:-/tmp/jev-bench}
BENCH_MAX_SPEND_USD=${BENCH_MAX_SPEND_USD:-5}
mkdir -p "$BENCH_DIR"
LOG="$BENCH_DIR/batch.log"
ROOT=$(cd "$(dirname "$0")/.." && pwd)

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }

spent() {
  # Total usage in USD on the OpenRouter key, or empty when the key is not an OpenRouter key or the call fails.
  [ -n "${OPENROUTER_API_KEY:-}" ] || return 0
  curl -s --max-time 15 https://openrouter.ai/api/v1/credits -H "Authorization: Bearer $OPENROUTER_API_KEY" |
    python3 -c 'import json,sys
try: print("%.4f" % json.load(sys.stdin)["data"]["total_usage"])
except Exception: pass' 2>/dev/null
}

START_USAGE=$(spent)
log "batch start configs=${CONFIGS[*]} tasks=${#TASKS[@]} max_spend=$BENCH_MAX_SPEND_USD usage_at_start=${START_USAGE:-unknown}"

for cfg in "${CONFIGS[@]}"; do
  now=$(spent)
  if [ -n "$now" ] && [ -n "$START_USAGE" ]; then
    delta=$(python3 -c "print('%.4f' % ($now - $START_USAGE))")
    log "spend so far: \$$delta"
    if python3 -c "import sys; sys.exit(0 if $delta > $BENCH_MAX_SPEND_USD else 1)"; then
      log "SKIP $cfg: spend \$$delta exceeds BENCH_MAX_SPEND_USD=$BENCH_MAX_SPEND_USD"
      continue
    fi
  fi
  log "config $cfg start"
  if "$ROOT/scripts/bench-terminal-bench.sh" "$cfg" "${TASKS[@]}" >>"$LOG" 2>&1; then
    log "config $cfg end ok"
  else
    log "config $cfg end FAILED (exit $?)"
  fi
done

END_USAGE=$(spent)
if [ -n "$END_USAGE" ] && [ -n "$START_USAGE" ]; then
  log "batch end total_spend=\$$(python3 -c "print('%.4f' % ($END_USAGE - $START_USAGE))")"
else
  log "batch end"
fi
