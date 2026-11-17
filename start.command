#!/usr/bin/env bash
# QUAILS one-click launcher for macOS: double-click this file in Finder.
# All setup logic lives in start.sh.
cd "$(dirname "$0")" || exit 1
exec bash start.sh "$@"
