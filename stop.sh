#!/usr/bin/env bash
# QUAILS - Qualitative AI Labeling Support
# Stops a running QUAILS instance (backend on port 5174, frontend on 5173),
# however it was started. Ollama is left running.

echo "============================================"
echo "  Stopping QUAILS"
echo "============================================"
echo ""

pids_on_port() {
    if command -v lsof &>/dev/null; then
        lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null
    elif command -v fuser &>/dev/null; then
        fuser "$1"/tcp 2>/dev/null
    elif command -v ss &>/dev/null; then
        ss -ltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2
    fi
}

stop_port() {
    local port="$1" label="$2" pids
    pids=$(pids_on_port "$port" | tr '\n' ' ')
    if [ -z "${pids// }" ]; then
        echo "  $label (port $port): not running"
        return
    fi
    for pid in $pids; do kill "$pid" 2>/dev/null; done
    sleep 1
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null; done
    echo "  $label (port $port): stopped"
}

stop_port 5174 "Backend"
stop_port 5173 "Frontend"

echo ""
echo "  Ollama was left running (other apps may use it)."
echo "  Quit it from its menu-bar/tray icon if you want to stop it too."
echo ""
