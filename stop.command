#!/usr/bin/env bash
# QUAILS one-click stopper for macOS: double-click this file in Finder.
cd "$(dirname "$0")" || exit 1
exec bash stop.sh
