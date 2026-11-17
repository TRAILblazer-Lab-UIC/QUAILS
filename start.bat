@echo off
setlocal EnableExtensions
title QUAILS - Qualitative AI Labeling Support

rem ==========================================================================
rem  QUAILS one-click launcher and installer for Windows.
rem  Double-click this file. Works from any folder: no paths are hardcoded.
rem
rem  On each launch it:
rem    1. Checks for Python 3.10+, Node.js 20.19+/22.12+, npm, Git and Ollama
rem    2. Creates an isolated Python environment in backend\.venv (first run)
rem    3. Checks every package in backend\requirements.txt and installs only
rem       what is missing or outdated
rem    4. Installs frontend packages when package.json has changed
rem    5. Starts Ollama (if needed), the backend and the frontend, then opens
rem       your browser
rem ==========================================================================

set "QUAILS_DIR=%~dp0"
if "%QUAILS_DIR:~-1%"=="\" set "QUAILS_DIR=%QUAILS_DIR:~0,-1%"
set "BACKEND_DIR=%QUAILS_DIR%\backend"
set "FRONTEND_DIR=%QUAILS_DIR%\frontend"
set "LOG_DIR=%BACKEND_DIR%\logs"
set "TOOLS=%BACKEND_DIR%\launcher_tools.py"
set "VENV_DIR=%BACKEND_DIR%\.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
set "APP_URL=http://localhost:5173"
set "API_URL=http://127.0.0.1:5174/api/about/"
cd /d "%QUAILS_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo ============================================
echo   QUAILS - Qualitative AI Labeling Support
echo ============================================
echo.

rem ------------------------------------------
rem  1. Prerequisites
rem ------------------------------------------
echo [1/5] Checking prerequisites...

rem Python: prefer the "py" launcher, then python / python3. Each candidate is
rem actually run, which skips the Microsoft Store placeholder "python".
set "PY="
py -3 "%TOOLS%" check-python >nul 2>&1 && set "PY=py -3"
if not defined PY (python "%TOOLS%" check-python >nul 2>&1 && set "PY=python")
if not defined PY (python3 "%TOOLS%" check-python >nul 2>&1 && set "PY=python3")
if not defined PY goto :no_python
for /f "delims=" %%V in ('%PY% --version 2^>^&1') do echo   %%V OK

where node >nul 2>&1 || goto :no_node
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)"
if errorlevel 1 goto :old_node
where npm >nul 2>&1 || goto :no_node
for /f "delims=" %%V in ('node --version') do echo   Node.js %%V OK

where git >nul 2>&1 || goto :no_git
echo   Git OK

where ollama >nul 2>&1
if errorlevel 1 (
    echo   WARNING: Ollama not found. QUAILS will open, but analysis needs Ollama.
    echo            Download it from https://ollama.com/download
) else (
    echo   Ollama OK
)
echo.

rem Already running? Just open the browser.
%PY% "%TOOLS%" url-up "%API_URL%" >nul 2>&1 || goto :setup
%PY% "%TOOLS%" url-up "%APP_URL%" >nul 2>&1 || goto :setup
echo QUAILS is already running. Opening %APP_URL%
start "" "%APP_URL%"
timeout /t 3 /nobreak >nul
exit /b 0

:setup
rem ------------------------------------------
rem  2. Backend environment and requirements.txt
rem ------------------------------------------
echo [2/5] Setting up backend...

rem Recreate the environment if it is missing or broken (e.g. folder moved,
rem or Python was upgraded)
"%VENV_PY%" "%TOOLS%" check-python >nul 2>&1
if not errorlevel 1 goto :venv_ok
if exist "%VENV_DIR%" (
    echo   Rebuilding Python environment...
    rmdir /s /q "%VENV_DIR%"
)
echo   Creating Python environment ^(first run^)...
%PY% -m venv "%VENV_DIR%"
if errorlevel 1 goto :venv_fail
:venv_ok

echo   Checking packages in backend\requirements.txt...
"%VENV_PY%" "%TOOLS%" check-deps "%BACKEND_DIR%\requirements.txt"
if not errorlevel 1 goto :deps_ok
echo   Installing Python packages ^(this can take a few minutes the first time^)...
"%VENV_PY%" -m pip install --upgrade pip -q --disable-pip-version-check >nul 2>&1
"%VENV_PY%" -m pip install -q --disable-pip-version-check -r "%BACKEND_DIR%\requirements.txt"
if errorlevel 1 goto :pip_fail
"%VENV_PY%" "%TOOLS%" check-deps "%BACKEND_DIR%\requirements.txt"
if errorlevel 1 goto :pip_fail
:deps_ok
echo   Backend packages OK
echo.

rem ------------------------------------------
rem  3. Frontend packages
rem ------------------------------------------
echo [3/5] Setting up frontend...
"%VENV_PY%" "%TOOLS%" frontend-stale "%FRONTEND_DIR%"
if errorlevel 1 goto :frontend_ok
echo   Installing frontend packages ^(this can take a minute^)...
pushd "%FRONTEND_DIR%"
call npm install --no-fund --no-audit
if errorlevel 1 (
    popd
    goto :npm_fail
)
popd
:frontend_ok
echo   Frontend packages OK
echo.

rem ------------------------------------------
rem  4. Ollama
rem ------------------------------------------
echo [4/5] Checking Ollama...
"%VENV_PY%" "%TOOLS%" url-up "http://localhost:11434/api/tags"
if not errorlevel 1 (
    echo   Ollama already running.
    goto :ollama_done
)
where ollama >nul 2>&1
if errorlevel 1 (
    echo   Ollama not installed. Skipping.
    goto :ollama_done
)
echo   Starting Ollama...
start "Ollama" /min cmd /c "ollama serve"
"%VENV_PY%" "%TOOLS%" wait-url "http://localhost:11434/api/tags" 15
if errorlevel 1 echo   WARNING: Ollama did not respond yet.
:ollama_done
echo.

rem ------------------------------------------
rem  5. Start QUAILS
rem ------------------------------------------
echo [5/5] Starting QUAILS...
start "QUAILS Backend" /min /D "%BACKEND_DIR%" cmd /k ".venv\Scripts\python.exe app.py"
echo   Waiting for backend...
"%VENV_PY%" "%TOOLS%" wait-url "%API_URL%" 60
if errorlevel 1 goto :backend_fail
echo   Backend running at http://127.0.0.1:5174

start "QUAILS Frontend" /min /D "%FRONTEND_DIR%" cmd /k "npm run dev"
echo   Waiting for frontend...
"%VENV_PY%" "%TOOLS%" wait-url "%APP_URL%" 60
if errorlevel 1 goto :frontend_fail
echo   Frontend running at %APP_URL%

start "" "%APP_URL%"

echo.
echo ============================================
echo   QUAILS is running!
echo.
echo   Open: %APP_URL%
echo.
echo   QUAILS runs in two minimized windows,
echo   "QUAILS Backend" and "QUAILS Frontend".
echo   To stop, double-click stop.bat or close
echo   both windows.
echo ============================================
echo.
pause
exit /b 0

rem ------------------------------------------
rem  Errors
rem ------------------------------------------
:no_python
echo.
echo   ERROR: Python 3.10 or newer was not found.
echo          Install it from https://www.python.org/downloads/
echo          and check "Add python.exe to PATH" during installation.
goto :fail

:no_node
echo.
echo   ERROR: Node.js is not installed.
echo          Install the LTS version from https://nodejs.org/
goto :fail

:old_node
echo.
for /f "delims=" %%V in ('node --version') do echo   ERROR: Node.js %%V is too old. QUAILS needs Node.js 20.19+ or 22.12+.
echo          Install the LTS version from https://nodejs.org/
goto :fail

:no_git
echo.
echo   ERROR: Git is not installed ^(QUAILS uses it to version your projects^).
echo          Install it from https://git-scm.com/downloads
goto :fail

:venv_fail
echo.
echo   ERROR: Could not create a Python environment in backend\.venv
goto :fail

:pip_fail
echo.
echo   ERROR: Could not install the Python packages in backend\requirements.txt
echo          Check your internet connection and try again.
goto :fail

:npm_fail
echo.
echo   ERROR: Could not install frontend packages.
echo          Try: cd frontend, then npm cache clean --force, then npm install
goto :fail

:backend_fail
echo.
echo   ERROR: The backend did not start. Open the "QUAILS Backend" window
echo          on the taskbar to see the error.
goto :fail

:frontend_fail
echo.
echo   ERROR: The frontend did not start. Open the "QUAILS Frontend" window
echo          on the taskbar to see the error.
goto :fail

:fail
echo.
pause
exit /b 1
