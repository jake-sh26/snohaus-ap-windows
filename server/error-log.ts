/**
 * Shared rolling error-log utility.
 *
 * Used by Gmail, QBO, and Acumatica integrations so the Settings page can
 * surface recent errors and warnings — copy-pasteable for support.
 *
 * Each integration gets its own named buffer. Entries are tagged with a
 * "scope" (e.g. "auth", "api", "vendor-sync", "webhook") and a level
 * ("error" | "warn"). Newest first. Capped per buffer.
 */

export type IntegrationLogLevel = "error" | "warn";

export interface IntegrationLogEntry {
  at: string;            // ISO timestamp
  level: IntegrationLogLevel;
  scope: string;         // small tag for grouping (e.g. "api", "auth")
  message: string;       // <= 1000 chars
}

const MAX_ENTRIES = 50;
const buffers = new Map<string, IntegrationLogEntry[]>();

function getBuffer(name: string): IntegrationLogEntry[] {
  let b = buffers.get(name);
  if (!b) {
    b = [];
    buffers.set(name, b);
  }
  return b;
}

/**
 * Record an error or warning for an integration.
 * Safe to call from anywhere — never throws.
 */
export function recordIntegrationError(
  integration: string,
  scope: string,
  message: string | null | undefined,
  level: IntegrationLogLevel = "error"
): void {
  try {
    if (!message) return;
    const buf = getBuffer(integration);
    buf.unshift({
      at: new Date().toISOString(),
      level,
      scope: String(scope || "general").slice(0, 40),
      message: String(message).slice(0, 1000),
    });
    if (buf.length > MAX_ENTRIES) buf.length = MAX_ENTRIES;
  } catch {
    // never let logging crash the caller
  }
}

/** Convenience wrapper for warnings */
export function recordIntegrationWarn(
  integration: string,
  scope: string,
  message: string | null | undefined
): void {
  recordIntegrationError(integration, scope, message, "warn");
}

/**
 * Get the most recent N entries (default 20) for an integration, newest first.
 */
export function getIntegrationErrorLog(integration: string, limit = 20): IntegrationLogEntry[] {
  return getBuffer(integration).slice(0, limit);
}

/** Wipe a single integration's buffer */
export function clearIntegrationErrorLog(integration: string): void {
  buffers.set(integration, []);
}

/** For debugging / tests */
export function getIntegrationErrorLogStats() {
  const stats: Record<string, number> = {};
  for (const [k, v] of buffers.entries()) stats[k] = v.length;
  return stats;
}
