@echo off
setlocal EnableExtensions
title Stopping QUAILS

rem QUAILS one-click stopper for Windows: double-click this file.
rem Stops the backend (port 5174) and frontend (port 5173). Ollama is left running.

echo ============================================
echo   Stopping QUAILS
echo ============================================
echo.

for %%P in (5174 5173) do (
    for /f "tokens=5" %%I in ('netstat -ano ^| findstr /C:":%%P " ^| findstr LISTENING') do (
        taskkill /F /T /PID %%I >nul 2>&1
    )
)
taskkill /F /T /FI "WINDOWTITLE eq QUAILS Backend*" >nul 2>&1
taskkill /F /T /FI "WINDOWTITLE eq QUAILS Frontend*" >nul 2>&1

echo   QUAILS stopped.
echo.
echo   Ollama was left running (other apps may use it).
echo   Quit it from its tray icon if you want to stop it too.
echo.
timeout /t 5
