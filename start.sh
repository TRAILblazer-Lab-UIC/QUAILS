#!/usr/bin/env bash
# QUAILS - Qualitative AI Labeling Support
# One-click launcher and installer for macOS and Linux.
#
# Double-click start.command (macOS) or start_linux.sh (Linux), or run
# ./start.sh from a terminal. Works from any folder: no paths are hardcoded.
#
# On each launch it:
#   1. Checks for Python 3.10+, Node.js 20.19+/22.12+, npm, Git and Ollama
#   2. Creates an isolated Python environment in backend/.venv (first run)
#   3. Checks every package in backend/requirements.txt and installs only
#      what is missing or outdated
#   4. Installs frontend packages when package.json has changed
#   5. Starts Ollama (if needed), the backend and the frontend, then opens
#      your browser

QUAILS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$QUAILS_DIR/backend"
FRONTEND_DIR="$QUAILS_DIR/frontend"
LOG_DIR="$BACKEND_DIR/logs"
TOOLS="$BACKEND_DIR/launcher_tools.py"
APP_URL="http://localhost:5173"
API_URL="http://127.0.0.1:5174/api/about/"
cd "$QUAILS_DIR" || exit 1
mkdir -p "$LOG_DIR"

OS_NAME="$(uname -s)"

fail() {
    echo ""
    echo "  ERROR: $1"
    [ -n "$2" ] && echo "         $2"
    echo ""
    # Keep a double-clicked terminal window open so the message can be read
    if [ -t 0 ]; then read -r -p "Press Enter to close..." _; fi
    exit 1
}

open_browser() {
    if [ "$OS_NAME" = "Darwin" ]; then
        open "$1"
    elif command -v xdg-open &>/dev/null; then
        xdg-open "$1" &>/dev/null &
    elif command -v sensible-browser &>/dev/null; then
        sensible-browser "$1" &>/dev/null &
    else
        echo "  Open $1 in your browser."
    fi
}

echo "============================================"
echo "  QUAILS - Qualitative AI Labeling Support"
echo "============================================"
echo ""

# ------------------------------------------
# 1. Prerequisites
# ------------------------------------------
echo "[1/5] Checking prerequisites..."

if [ "$OS_NAME" = "Linux" ]; then
    ARCH="$(uname -m)"
    echo "  Architecture: $ARCH"
    if command -v nvidia-smi &>/dev/null; then
        GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1)"
        [ -n "$GPU_NAME" ] && echo "  GPU: $GPU_NAME"
    fi
fi

# Python: use the first interpreter on PATH that is 3.10 or newer
PYTHON_CMD=""
for candidate in python3 python3.14 python3.13 python3.12 python3.11 python3.10 python; do
    if command -v "$candidate" &>/dev/null && "$candidate" "$TOOLS" check-python 2>/dev/null; then
        PYTHON_CMD="$(command -v "$candidate")"
        break
    fi
done
[ -z "$PYTHON_CMD" ] && fail "Python 3.10 or newer was not found." \
    "Install it from https://www.python.org/downloads/ and run this launcher again."
echo "  Python $("$PYTHON_CMD" --version 2>&1 | cut -d' ' -f2) OK"

# Node.js: Vite 7 needs 20.19+ or 22.12+
NODE_CHECK='const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)'
node_ok() { command -v node &>/dev/null && node -e "$NODE_CHECK" 2>/dev/null; }
if ! node_ok; then
    # Try fnm or nvm if the user has one installed
    for FNM_BIN in "$(command -v fnm 2>/dev/null)" "$HOME/.local/share/fnm/fnm" "$HOME/.fnm/fnm"; do
        if [ -n "$FNM_BIN" ] && [ -x "$FNM_BIN" ]; then
            eval "$("$FNM_BIN" env --shell bash 2>/dev/null)" 2>/dev/null
            break
        fi
    done
    if ! node_ok && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
        # shellcheck disable=SC1091
        . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1
        nvm use --lts >/dev/null 2>&1
    fi
fi
if ! node_ok; then
    if command -v node &>/dev/null; then
        fail "Node.js $(node --version) is too old. QUAILS needs Node.js 20.19+ or 22.12+." \
            "Install the LTS version from https://nodejs.org/ and run this launcher again."
    fi
    fail "Node.js is not installed." "Install the LTS version from https://nodejs.org/"
fi
command -v npm &>/dev/null || fail "npm was not found." "Reinstall Node.js from https://nodejs.org/"
echo "  Node.js $(node --version) OK"

command -v git &>/dev/null || fail "Git is not installed (QUAILS uses it to version your projects)." \
    "macOS: run 'xcode-select --install'. Linux: install the 'git' package. Or see https://git-scm.com/downloads"
echo "  Git $(git --version | awk '{print $3}') OK"

if command -v ollama &>/dev/null; then
    echo "  Ollama OK"
else
    echo "  WARNING: Ollama not found. QUAILS will open, but analysis needs Ollama."
    echo "           Download it from https://ollama.com/download"
fi
echo ""

# Already running? Just open the browser.
if "$PYTHON_CMD" "$TOOLS" url-up "$API_URL" && "$PYTHON_CMD" "$TOOLS" url-up "$APP_URL"; then
    echo "QUAILS is already running. Opening $APP_URL"
    open_browser "$APP_URL"
    exit 0
fi

# ------------------------------------------
# 2. Backend environment and requirements.txt
# ------------------------------------------
echo "[2/5] Setting up backend..."
VENV_DIR="$BACKEND_DIR/.venv"
VENV_PY="$VENV_DIR/bin/python"

# Recreate the environment if it is missing or broken (e.g. folder moved,
# or Python was upgraded)
if ! "$VENV_PY" "$TOOLS" check-python &>/dev/null; then
    [ -d "$VENV_DIR" ] && echo "  Rebuilding Python environment..." && rm -rf "$VENV_DIR"
    echo "  Creating Python environment (first run)..."
    "$PYTHON_CMD" -m venv "$VENV_DIR" || fail "Could not create a Python environment." \
        "On Debian/Ubuntu, install it with: sudo apt install python3-venv"
fi

echo "  Checking packages in backend/requirements.txt..."
if ! "$VENV_PY" "$TOOLS" check-deps "$BACKEND_DIR/requirements.txt"; then
    echo "  Installing Python packages (this can take a few minutes the first time)..."
    "$VENV_PY" -m pip install --upgrade pip -q --disable-pip-version-check >/dev/null 2>&1
    "$VENV_PY" -m pip install -q --disable-pip-version-check -r "$BACKEND_DIR/requirements.txt" \
        || fail "Could not install Python packages." "Check your internet connection and try again."
    "$VENV_PY" "$TOOLS" check-deps "$BACKEND_DIR/requirements.txt" \
        || fail "Some Python packages are still missing after installing."
fi
echo "  Backend packages OK"
echo ""

# ------------------------------------------
# 3. Frontend packages
# ------------------------------------------
echo "[3/5] Setting up frontend..."
if "$VENV_PY" "$TOOLS" frontend-stale "$FRONTEND_DIR"; then
    echo "  Installing frontend packages (this can take a minute)..."
    (cd "$FRONTEND_DIR" && npm install --no-fund --no-audit) \
        || fail "Could not install frontend packages." "Try: cd frontend && npm cache clean --force && npm install"
fi
# Vite on Linux needs esbuild's native binary
if [ -f "$FRONTEND_DIR/node_modules/esbuild/install.js" ] && [ ! -f "$FRONTEND_DIR/node_modules/esbuild/bin/esbuild" ]; then
    (cd "$FRONTEND_DIR" && node node_modules/esbuild/install.js >/dev/null 2>&1)
fi
echo "  Frontend packages OK"
echo ""

# ------------------------------------------
# 4. Ollama
# ------------------------------------------
echo "[4/5] Checking Ollama..."
OLLAMA_PID=""
if "$VENV_PY" "$TOOLS" url-up "http://localhost:11434/api/tags"; then
    echo "  Ollama already running."
elif command -v ollama &>/dev/null; then
    echo "  Starting Ollama..."
    # Apply server settings saved in AI Settings -> Hardware & performance
    # (backend/.env OLLAMA_SERVER_<VAR>=value is exported as <VAR>=value)
    if [ -f "$BACKEND_DIR/.env" ]; then
        while IFS='=' read -r key value; do
            case "$key" in
                OLLAMA_SERVER_OLLAMA_*)
                    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
                    export "${key#OLLAMA_SERVER_}=$value"
                    echo "    ${key#OLLAMA_SERVER_}=$value"
                    ;;
            esac
        done < "$BACKEND_DIR/.env"
    fi
    ollama serve >"$LOG_DIR/ollama.log" 2>&1 &
    OLLAMA_PID=$!
    "$VENV_PY" "$TOOLS" wait-url "http://localhost:11434/api/tags" 15 \
        || echo "  WARNING: Ollama did not respond yet. See backend/logs/ollama.log"
else
    echo "  Ollama not installed. Skipping."
fi
echo ""

# ------------------------------------------
# 5. Start QUAILS
# ------------------------------------------
cleanup() {
    echo ""
    echo "Shutting down QUAILS..."
    [ -n "$BACKEND_PID" ]  && kill "$BACKEND_PID"  2>/dev/null
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null
    [ -n "$OLLAMA_PID" ]   && kill "$OLLAMA_PID"   2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM SIGHUP

echo "[5/5] Starting QUAILS..."
(cd "$BACKEND_DIR" && exec "$VENV_PY" app.py) >"$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo "  Waiting for backend..."
if ! "$VENV_PY" "$TOOLS" wait-url "$API_URL" 60; then
    tail -n 15 "$LOG_DIR/backend.log"
    kill "$BACKEND_PID" 2>/dev/null
    fail "The backend did not start." "See backend/logs/backend.log for details."
fi
echo "  Backend running at http://127.0.0.1:5174"

(cd "$FRONTEND_DIR" && exec npm run dev) >"$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!
echo "  Waiting for frontend..."
if ! "$VENV_PY" "$TOOLS" wait-url "$APP_URL" 60; then
    tail -n 15 "$LOG_DIR/frontend.log"
    kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
    fail "The frontend did not start." "See backend/logs/frontend.log for details."
fi
echo "  Frontend running at $APP_URL"

# Linux: add QUAILS to the applications menu, pointing at this folder
if [ "$OS_NAME" = "Linux" ] && [ -d "$HOME/.local/share" ]; then
    APPS_DIR="$HOME/.local/share/applications"
    DESKTOP_FILE="$APPS_DIR/quails.desktop"
    if ! grep -qF "Exec=\"$QUAILS_DIR/start_linux.sh\"" "$DESKTOP_FILE" 2>/dev/null; then
        mkdir -p "$APPS_DIR"
        cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=QUAILS
Comment=Qualitative AI Labeling Support
Exec="$QUAILS_DIR/start_linux.sh"
Path=$QUAILS_DIR
Icon=$QUAILS_DIR/logo.png
Terminal=true
Categories=Education;Science;
StartupNotify=true
EOF
        chmod +x "$DESKTOP_FILE"
        echo "  Added QUAILS to your applications menu."
    fi
fi

open_browser "$APP_URL"

echo ""
echo "============================================"
echo "  QUAILS is running!"
echo ""
echo "  Open: $APP_URL"
echo ""
echo "  Keep this window open while you use QUAILS."
echo "  Press Ctrl+C (or close this window) to stop."
echo "============================================"
echo ""

wait "$BACKEND_PID"
cleanup
