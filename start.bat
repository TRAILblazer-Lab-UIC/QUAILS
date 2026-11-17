@echo off
title QUAILS - Qualitative AI Labeling Support
color 0A

echo ============================================
echo   QUAILS - Qualitative AI Labeling Support
echo ============================================
echo.

:: Get the directory this script lives in
set "QUAILS_DIR=%~dp0"
cd /d "%QUAILS_DIR%"

:: ------------------------------------------
:: Check prerequisites
:: ------------------------------------------
echo [1/5] Checking prerequisites...

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python is not installed or not on PATH.
    echo        Download from https://www.python.org/downloads/
    echo        Make sure to check "Add Python to PATH" during install.
    pause
    exit /b 1
)

:: Validate Python version (requires 3.10+)
for /f "tokens=2 delims= " %%V in ('python --version 2^>^&1') do set "PYVER=%%V"
for /f "tokens=1,2 delims=." %%A in ("%PYVER%") do (
    set "PYMAJOR=%%A"
    set "PYMINOR=%%B"
)
if %PYMAJOR% neq 3 (
    echo ERROR: Python 3.10+ is required, but found Python %PYVER%.
    pause
    exit /b 1
)
if %PYMINOR% lss 10 (
    echo ERROR: Python 3.10+ is required, but found Python %PYVER%.
    echo        Download from https://www.python.org/downloads/
    pause
    exit /b 1
)

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not on PATH.
    echo        Download from https://nodejs.org/
    pause
    exit /b 1
)

where git >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Git is not installed or not on PATH.
    echo        Download from https://git-scm.com/downloads
    pause
    exit /b 1
)

echo        Python %PYVER% OK
echo        Node.js OK
echo        Git OK

:: Check for Ollama (warn but don't block)
where ollama >nul 2>&1
if %errorlevel% neq 0 (
    echo WARNING: Ollama not found on PATH. LLM features will not work.
    echo          Download from https://ollama.com/download
) else (
    echo        Ollama OK
)
echo.

:: ------------------------------------------
:: Install backend dependencies
:: ------------------------------------------
echo [2/5] Installing backend dependencies...
cd /d "%QUAILS_DIR%backend"

:: Always run pip install -- pip itself handles "already satisfied" quickly.
:: This guarantees every package in requirements.txt is present, even if
:: the user added new ones or some were partially installed before.
pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to install one or more Python packages.
    echo        Check the output above for details. Common fixes:
    echo          - Make sure you have internet access
    echo          - Try: python -m pip install --upgrade pip
    echo          - On older Python, some packages may need Visual C++ Build Tools
    pause
    exit /b 1
)
echo        Backend dependencies OK
echo.

:: ------------------------------------------
:: Install frontend dependencies
:: ------------------------------------------
echo [3/5] Installing frontend dependencies...
cd /d "%QUAILS_DIR%frontend"

:: Always run npm install -- npm handles "up to date" quickly when
:: node_modules already exists and package.json hasn't changed.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to install npm packages.
    echo        Check the output above for details. Common fixes:
    echo          - Make sure you have internet access
    echo          - Try: npm cache clean --force
    pause
    exit /b 1
)
echo        Frontend dependencies OK
echo.

:: ------------------------------------------
:: Start Ollama if not running
:: ------------------------------------------
echo [4/5] Checking Ollama...
curl -s http://localhost:11434/api/tags >nul 2>&1
if %errorlevel% neq 0 (
    where ollama >nul 2>&1
    if %errorlevel% equ 0 (
        echo        Starting Ollama...
        start /b "" ollama serve >nul 2>&1
        timeout /t 3 /nobreak >nul
    ) else (
        echo        Ollama not available - skipping.
    )
) else (
    echo        Ollama already running.
)
echo.

:: ------------------------------------------
:: Start backend and frontend
:: ------------------------------------------
echo [5/5] Starting QUAILS...
echo.
echo        Backend:  http://127.0.0.1:5174
echo        Frontend: http://localhost:5173
echo.
echo   Opening browser in 5 seconds...
echo   Press Ctrl+C in either window to stop.
echo.

:: Start backend in a new window
cd /d "%QUAILS_DIR%backend"
start "QUAILS Backend" cmd /k "title QUAILS Backend && color 0B && python app.py"

:: Wait for backend to start
timeout /t 3 /nobreak >nul

:: Start frontend in a new window
cd /d "%QUAILS_DIR%frontend"
start "QUAILS Frontend" cmd /k "title QUAILS Frontend && color 0D && npm run dev"

:: Wait then open browser
timeout /t 5 /nobreak >nul
start http://localhost:5173

echo ============================================
echo   QUAILS is running!
echo.
echo   Close the Backend and Frontend windows
echo   to stop the application.
echo ============================================
echo.
pause
