<#
.SYNOPSIS
    Creates a desktop shortcut for the Sno-Haus AP updater.

.DESCRIPTION
    Drops "Update Sno-Haus AP.lnk" on your desktop. Double-click it to run the
    updater (which self-elevates to admin via UAC).

    Run this script ONCE. After that the shortcut just sits on your desktop.

.NOTES
    No admin required for the shortcut creation itself.
#>

$ErrorActionPreference = "Stop"

$target  = Join-Path $PSScriptRoot "Update-SnoHausAP.cmd"
if (-not (Test-Path $target)) {
    Write-Host "ERROR: $target not found. Run 'git pull' in C:\snohaus-ap-git first." -ForegroundColor Red
    exit 1
}

$desktop  = [Environment]::GetFolderPath("Desktop")
$shortcut = Join-Path $desktop "Update Sno-Haus AP.lnk"

$wsh   = New-Object -ComObject WScript.Shell
$link  = $wsh.CreateShortcut($shortcut)
$link.TargetPath        = $target
$link.WorkingDirectory  = $PSScriptRoot
$link.IconLocation      = "powershell.exe,0"
$link.Description       = "Update Sno-Haus AP dashboard from GitHub"
$link.Save()

Write-Host "Created: $shortcut" -ForegroundColor Green
Write-Host ""
Write-Host "Double-click it to update. UAC will prompt for admin." -ForegroundColor Cyan
