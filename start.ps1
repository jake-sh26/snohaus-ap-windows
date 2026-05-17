# Sno-Haus AP Dashboard — PowerShell launcher
# Run with: powershell -ExecutionPolicy Bypass -File start.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  Sno-Haus AP Dashboard" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js is installed
try {
    $nodeVersion = node --version 2>&1
    Write-Host "Node.js $nodeVersion detected" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Node.js is not installed or not in your PATH." -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Node.js (v18 or newer) from:"
    Write-Host "  https://nodejs.org/en/download" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

# Check Node version
$major = ($nodeVersion -replace "v", "").Split(".")[0]
if ([int]$major -lt 18) {
    Write-Host "WARNING: Node.js $nodeVersion detected. v18 or newer is recommended." -ForegroundColor Yellow
    Write-Host "Download from https://nodejs.org/en/download" -ForegroundColor Yellow
    Write-Host ""
}

# Install dependencies if needed
if (-not (Test-Path "$ScriptDir\node_modules")) {
    Write-Host "Installing dependencies (first run only)..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: npm install failed." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "Dependencies installed." -ForegroundColor Green
    Write-Host ""
}

# Build if needed
if (-not (Test-Path "$ScriptDir\dist")) {
    Write-Host "Building application (first run only, ~30 seconds)..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Build failed." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "Build successful." -ForegroundColor Green
    Write-Host ""
}

# Open browser after 3 seconds (in background)
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 3
    Start-Process "http://localhost:5000"
} | Out-Null

Write-Host "Starting server..." -ForegroundColor Cyan
Write-Host ""
Write-Host "Dashboard URL: http://localhost:5000" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop."
Write-Host ""

npm start
