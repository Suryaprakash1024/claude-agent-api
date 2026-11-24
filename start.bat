@echo off
REM ---------------------------------------------------------------
REM  claude-agent-api launcher
REM  Double-click to start with defaults, or pass any start flags:
REM    start.bat --port 4242 --model sonnet --agent --verbose
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"
title claude-agent-api

where node >nul 2>nul
if errorlevel 1 (
  echo [claude-agent-api] Node.js was not found. Install Node.js 22.18 or later from https://nodejs.org
  goto :fail
)

if not exist "node_modules\" (
  echo [claude-agent-api] Installing dependencies...
  call npm install
  if errorlevel 1 goto :fail
)

echo [claude-agent-api] Building...
call npm run build --silent
if errorlevel 1 goto :fail

echo [claude-agent-api] Starting server. Press Ctrl+C to stop.
node dist\main.js start %*
if errorlevel 1 (
  echo.
  echo [claude-agent-api] Server stopped with exit code %errorlevel%.
  pause
  exit /b %errorlevel%
)
goto :eof

:fail
echo.
echo [claude-agent-api] Failed to start. See the messages above.
pause
exit /b 1
