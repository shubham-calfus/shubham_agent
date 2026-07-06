#!/usr/bin/env bash
# One command to (re)start the whole local ACT Agent stack with FRESH code:
#   1. ACT Agent worker   (aetherion run --agent)
#   2. tool worker        (aetherion run --tool)
#   3. agent_shubham UI   (this app.py, on a dedicated port)
#
# It first KILLS any already-running act_agent workers / agent_shubham UI so the
# restarted processes pick up your latest code (a long-running worker keeps the
# code it imported at startup -- this is what caused "stale worker" runs).
#
# Workers run in the background (logs under .run_logs/); the UI runs in the
# foreground. Ctrl-C stops all three.
#
# Usage:  ./run            # UI on the default dedicated port 8765
#         PORT=8780 ./run  # override the UI port
set -uo pipefail  # NOT -e: pkill returns non-zero when nothing matches, which is fine

HERE="$(cd "$(dirname "$0")" && pwd)"
ACT_AGENT_DIR="$(cd "${TEST_RUNNER_DIR:-$HERE/../act}" && pwd)"
AETHERION="$ACT_AGENT_DIR/.venv/bin/aetherion"
PY="$ACT_AGENT_DIR/.venv/bin/python"
PORT="${PORT:-8765}"          # dedicated UI port
LOG_DIR="$HERE/.run_logs"
mkdir -p "$LOG_DIR"

for bin in "$AETHERION" "$PY"; do
  [ -x "$bin" ] || { echo "ERROR: not found/executable: $bin (run 'uv sync' in act)"; exit 1; }
done

echo "==> Stopping any running ACT Agent workers / agent_shubham UI ..."
# Long-running workers that hold stale code (NOT the short-lived 'aetherion agent' triggers).
pkill -f "$ACT_AGENT_DIR/.venv/bin/aetherion run" 2>/dev/null || true
pkill -f "shubham_agent/app.py" 2>/dev/null || true
# Free the dedicated UI port in case something else is still holding it.
PORT_PIDS="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
if [ -n "$PORT_PIDS" ]; then
  kill $PORT_PIDS 2>/dev/null || true
  sleep 1
  STILL_PORT_PIDS="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
  [ -n "$STILL_PORT_PIDS" ] && kill -9 $STILL_PORT_PIDS 2>/dev/null || true
fi
sleep 1

PIDS=()
cleanup() {
  echo
  echo "==> Shutting down workers ..."
  if [ "${#PIDS[@]}" -gt 0 ]; then
    for pid in "${PIDS[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
  fi
}
trap cleanup EXIT INT TERM

echo "==> Starting ACT Agent worker  (logs: $LOG_DIR/agent.log)"
( cd "$ACT_AGENT_DIR" && exec "$AETHERION" run --agent ) >"$LOG_DIR/agent.log" 2>&1 &
PIDS+=("$!")

echo "==> Starting tool worker       (logs: $LOG_DIR/tool.log)"
( cd "$ACT_AGENT_DIR" && exec "$AETHERION" run --tool ) >"$LOG_DIR/tool.log" 2>&1 &
PIDS+=("$!")

echo "==> Starting shubham_agent UI  →  http://localhost:$PORT   (Ctrl-C stops all three)"
echo "    tail the workers with:  tail -f $LOG_DIR/agent.log $LOG_DIR/tool.log"
echo
# Foreground (no exec) so the EXIT/INT trap fires and tears the workers down with it.
PORT="$PORT" "$PY" "$HERE/app.py"
