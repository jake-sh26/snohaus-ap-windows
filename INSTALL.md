# Sno-Haus AP — Combined Patch Installation

## On the production PC (currently running v[old]):

1. Stop the AP server:
   nssm stop SnoHausAP

2. Backup current:
   Copy-Item C:\snohaus-ap-windows\dist C:\snohaus-ap-windows\dist.bak -Recurse -Force

3. Replace dist:
   Remove-Item C:\snohaus-ap-windows\dist -Recurse -Force
   Expand-Archive snohaus_ap_combined_patch.zip -DestinationPath C:\temp\patch -Force
   Copy-Item C:\temp\patch\dist C:\snohaus-ap-windows\dist -Recurse -Force

4. Copy manifest into the public folder if not already:
   Copy-Item C:\temp\patch\manifest.json C:\snohaus-ap-windows\dist\public\manifest.json -Force

5. Add new env vars to .env:
   Open C:\snohaus-ap-windows\.env and append:
     GOOGLE_CLIENT_ID=...
     GOOGLE_CLIENT_SECRET=...
     GOOGLE_REDIRECT_URI_LOCAL=http://localhost:5000/api/auth/google/callback
     GOOGLE_REDIRECT_URI_PROD=https://disabled-drizzle-unplowed.ngrok-free.dev/api/auth/google/callback

6. Restart:
   nssm start SnoHausAP

7. After server starts, log in as jake@snohaus.com, go to Settings → Backups, click "Connect Google Drive" to authorize.

## What's new in this patch

### Feature 1 — Mobile Responsive UI
- Invoice Drawer: PDF at 30vh on mobile, tap to expand fullscreen (portal-based, no new window)
- Invoice Drawer: Primary action button full-width at bottom on mobile, secondary actions in "More" dropdown
- Inbox: Essential columns only on mobile (Vendor, Invoice #, Amount, Status). "Filters" sheet button replaces dropdowns
- All Invoices / Posted / Receiving / Problem: overflow-x-auto on tables, bulk-select hidden on mobile
- Skipped / Rules / Aliases: overflow-x-auto wrappers added

### Feature 2 — Backup Engine
- Hourly local SQLite backups (VACUUM INTO + gzip) stored in private_assets/backups/local/
- 7-day retention for local backups
- Daily + weekly backup push to Google Drive (requires Drive authorization in Settings)
- Settings → Backups card: status panel, manual trigger buttons, download-only restore

### Feature 3 — PDF Archive
- Weekly Sunday archive of PDFs >12 months old → bundled per-month zips → Drive folder "SnoHaus AP PDF Archive"
- Settings → PDF Archive card: status + manual trigger

### Feature 4 — Google OAuth (SSO + Drive)
- "Sign in with Google" button on login page
- Google account must exist in the users table to log in
- Drive OAuth for backup/archive operations (admin only, connect in Settings → Backups)

### Feature 5 — Users / Roles
- New app_users table: admin / user roles
- Seeds jake@snohaus.com (admin) + johnny@snohaus.com (user) on first boot
- Existing env-based auth still works as fallback
- Settings → Users card (admin only): list, add, edit role, enable/disable, set password, delete

### PWA (iOS homescreen)
- manifest.json added to dist/public
- Apple meta tags in index.html

## Environment variables (all optional — app degrades gracefully if absent)

```
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI_LOCAL=http://localhost:5000/api/auth/google/callback
GOOGLE_REDIRECT_URI_PROD=https://your-ngrok.ngrok-free.dev/api/auth/google/callback
```

## Notes
- data.db is untouched. All schema changes are additive (CREATE TABLE IF NOT EXISTS, ALTER TABLE inside try/catch)
- If users table is empty on first boot, seeds from LOGIN_USERS / LOGIN_EMAIL env vars
- Local hourly backups start 5 seconds after server boot
- Drive backups only run if Drive is connected in Settings → Backups → "Connect Drive"
