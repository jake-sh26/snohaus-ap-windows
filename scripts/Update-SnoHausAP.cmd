@echo off
:: One-click launcher for the Sno-Haus AP updater.
:: Self-elevates to admin (triggers UAC), then runs Update-SnoHausAP.ps1.
:: Keeps the window open at the end so you can read the result.

setlocal

:: Check for admin rights; if not admin, re-launch self elevated.
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-SnoHausAP.ps1"

echo.
echo Press any key to close...
pause >nul
