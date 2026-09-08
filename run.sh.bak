#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One command to (re)start the whole local ACT Agent stack with FRESH code:
#   1. ACT Agent worker   aetherion run --agent   (act/.venv, cwd act)
#   2. tool worker        aetherion run --tool
#   3. API backend        this app.py              (:8765 — MinIO, Postgres, aetherion CLI)
#   4. ACT Studio UI      ui/ (Next.js)            (:3111 — proxies /api → :8765)
#
# ACT Studio is the ONLY UI: app.py's old built-in HTML page was removed, and
# GET :8765/ now redirects to the Studio.
#
# It first KILLS any already-running act workers / app.py so the restarted
# processes pick up your latest code (a long-running worker keeps the code it
# imported at startup -- this is what caused "stale worker" runs).
#
# The workers and the backend run in the background (logs under .run_logs/); the
# UI runs in the foreground, so Ctrl-C tears the whole stack down.
#
# The backend keeps port 8765 by default because that is what the ACT Recorder
# browser extension posts recordings to (http://localhost:8765/api/upload).
#
# Usage:  ./run.sh                 # backend :8765, Studio UI :3111
#         PORT=8780 ./run.sh       # override the backend port
#         UI_PORT=3200 ./run.sh    # override the UI port
#         UI=0 ./run.sh            # API only, in the foreground (no UI at all)
# ---------------------------------------------------------------------------
set -uo pipefail  # NOT -e: pkill returns non-zero when nothing matches, which is fine

HERE="$(cd "$(dirname "$0")" && pwd)"
ACT_AGENT_DIR="$(cd "${TEST_RUNNER_DIR:-$HERE/../act}" && pwd)"
AETHERION="$ACT_AGENT_DIR/.venv/bin/aetherion"
PY="$ACT_AGENT_DIR/.venv/bin/python"
PORT="${PORT:-8765}"              # API backend port (the extension's upload target)
UI_PORT="${UI_PORT:-3111}"        # Next.js Studio UI port
UI_DIR="$HERE/ui"
WANT_UI="${UI:-1}"
LOG_DIR="$HERE/.run_logs"
LOCAL_AETHERION_HOME="${TMPDIR:-/tmp}/agent_shubham_aetherion_home"
LOCAL_AETHERION_CFG_DIR="$LOCAL_AETHERION_HOME/.config/aetherion"
mkdir -p "$LOG_DIR"
mkdir -p "$LOCAL_AETHERION_CFG_DIR"
printf '{}\n' > "$LOCAL_AETHERION_CFG_DIR/config.json"

# ---- preflight -------------------------------------------------------------
for bin in "$AETHERION" "$PY"; do
  [ -x "$bin" ] || { echo "ERROR: not found/executable: $bin (run 'uv sync' in act)"; exit 1; }
done
if [ "$WANT_UI" != "0" ]; then
  [ -d "$UI_DIR" ] || { echo "ERROR: UI not found at $UI_DIR (use UI=0 to run without it)"; exit 1; }
  command -v npm >/dev/null 2>&1 || { echo "ERROR: npm not on PATH (use UI=0 to run without the UI)"; exit 1; }
fi

# ---- stop stale workers / backend, free the backend port -------------------
echo "==> Runner: $ACT_AGENT_DIR"
echo "==> Stopping any running ACT Agent workers / app.py ..."
# Long-running workers that hold stale code (NOT the short-lived 'aetherion agent' triggers).
pkill -f "$ACT_AGENT_DIR/.venv/bin/aetherion run" 2>/dev/null || true
pkill -f "shubham_agent/app.py" 2>/dev/null || true
# Free the backend port in case something else is still holding it.
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
  echo "==> Shutting down workers + backend ..."
  if [ "${#PIDS[@]}" -gt 0 ]; then
    for pid in "${PIDS[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
  fi
}
trap cleanup EXIT INT TERM

# ---- workers ---------------------------------------------------------------
echo "==> Starting ACT Agent worker  (logs: $LOG_DIR/agent.log)"
( cd "$ACT_AGENT_DIR" && exec env HOME="$LOCAL_AETHERION_HOME" "$AETHERION" run --agent ) >"$LOG_DIR/agent.log" 2>&1 &
PIDS+=("$!")

echo "==> Starting tool worker       (logs: $LOG_DIR/tool.log)"
( cd "$ACT_AGENT_DIR" && exec env HOME="$LOCAL_AETHERION_HOME" "$AETHERION" run --tool ) >"$LOG_DIR/tool.log" 2>&1 &
PIDS+=("$!")

# ---- no-UI mode: app.py in the foreground (the pre-Studio behavior) --------
if [ "$WANT_UI" = "0" ]; then
  echo "==> Starting API only (UI=0)   →  http://localhost:$PORT   (Ctrl-C stops all three)"
  echo "    tail the workers with:  tail -f $LOG_DIR/agent.log $LOG_DIR/tool.log"
  echo
  # Foreground (no exec) so the EXIT/INT trap fires and tears the workers down with it.
  HOME="$LOCAL_AETHERION_HOME" PORT="$PORT" "$PY" "$HERE/app.py"
  exit $?
fi

# ---- claim the UI port first, so the backend can be told where to redirect --
# (UI=0 already exited above, so the UI is definitely wanted here.)
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
for _ in $(seq 0 20); do
  port_free "$UI_PORT" && break
  echo "…UI port $UI_PORT busy, trying $((UI_PORT + 1))"
  UI_PORT=$((UI_PORT + 1))
done
export ACT_STUDIO_URL="http://localhost:$UI_PORT"

# ---- API backend (background, so the UI can own the foreground) ------------
echo "==> Starting API backend       →  http://localhost:$PORT   (logs: $LOG_DIR/backend.log)"
( exec env HOME="$LOCAL_AETHERION_HOME" PORT="$PORT" ACT_STUDIO_URL="$ACT_STUDIO_URL" \
    "$PY" "$HERE/app.py" ) >"$LOG_DIR/backend.log" 2>&1 &
PIDS+=("$!")

printf "==> Waiting for backend on :%s" "$PORT"
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "http://localhost:$PORT/api/config"; then echo "  ✓ up"; break; fi
  printf "."; sleep 1
done
if ! curl -sf -o /dev/null "http://localhost:$PORT/api/config"; then
  echo "  ⚠️  backend not responding — see $LOG_DIR/backend.log (MinIO :9000 / Postgres :5435 up?)"
fi

# ---- UI deps ---------------------------------------------------------------
cd "$UI_DIR"
[ -d node_modules ] || { echo "==> Installing UI deps (first run) ..."; npm install; }

# ---- Studio UI (foreground; Ctrl-C tears the whole stack down) -------------
export ACT_BACKEND_URL="http://localhost:$PORT"
echo
echo "▶  ACT Studio   → http://localhost:$UI_PORT   (proxies /api → :$PORT)"
echo "   API          → http://localhost:$PORT      (/ redirects to the Studio)"
echo "   tail logs:  tail -f $LOG_DIR/agent.log $LOG_DIR/tool.log $LOG_DIR/backend.log"
echo "   Ctrl-C stops the UI, the backend and both workers."
echo
npm run dev -- --port "$UI_PORT"
