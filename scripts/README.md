# Operations scripts

## `Update-SnoHausAP.ps1`

One-command updater. Pulls the latest source from GitHub, downloads the matching
pre-built install zip from GitHub Actions, hash-verifies it, backs up the
current install, swaps in the new build, and restarts services.

### Prerequisites (one-time setup)

1. Local git checkout at `C:\snohaus-ap-git`
2. `gh` CLI authenticated:
   ```powershell
   winget install GitHub.cli
   gh auth login   # choose: github.com, HTTPS, browser
   ```

### Run it

Right-click PowerShell -> **Run as Administrator**, then:

```powershell
C:\snohaus-ap-git\scripts\Update-SnoHausAP.ps1
```

The script will:

1. `git pull` in `C:\snohaus-ap-git`
2. Show commits since your current install
3. Find the matching successful CI build
4. Prompt **Install? (Y/N)** with current vs new hash
5. Download + extract the artifact, verify hash
6. Stop services -> backup current `dist/` -> install new -> restart services
7. Confirm services are running

Keeps the last **3** `dist_backup_<timestamp>/` folders for rollback.

### Rollback

```powershell
Stop-Service SnoHausNgrok -Force -ErrorAction SilentlyContinue
Stop-Service SnoHausAP -Force
Remove-Item C:\snohaus-ap-windows\dist -Recurse -Force
Rename-Item C:\snohaus-ap-windows\dist_backup_<timestamp> dist
Start-Service SnoHausAP
Start-Service SnoHausNgrok
```

### Manual hash check (any time)

```powershell
Get-FileHash C:\snohaus-ap-windows\dist\index.cjs -Algorithm SHA256
```
