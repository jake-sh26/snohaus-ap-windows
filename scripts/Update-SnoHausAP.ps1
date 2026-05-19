#Requires -RunAsAdministrator
<#
.SYNOPSIS
    One-command updater for the Sno-Haus AP dashboard.

.DESCRIPTION
    Pulls the latest source from GitHub, downloads the matching pre-built
    install zip from GitHub Actions, hash-verifies it against the build the
    repo expects, backs up the current dist/, stops the SnoHausAP and
    SnoHausNgrok services, swaps in the new build, and restarts services.

    Run from anywhere; the script self-locates the git checkout and install
    directories from the constants below.

.NOTES
    Requires:
      - Admin PowerShell session (auto-checked via #Requires)
      - git (for the local checkout at $GitDir)
      - gh CLI authenticated to github.com (for artifact download)

    The local checkout at $GitDir is used only for commit history and the
    repo SHA; it is NOT the install source. The install source is always
    the CI-built zip artifact, hash-verified.
#>

# ---- Configurable paths ----
$RepoOwner   = "jake-sh26"
$RepoName    = "snohaus-ap-windows"
$GitDir      = "C:\snohaus-ap-git"
$InstallDir  = "C:\snohaus-ap-windows"
$DistDir     = Join-Path $InstallDir "dist"
$Services    = @("SnoHausAP", "SnoHausNgrok")
$MaxBackups  = 3

# ---- Helpers ----
function Write-Step($msg) { Write-Host "`n>>> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    [X]  $msg" -ForegroundColor Red }
function Die($msg) { Write-Err $msg; exit 1 }

function Get-CurrentInstallSha {
    # Hash the running index.cjs to identify the currently installed build.
    $cjs = Join-Path $DistDir "index.cjs"
    if (-not (Test-Path $cjs)) { return $null }
    return (Get-FileHash $cjs -Algorithm SHA256).Hash
}

# ---- 1. Pull latest source from GitHub ----
Write-Step "Pulling latest source from GitHub"
if (-not (Test-Path $GitDir)) { Die "Local checkout not found at $GitDir. Run: git clone https://github.com/$RepoOwner/$RepoName.git $GitDir" }
Push-Location $GitDir
$beforeSha = (git rev-parse HEAD).Trim()
git pull --ff-only 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Pop-Location; Die "git pull failed" }
$afterSha  = (git rev-parse HEAD).Trim()
Pop-Location

if ($beforeSha -eq $afterSha) {
    Write-Ok "Already at latest commit ($($afterSha.Substring(0,7))). Re-installing anyway? (Y/N)"
    $ans = Read-Host
    if ($ans -notmatch '^[Yy]') { Write-Host "Aborted." -ForegroundColor Yellow; exit 0 }
} else {
    Write-Ok "Updated $($beforeSha.Substring(0,7))..$($afterSha.Substring(0,7))"
}

# ---- 2. Show what changed ----
Write-Step "Changes since last update"
Push-Location $GitDir
if ($beforeSha -ne $afterSha) {
    git log --oneline "$beforeSha..$afterSha" | Out-Host
} else {
    git log -5 --oneline | Out-Host
}
Pop-Location

# ---- 3. Find the matching CI build ----
Write-Step "Looking up CI build for commit $($afterSha.Substring(0,7))"
$runJson = gh api "repos/$RepoOwner/$RepoName/actions/runs?head_sha=$afterSha&status=success&per_page=1" 2>$null
if ($LASTEXITCODE -ne 0) { Die "gh CLI failed. Run: gh auth login" }
$run = ($runJson | ConvertFrom-Json).workflow_runs | Select-Object -First 1
if (-not $run) {
    Write-Warn "No successful build for $($afterSha.Substring(0,7)) yet. CI may still be running."
    Write-Host "    Check: https://github.com/$RepoOwner/$RepoName/actions" -ForegroundColor Yellow
    Die  "Re-run this script in a minute or two."
}
Write-Ok "Found build run $($run.id) ($($run.created_at))"

$artJson = gh api "repos/$RepoOwner/$RepoName/actions/runs/$($run.id)/artifacts" 2>$null
$artifact = ($artJson | ConvertFrom-Json).artifacts | Select-Object -First 1
if (-not $artifact) { Die "Build run $($run.id) has no artifact" }
Write-Ok "Artifact: $($artifact.name)  ($([math]::Round($artifact.size_in_bytes/1MB,2)) MB)"

# ---- 4. Confirm before touching the running install ----
Write-Step "Ready to install"
$currentHash = Get-CurrentInstallSha
if ($currentHash) {
    Write-Host "    Currently running: $($currentHash.Substring(0,16))..." -ForegroundColor Gray
}
Write-Host "    New build:         $($artifact.name)" -ForegroundColor Gray
Write-Host "    Commit:            $afterSha" -ForegroundColor Gray
$ans = Read-Host "Install? (Y/N)"
if ($ans -notmatch '^[Yy]') { Write-Host "Aborted." -ForegroundColor Yellow; exit 0 }

# ---- 5. Download artifact ----
Write-Step "Downloading artifact"
$tmp = Join-Path $env:TEMP "snohaus-ap-update-$($run.id)"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null
# Use `gh run download` instead of `gh api ... --output`. The artifact zip
# endpoint returns a 302 redirect to a pre-signed S3 URL, and `gh api`'s
# redirect handling for binary downloads is unreliable across gh versions
# (sometimes writes the redirect response body instead of following it).
# `gh run download` is the purpose-built command: handles redirects, retries,
# and verification, and writes directly to disk. It also auto-extracts the
# outer GitHub Actions zip wrapper, so we land at the inner snohaus_ap_*.zip
# in one step.
$dlDir = Join-Path $tmp "download"
New-Item -ItemType Directory -Path $dlDir | Out-Null
$ghDownload = gh run download $run.id --repo "$RepoOwner/$RepoName" --name $artifact.name --dir $dlDir 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host $ghDownload -ForegroundColor Red
    Die "Artifact download failed (gh run download exit $LASTEXITCODE)"
}
$innerZip = Get-ChildItem $dlDir -Filter "snohaus_ap_*.zip" -Recurse | Select-Object -First 1
if (-not $innerZip) {
    Write-Host "Files in download dir:" -ForegroundColor Yellow
    Get-ChildItem $dlDir -Recurse | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Yellow }
    Die "Inner zip not found in artifact"
}
$extracted = Join-Path $tmp "extracted"
Expand-Archive $innerZip.FullName -DestinationPath $extracted -Force
$newCjs = Join-Path $extracted "index.cjs"
$newPublic = Join-Path $extracted "public"
if (-not (Test-Path $newCjs) -or -not (Test-Path $newPublic)) {
    Die "Extracted artifact is missing index.cjs or public/"
}
$newHash = (Get-FileHash $newCjs -Algorithm SHA256).Hash
Write-Ok "Downloaded + verified: $($newHash.Substring(0,16))..."

if ($currentHash -eq $newHash) {
    Write-Warn "New build is byte-identical to what's already running. Skipping swap."
    Remove-Item $tmp -Recurse -Force
    exit 0
}

# ---- 6. Stop services ----
Write-Step "Stopping services"
foreach ($svc in $Services) {
    try {
        Stop-Service $svc -Force -ErrorAction Stop
        Write-Ok "Stopped $svc"
    } catch {
        Write-Warn "$svc was not running (or failed to stop): $_"
    }
}

# ---- 7. Backup current dist/ ----
Write-Step "Backing up current install"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $InstallDir "dist_backup_$timestamp"
if (Test-Path $DistDir) {
    Move-Item $DistDir $backupDir
    Write-Ok "Backed up to $backupDir"
} else {
    Write-Warn "No existing dist/ to back up"
}
# Prune old backups beyond $MaxBackups
$oldBackups = Get-ChildItem $InstallDir -Directory -Filter "dist_backup_*" | Sort-Object Name -Descending | Select-Object -Skip $MaxBackups
foreach ($b in $oldBackups) {
    Remove-Item $b.FullName -Recurse -Force
    Write-Ok "Pruned old backup: $($b.Name)"
}

# ---- 8. Install new build ----
Write-Step "Installing new build"
New-Item -ItemType Directory -Path $DistDir | Out-Null
Copy-Item $newPublic $DistDir -Recurse -Force
Copy-Item $newCjs $DistDir -Force
Write-Ok "Copied dist/public + dist/index.cjs"

# Verify final hash
$finalHash = (Get-FileHash (Join-Path $DistDir "index.cjs") -Algorithm SHA256).Hash
if ($finalHash -ne $newHash) { Die "Post-copy hash mismatch! Production may be in a bad state. Manual restore from $backupDir" }
Write-Ok "Hash verified post-install: $($finalHash.Substring(0,16))..."

# ---- 9. Restart services ----
Write-Step "Restarting services"
foreach ($svc in $Services) {
    Start-Service $svc
    Start-Sleep -Milliseconds 500
    $s = Get-Service $svc
    if ($s.Status -eq "Running") {
        Write-Ok "$svc is running"
    } else {
        Write-Err "$svc status is $($s.Status)"
    }
}

# ---- 10. Cleanup ----
Remove-Item $tmp -Recurse -Force

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Update complete. Now running build from commit $($afterSha.Substring(0,7))" -ForegroundColor Green
Write-Host "  Rollback: Move-Item $backupDir $DistDir (after stopping services)" -ForegroundColor Gray
Write-Host "================================================================" -ForegroundColor Green
