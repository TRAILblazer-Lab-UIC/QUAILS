#!/usr/bin/env bash
# QUAILS - Qualitative AI Labeling Support
# Stops a running QUAILS instance so it can be reloaded cleanly during
# development. The Flask backend runs with use_reloader=False (see
# SAVESTATE.md Known Issues), so it never picks up code changes on its own —
# it must be killed and restarted after every backend edit. This script finds
# whatever is listening on the backend (:5174) and frontend (:5173) ports,
# regardless of how they were started (start.command, start.sh, or a
# manually-launched `python app.py` / `npm run dev`), and stops them.

echo "============================================"
echo "  Stopping QUAILS"
echo "============================================"
echo ""

stop_port() {
    local port="$1"
    local label="$2"
    local pids
    pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)
    if [ -z "$pids" ]; then
        echo "  $label (port $port): not running"
        return
    fi

    for pid in $pids; do
        kill "$pid" 2>/dev/null
    done
    sleep 1
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null
        fi
    done
    echo "  $label (port $port): stopped (pid $pids)"
}

stop_port 5174 "Backend"
stop_port 5173 "Frontend"

echo ""
echo "  Ollama left running (it may be shared with other apps) — stop it"
echo "  separately (e.g. \`pkill ollama\`) if you need to restart that too."
echo ""
echo "QUAILS stopped. Run ./start.command (or start.sh) to reload cleanly."
echo ""
