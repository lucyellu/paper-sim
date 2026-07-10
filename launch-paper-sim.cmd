@echo off
rem Launch Paper Sim: start the dev server if it isn't already running, then
rem open the app in the default browser. Safe to double-click repeatedly.
setlocal
set "APP=%~dp0app"
set "URL=http://localhost:5173/"

call :check
if not errorlevel 1 goto open

start "Paper Sim dev server" /min /d "%APP%" cmd /c "npm run dev"

rem Wait up to ~30s for the server to come up.
for /l %%i in (1,1,30) do (
  call :check
  if not errorlevel 1 goto open
  ping -n 2 127.0.0.1 >nul
)
echo The dev server did not start - check the "Paper Sim dev server" window.
pause
exit /b 1

:open
start "" %URL%
exit /b 0

:check
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing %URL% -TimeoutSec 2) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
exit /b %errorlevel%
