# Sno-Haus Ops Hub — Windows Edition

_Formerly Sno-Haus AP Review Dashboard — renamed in PR #192 to reflect the broader scope (AP review, sales-tax filing, payroll exports, reconciliation, etc.). On-disk repo / directory / package names (`snohaus-ap-windows`) intentionally remain unchanged._

Internal Windows-hosted operations hub for Sno-Haus. The AP module reviews vendor invoices before they post to QuickBooks Online; additional modules cover NY sales-tax filing, payroll baseline + ADP exports, and Shopify ↔ QBO reconciliation.
Runs entirely on your local machine. No cloud account required.

---

## 1. Quick Start

Four steps to get running:

1. **Install Node.js** — download from [nodejs.org/en/download](https://nodejs.org/en/download) and run the installer. Choose the LTS version. Minimum v18.
2. **Unzip the package** — right-click `snohaus-ap-windows.zip` → "Extract All…" → choose a folder (e.g. `C:\Apps\snohaus-ap`)
3. **Double-click `start.bat`** — on first run it installs packages and builds the app (~1–2 minutes). A browser window opens automatically.
4. **Sign in** — use `jake@snohaus.com` / `skiing18` (or your credentials from `.env`)

The server runs in that Command Prompt window. Keep it open while using the dashboard. Close it to stop.

---

## 2. First-time QuickBooks Connection

To enable live duplicate checking and direct bill posting:

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in with your Intuit account
2. Click **"Create an app"** → select **"QuickBooks Online and Payments"**
3. Give it a name (e.g. "Sno-Haus AP"), select scope: **QuickBooks Online Accounting**
4. Go to **Keys & OAuth** → copy **Client ID** and **Client Secret**
5. Under **Redirect URIs**, add exactly: `http://localhost:5000/api/qbo/callback`
6. Open `.env` in a text editor (it's in the same folder as `start.bat`) and fill in:
   ```
   QBO_CLIENT_ID=<paste here>
   QBO_CLIENT_SECRET=<paste here>
   QBO_ENVIRONMENT=production
   ```
   Use `sandbox` while testing, `production` for your real company.
7. Save `.env` and restart the server (close `start.bat` window and reopen)
8. In the dashboard, go to **Settings → QuickBooks** and click **Connect QuickBooks**
9. Sign in with your QuickBooks credentials and authorize the app

Once connected, the dashboard will:
- Check QBO for duplicate bills when you open an invoice
- Post approved bills directly to QBO with one click (from the Approved list)

**Token refresh:** Access tokens expire after 1 hour but refresh automatically. Refresh tokens last 101 days — if you don't use the app for 101 days, reconnect.

---

## 3. First-time Gmail Setup

To automatically ingest invoices emailed to your Gmail account:

1. Sign in to the Gmail account that receives vendor invoices
2. **Enable 2-Step Verification** at [myaccount.google.com/security](https://myaccount.google.com/security)
3. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
4. Select **"Mail"** and **"Other (custom name)"** → enter "Sno-Haus AP" → click Generate
5. Copy the 16-character password shown (e.g. `abcd efgh ijkl mnop` — use without spaces)
6. Create a Gmail label called **"Unreceived Invoices"** (or a name of your choice)
7. Set up a Gmail filter: vendor invoice emails → apply label "Unreceived Invoices"
8. Open `.env` and fill in:
   ```
   GMAIL_USER=your-invoice-inbox@gmail.com
   GMAIL_APP_PASSWORD=abcdefghijklmnop
   GMAIL_LABEL=Unreceived Invoices
   GMAIL_POLL_INTERVAL_MINUTES=15
   ```
9. Save `.env` and restart the server

The dashboard will poll Gmail every 15 minutes (configurable) and create pending invoices for each PDF attachment found. You can also trigger an immediate poll from **Settings → Gmail → Poll now**.

Low-confidence parses (scanned PDFs, unusual formats) will be flagged — fill in the details manually in the invoice drawer.

---

## 3b. Gmail API Migration (R4q — parallel run)

The IMAP path above is the original ingest method but has had reliability issues ("Connection not available" errors, polls failing silently). PR #R4q introduces a Gmail REST API path with Pub/Sub push notifications that runs **in parallel** with IMAP while we verify reliability. Both paths share the `ingested_emails` dedup table so no duplicate invoices are ever created.

**To enable the parallel run after merging R4q:**

1. **GCP setup** (one-time, already done for the production server):
   - GCP project `sno-haus-ap`, Gmail API + Cloud Pub/Sub API enabled
   - OAuth client "Sno-Haus AP Server" with `/api/auth/gmail/callback` added to authorized redirect URIs (local + ngrok)
   - Pub/Sub topic `gmail-notification` with `gmail-api-push@system.gserviceaccount.com` granted Pub/Sub Publisher
   - Pub/Sub push subscription `gmail-notification-push` with endpoint `https://<your-ngrok>/api/gmail/push`, ack deadline 60s, no auth
2. **`.env` change:** set `GMAIL_API_ENABLED=true` (default is `false` so merging the PR alone does nothing).
3. **Restart server**, then go to **Settings → Integrations → Connect Gmail** and authorize. Watch is auto-registered on connect and renewed every 6 days.
4. **Verify both paths are running** — server logs should show both `[gmail]` (IMAP) and `[gmail-api]` lines. The first push delivery logs `[gmail-push] received emailAddress=... historyId=...`.
5. **Compare for a week or two**: any new invoice should appear once. If IMAP wins the race, you'll see `[gmail-api] dedup: skipping` on the API side (and vice versa). LLM cost is **not** doubled because the early `ingested_emails` check runs before the LLM call in both paths.
6. **R4r cutover** (later PR): once Jake confirms the API path is reliable, R4r deletes the IMAP module and `GMAIL_API_ENABLED` becomes the only path.

**Endpoints added by R4q:**
- `POST /api/gmail/push` — public Pub/Sub webhook (always live; no-op when flag is off)
- `GET /api/auth/gmail/{connect,callback,status}` + `POST /api/auth/gmail/disconnect`
- `GET /api/gmail-api/status` — mirrors `/api/gmail/status` shape but for the API path
- `POST /api/gmail-api/{poll-now,test-connection,clear-error-log,reingest,start-watch,stop-watch}`

---

## 4. Daily Use

1. Open a browser to [http://localhost:5000](http://localhost:5000) (or double-click `start.bat`)
2. Sign in
3. **Inbox** — review pending invoices. Click any row to open the review drawer.
   - Verify vendor match, routing (which store), and totals
   - Click **Approve & show posting** when ready
4. **Approved** (left nav "Ready for QBO") — post approved invoices to QBO
   - If QBO is connected: click **Post to QBO** → bill is created automatically
   - If QBO is not connected: copy the payload JSON, enter manually in QBO, then click **Mark posted**
5. **Posted** — archive of invoices already in QBO

---

## 5. Auto-start on Windows Boot

To have the dashboard start automatically when you turn on your computer:

1. Press **Win + R**, type `shell:startup`, press Enter — a folder opens
2. Right-click in that folder → **New → Shortcut**
3. In "Location", enter: `C:\Apps\snohaus-ap\start.bat` (adjust path as needed)
4. Name it "Sno-Haus AP" and click Finish

The dashboard will now start automatically at login. The browser opens 3 seconds after the server starts.

---

## 6. Backing Up

The entire database is stored in one file: `data.db` (in the same folder as `start.bat`).

**To back up:**
- Copy `data.db` to a USB drive, network share, or cloud folder
- Best practice: do this weekly or before any major changes

**To restore:**
- Close the server (Ctrl+C in the `start.bat` window)
- Overwrite `data.db` with your backup copy
- Start the server again

---

## 7. Moving to Another Machine

1. Close the server on the old machine
2. Zip the entire `snohaus-ap` folder (right-click → "Send to → Compressed folder")
3. Copy the zip to the new machine
4. Unzip and double-click `start.bat`
5. On first run, dependencies are reinstalled automatically (requires internet)

Your `data.db` and `.env` (including credentials and QBO connection) move with the folder.

---

## 8. Troubleshooting

**Port 5000 already in use**

Another app is using port 5000. Change the port:
1. Open `.env` and add: `PORT=5001`
2. Also update `QBO_REDIRECT_URI=http://localhost:5001/api/qbo/callback` in `.env` and in your QBO app settings
3. Restart. Access the dashboard at [http://localhost:5001](http://localhost:5001)

**Node version too old**

The app requires Node.js v18 or newer. Run `node --version` in a Command Prompt. If it shows v16 or older, download the latest LTS from [nodejs.org](https://nodejs.org/en/download), install it, and try again.

**QBO token expired / disconnected**

If the QBO refresh token expires (after 101 days of no use):
1. Go to **Settings → QuickBooks → Disconnect**
2. Click **Connect QuickBooks** again
3. Authorize the app

**"Invalid email or password" on login**

- Check that your email is in `ALLOWED_EMAILS` in `.env`
- Default credentials: `jake@snohaus.com` / `skiing18`
- If you changed the password and forgot: re-generate the hash (see below)

**Regenerating a password hash**

Open a Command Prompt in the project folder and run:
```
node -e "const c=require('crypto'); const s=c.randomBytes(16); const h=c.scryptSync('NEWPASSWORD', s, 64); console.log('SALT:', s.toString('hex')); console.log('HASH:', h.toString('hex'));"
```
Replace `NEWPASSWORD` with your new password. Copy the salt and hash values into `.env` as `LOGIN_PASSWORD_SALT` and `LOGIN_PASSWORD_HASH`, then restart.

**Gmail not ingesting emails**

- Check the IMAP label name matches exactly (case-sensitive)
- Ensure the App Password is correct (no spaces, 16 characters)
- Check the error shown in **Settings → Gmail**
- Make sure IMAP is enabled: Gmail Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP

**Build fails on first run**

- Ensure you have internet access (npm downloads packages during install)
- Try deleting the `node_modules` folder and running `start.bat` again
- If you see TypeScript errors, make sure you're running Node v18+

---

## Technical Details

| Item | Value |
|------|-------|
| Stack | Express + Vite + React + Tailwind CSS + shadcn/ui + SQLite |
| Default port | 5000 |
| Database file | `data.db` (project root) |
| PDF storage | `private_assets/` folder |
| Auth | scrypt password hashing, in-memory session tokens |
| QBO tokens | Stored in `data.db` → `qbo_tokens` table |

---

*Sno-Haus internal tool — not for distribution.*
