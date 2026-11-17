#!/usr/bin/env bash
# QUAILS - Qualitative AI Labeling Support
# Linux launcher script

QUAILS_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$QUAILS_DIR"

echo "============================================"
echo "  QUAILS - Qualitative AI Labeling Support"
echo "============================================"
echo ""

# Architecture note: aarch64 (e.g. NVIDIA GB10 / DGX Spark / ASUS Ascent GX10) is supported.
# If Ollama runs as a systemd service there, QUAILS cannot restart it; tuned server
# settings are shown as copy-paste commands in AI Settings -> Hardware & performance.
ARCH="$(uname -m)"
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    echo "  Architecture: $ARCH (ARM64)"
    if command -v nvidia-smi &>/dev/null; then
        GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1)"
        [ -n "$GPU_NAME" ] && echo "  GPU: $GPU_NAME"
    fi
    echo ""
fi

# ------------------------------------------
# Detect python command
# ------------------------------------------
PYTHON_CMD=""
if command -v python3 &>/dev/null; then
    PYTHON_CMD="python3"
elif command -v python &>/dev/null; then
    PYTHON_CMD="python"
fi

# ------------------------------------------
# Check prerequisites
# ------------------------------------------
echo "[1/5] Checking prerequisites..."

if [ -z "$PYTHON_CMD" ]; then
    echo "  ERROR: Python is not installed or not on PATH."
    echo "         Install from https://www.python.org/downloads/"
    exit 1
fi

PYVER=$($PYTHON_CMD --version 2>&1 | cut -d' ' -f2)
PYMAJOR=$(echo "$PYVER" | cut -d. -f1)
PYMINOR=$(echo "$PYVER" | cut -d. -f2)
if [ "$PYMAJOR" -ne 3 ] || [ "$PYMINOR" -lt 10 ]; then
    echo "  ERROR: Python 3.10+ required, found $PYVER."
    echo "         Install from https://www.python.org/downloads/"
    exit 1
fi
echo "  Python $PYVER OK"

if ! command -v node &>/dev/null; then
    echo "  ERROR: Node.js is not installed or not on PATH."
    echo "         Install from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node --version 2>&1 | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ] 2>/dev/null; then
    # Node too old for Vite 7 — try fnm to get a newer version
    FNM_BIN="$HOME/.local/share/fnm/fnm"
    if [ -x "$FNM_BIN" ]; then
        echo "  Node $(node --version) is too old for Vite 7. Switching via fnm..."
        eval "$($FNM_BIN env --shell bash 2>/dev/null)" 2>/dev/null
        NODE_VERSION=$(node --version 2>&1 | sed 's/v//' | cut -d. -f1)
        if [ "$NODE_VERSION" -lt 20 ] 2>/dev/null; then
            echo "  WARNING: fnm loaded but Node is still $(node --version)."
            echo "           Run: fnm install 22 && fnm default 22"
        else
            echo "  fnm switched to Node $(node --version)"
        fi
    else
        echo "  WARNING: Node $(node --version) is too old for Vite 7."
        echo "           Install a newer Node.js (20+) or install fnm."
        echo "           Continuing anyway (may fail)..."
    fi
fi
echo "  node $(node --version) OK"

if command -v ollama &>/dev/null; then
    echo "  ollama OK"
else
    echo "  WARNING: Ollama not found — LLM features will not work."
    echo "           Download from https://ollama.com/download"
fi
echo ""

# ------------------------------------------
# Backend: create venv if needed, then install deps
# ------------------------------------------
echo "[2/5] Setting up backend..."
VENV_DIR="$QUAILS_DIR/backend/.venv"

if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating Python virtual environment..."
    if ! $PYTHON_CMD -m venv "$VENV_DIR"; then
        echo "  ERROR: Failed to create virtual environment."
        exit 1
    fi
fi

# Activate venv — sets pip/python to the isolated copies
source "$VENV_DIR/bin/activate"

echo "  Installing backend dependencies..."
if ! pip install -q -r "$QUAILS_DIR/backend/requirements.txt"; then
    echo "  ERROR: Failed to install Python packages."
    echo "         Check internet access or run: pip install -r backend/requirements.txt"
    exit 1
fi
echo "  Backend dependencies OK"
echo ""

# ------------------------------------------
# Frontend: install deps only when needed
# ------------------------------------------
echo "[3/5] Setting up frontend..."
cd "$QUAILS_DIR/frontend"

# Check if we need to install node_modules
if [ ! -d "node_modules" ]; then
    echo "  Installing frontend dependencies (first run, may take a minute)..."
    if ! npm install; then
        echo "  ERROR: Failed to install npm packages."
        echo "         Try: npm cache clean --force && npm install"
        exit 1
    fi
else
    # Sync quietly in case package.json changed but avoid excessive output
    echo "  Syncing frontend dependencies..."
    npm install --silent 2>/dev/null || true
fi

# Ensure esbuild native binary is installed (required by Vite on Linux)
if [ -f "node_modules/esbuild/install.js" ] && [ ! -f "node_modules/esbuild/bin/esbuild" ]; then
    echo "  Installing esbuild native binary..."
    node node_modules/esbuild/install.js 2>/dev/null
fi
echo "  Frontend dependencies OK"
echo ""

# ------------------------------------------
# Start Ollama if not already running
# ------------------------------------------
echo "[4/5] Checking Ollama..."
OLLAMA_PID=""
if curl -s http://localhost:11434/api/tags &>/dev/null; then
    echo "  Ollama already running."
elif command -v ollama &>/dev/null; then
    echo "  Starting Ollama..."
    # Apply server settings saved from AI Settings -> Hardware & performance
    # (backend/.env OLLAMA_SERVER_<VAR>=value -> exported as <VAR>=value).
    if [ -f backend/.env ]; then
        while IFS='=' read -r key value; do
            case "$key" in
                OLLAMA_SERVER_OLLAMA_*)
                    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
                    export "${key#OLLAMA_SERVER_}=$value"
                    echo "    ${key#OLLAMA_SERVER_}=$value"
                    ;;
            esac
        done < backend/.env
    fi
    ollama serve &>/dev/null &
    OLLAMA_PID=$!
    sleep 2
else
    echo "  Ollama not available — skipping."
fi
echo ""

# ------------------------------------------
# Cleanup on Ctrl+C / exit
# ------------------------------------------
cleanup() {
    echo ""
    echo "Shutting down QUAILS..."
    [ -n "$BACKEND_PID" ]  && kill "$BACKEND_PID"  2>/dev/null
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null
    [ -n "$OLLAMA_PID" ]   && kill "$OLLAMA_PID"   2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM

# ------------------------------------------
# Start backend
# ------------------------------------------
echo "[5/5] Starting QUAILS..."
cd "$QUAILS_DIR/backend"
$PYTHON_CMD app.py > "$QUAILS_DIR/backend/backend.log" 2>&1 &
BACKEND_PID=$!

# Poll until backend responds (up to 20s)
echo "  Waiting for backend..."
TRIES=0
until curl -s http://127.0.0.1:5174/api/about/ &>/dev/null; do
    sleep 1
    TRIES=$((TRIES + 1))
    if [ $TRIES -ge 20 ]; then
        echo "  ERROR: Backend did not start within 20s."
        echo "         Check backend/backend.log for details."
        cleanup
    fi
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo "  ERROR: Backend process crashed."
        echo "         Check backend/backend.log for details."
        exit 1
    fi
done
echo "  Backend running at http://127.0.0.1:5174"

# ------------------------------------------
# Start frontend with better error handling
# ------------------------------------------
cd "$QUAILS_DIR/frontend"
echo "  Starting frontend server..."
# Capture output to detect issues
FRONTEND_PID=""
npm run dev > /tmp/quails_frontend.log 2>&1 &
FRONTEND_PID=$!
sleep 3

# Verify frontend started
if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    echo "  ERROR: Frontend process failed to start properly."
    if [ -f /tmp/quails_frontend.log ]; then
        echo "  Frontend error details:"
        tail -10 /tmp/quails_frontend.log
    fi
    cleanup
fi

# Poll until Vite dev server responds (up to 30s)
echo "  Waiting for frontend to be ready..."
TRIES=0
until curl -s http://localhost:5173 &>/dev/null; do
    sleep 1
    TRIES=$((TRIES + 1))
    if [ $TRIES -ge 30 ]; then
        echo "  ERROR: Frontend did not start within 30s."
        echo "         Check /tmp/quails_frontend.log for details."
        cleanup
    fi
    # Check if process still running
    if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
        echo "  ERROR: Frontend process crashed immediately after startup."
        if [ -f /tmp/quails_frontend.log ]; then
            echo "  Frontend error details:"
            tail -10 /tmp/quails_frontend.log
        fi
        exit 1
    fi
done
echo "  Frontend running at http://localhost:5173"

# Open web browser
URL="http://localhost:5173"

if [ -n "$DISPLAY" ]; then
    echo "  Opening web interface at $URL..."
    if command -v sensible-browser &>/dev/null; then
        sensible-browser "$URL"
    elif command -v xdg-open &>/dev/null; then
        xdg-open "$URL"
    elif command -v firefox &>/dev/null; then
        firefox "$URL"
    elif command -v chromium-browser &>/dev/null; then
        chromium-browser "$URL"
    elif command -v google-chrome &>/dev/null; then
        google-chrome "$URL"
    else
        echo "  WARNING: No browser found. Open $URL manually."
    fi
else
    echo "  Open $URL in your browser."
fi

echo ""
echo "============================================"
echo "  QUAILS is running!"
echo ""
echo "  Open: http://localhost:5173"
echo ""
echo "  Press Ctrl+C to stop."
echo "============================================"
echo ""

# Keep script running  
wait