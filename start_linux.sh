#!/usr/bin/env bash
# QUAILS one-click launcher for Linux.
# Double-click this file (choose "Run" or "Run in Terminal"), or run
# ./start_linux.sh from a terminal. On first run it also adds QUAILS to your
# applications menu. All setup logic lives in start.sh.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
if [ ! -t 1 ]; then
    # Launched without a terminal: reopen in one so progress is visible
    for term in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do
        if command -v "$term" &>/dev/null; then
            case "$term" in
                gnome-terminal) exec gnome-terminal -- bash "$PWD/start.sh" ;;
                *)              exec "$term" -e bash "$PWD/start.sh" ;;
            esac
        fi
    done
fi
exec bash start.sh "$@"
