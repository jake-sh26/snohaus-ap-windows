@echo off
REM ============================================================
REM   Sno-Haus AP - start.bat
REM   Launches the AP server + ngrok tunnel for QBO webhooks.
REM ============================================================

title Sno-Haus AP Launcher

REM Hardcoded path so this works no matter where the .bat is launched from.
cd /d C:\snohaus-ap-windows

if not exist "dist\index.cjs" (
  echo [ERROR] Could not find dist\index.cjs in C:\snohaus-ap-windows
  echo Make sure the app is installed there and the dist folder is present.
  pause
  exit /b 1
)

echo ============================================================
echo  Starting Sno-Haus AP server...
echo ============================================================
echo.
echo  - Server window will open (port 5000)
echo  - Output will be written to C:\snohaus-ap-windows\server.log
echo  - Close the server window to stop it
echo.
echo  URL:        http://localhost:5000
echo  Public URL: https://disabled-drizzle-unplowed.ngrok-free.dev
echo.

REM ---- Start the server in its own PowerShell window with tee to server.log ----
start "Sno-Haus AP Server" powershell -NoExit -Command ^
  "$env:NODE_ENV='production'; cd 'C:\snohaus-ap-windows'; Write-Host 'Sno-Haus AP Server starting on port 5000...' -ForegroundColor Green; node dist/index.cjs 2>&1 | Tee-Object -FilePath 'C:\snohaus-ap-windows\server.log'"

REM ---- Start ngrok tunnel in its own window ----
REM ngrok config already has the authtoken + reserved domain, so a plain
REM `ngrok http 5000 --domain=...` is all we need. Domain stays the same forever
REM so QBO webhook URL on Intuit's side never has to change.
if exist "C:\snohaus-ap-windows\ngrok.exe" (
  echo Starting ngrok tunnel...
  REM Kill any existing ngrok so the reserved domain is free to bind.
  taskkill /IM ngrok.exe /F >nul 2>&1
  REM Launch ngrok in its own minimized window. Closing it stops the tunnel.
  start "Sno-Haus ngrok" /MIN "C:\snohaus-ap-windows\ngrok.exe" http --domain=disabled-drizzle-unplowed.ngrok-free.dev 5000
  echo   ngrok running in minimized window.
  echo   Web UI: http://127.0.0.1:4040
) else (
  echo [WARN] ngrok.exe not found at C:\snohaus-ap-windows\ngrok.exe - skipping tunnel.
  echo        QBO webhooks will not work without it. Drop ngrok.exe in that folder
  echo        and re-run start.bat.
)
echo.

REM Give server a few seconds to bind, then open the browser.
timeout /t 3 /nobreak > nul
start "" http://localhost:5000

echo.
echo Launcher done. You can close THIS window now.
echo.
echo To stop everything: close the Sno-Haus AP Server window and the ngrok window
echo (or run: taskkill /IM ngrok.exe /F  and  taskkill /IM node.exe /F)
echo.
timeout /t 5 /nobreak > nul
exit /b 0
