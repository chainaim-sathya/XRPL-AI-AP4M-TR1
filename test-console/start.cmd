@echo off
rem ChainAim local test console. Starts the four test containers and the
rem tenant's own Presidio ("presidio", 127.0.0.1:5002, used by the buyer agent's
rem prompt masking), waits for the gateway, then serves http://127.0.0.1:8730.
rem Closing this window stops the console; the containers keep running until
rem "docker stop" or a Docker restart.
title ChainAim test console
docker start ca-presidio ca-openrouter-stub ca-gateway ca-paywall presidio >nul
if errorlevel 1 (
  echo Docker could not start the test containers. Is Docker Desktop running?
  pause
  exit /b 1
)
echo Waiting for the gateway (Presidio can take a minute after Docker starts)...
set tries=0
:wait
curl -sf -o nul http://127.0.0.1:8720/healthz && goto ready
set /a tries+=1
if %tries% geq 90 (
  echo The gateway is not answering yet, so the page will show errors until it does.
  goto ready
)
ping -n 3 127.0.0.1 >nul
goto wait
:ready
node "%~dp0console\server.ts"
pause
