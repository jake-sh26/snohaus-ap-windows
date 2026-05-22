/**
 * Lightweight in-process logger that tees console.log/warn/error to a file
 * under <cwd>/logs/app.log, with simple size-based rotation.
 *
 * Why: the Windows service runs under NSSM with no easy way for Jake to peek
 * at the live output. The in-app log viewer (Settings → Logs) reads the tail
 * of this file via GET /api/admin/logs.
 *
 * Safe to call multiple times — initAppLogger is idempotent.
 */
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB before rotation
const ROTATE_KEEP = 2;             // keep app.log + app.log.1 + app.log.2

let logPath: string | null = null;
let initialized = false;

export function getAppLogPath(): string {
  if (logPath) return logPath;
  // PR #R4j — anchor the logs dir to the executable directory rather than
  // process.cwd(). Under NSSM cwd can be C:\Windows\system32, which is why
  // every previous "site went down" investigation found an empty
  // logs/app.log: the file was being written next to system32, not the
  // install root. __dirname in the bundled cjs build = `<install>/dist`, so
  // `..` walks up to the install root.
  const installRoot = path.resolve(__dirname, "..");
  const dir = path.join(installRoot, "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  logPath = path.join(dir, "app.log");
  return logPath;
}

function rotateIfNeeded() {
  const p = getAppLogPath();
  try {
    const st = fs.statSync(p);
    if (st.size < MAX_BYTES) return;
  } catch {
    return; // file doesn't exist yet — nothing to rotate
  }
  // shift app.log.(N-1) → app.log.N, drop the oldest
  for (let i = ROTATE_KEEP; i >= 1; i--) {
    const src = i === 1 ? p : `${p}.${i - 1}`;
    const dst = `${p}.${i}`;
    try {
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    } catch {}
  }
}

function appendLine(level: string, args: any[]) {
  try {
    rotateIfNeeded();
    const ts = new Date().toISOString();
    const msg = args
      .map((a) => {
        if (a instanceof Error) return `${a.message}\n${a.stack || ""}`;
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(" ");
    fs.appendFileSync(getAppLogPath(), `${ts} [${level}] ${msg}\n`);
  } catch {
    // best-effort; never let logging crash the service
  }
}

export function initAppLogger() {
  if (initialized) return;
  initialized = true;
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...args: any[]) => { appendLine("INFO", args); origLog(...args); };
  console.warn = (...args: any[]) => { appendLine("WARN", args); origWarn(...args); };
  console.error = (...args: any[]) => { appendLine("ERROR", args); origErr(...args); };

  // Capture uncaught exceptions and unhandled rejections so a crash leaves a
  // breadcrumb in the log file that the in-app viewer can show.
  process.on("uncaughtException", (err) => {
    appendLine("FATAL", [`uncaughtException: ${err.message}`, err.stack || ""]);
  });
  process.on("unhandledRejection", (reason: any) => {
    appendLine("FATAL", [`unhandledRejection: ${String(reason)}`]);
  });

  origLog(`[app-logger] tee'd to ${getAppLogPath()}`);
}

/** Read the last `n` lines from app.log. Reads from the end for efficiency. */
export function tailAppLog(maxLines = 200): { lines: string[]; path: string; size: number } {
  const p = getAppLogPath();
  try {
    const st = fs.statSync(p);
    // read up to last 1MB for safety
    const readBytes = Math.min(st.size, 1024 * 1024);
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, st.size - readBytes);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const all = text.split(/\r?\n/);
    // If we sliced mid-line, drop the first (partial) line.
    const cleaned = st.size > readBytes ? all.slice(1) : all;
    const nonEmpty = cleaned.filter((l) => l.length > 0);
    return {
      lines: nonEmpty.slice(-maxLines),
      path: p,
      size: st.size,
    };
  } catch {
    return { lines: [], path: p, size: 0 };
  }
}
