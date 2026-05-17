/**
 * Google OAuth helper — Feature 4
 * Manages OAuth tokens for SSO logins (per-user) and Drive backups (single service token).
 * Tokens stored encrypted at rest using AES-256-GCM with key derived from SESSION_SECRET.
 *
 * IMPORTANT: Do NOT touch server/gmail.ts — Gmail polling stays on IMAP + App Password.
 * This module is ONLY for SSO (login) and Drive (backups + PDF archive).
 */
import crypto from "node:crypto";
import { google, Auth, drive_v3 } from "googleapis";
import { getGoogleOAuthRow, upsertGoogleOAuthRow, deleteGoogleOAuthRow } from "./storage";

// ===== Types =====

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}

// ===== Encryption helpers (AES-256-GCM) =====

function getDerivedKey(): Buffer {
  const secret = process.env.SESSION_SECRET || "default-dev-secret-change-in-production";
  return crypto.scryptSync(secret, "oauth-salt", 32);
}

function encryptTokens(tokens: GoogleTokens): string {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(tokens);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv(hex):authTag(hex):ciphertext(hex)
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptTokens(encrypted: string): GoogleTokens | null {
  try {
    const key = getDerivedKey();
    const parts = encrypted.split(":");
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const ciphertext = Buffer.from(parts[2], "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8")) as GoogleTokens;
  } catch {
    return null;
  }
}

// ===== Config check =====

export function isGoogleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// ===== OAuth2 client factory =====

export function getOAuth2Client(redirectUri: string): Auth.OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// ===== Drive token helpers =====

export function getDriveTokens(): GoogleTokens | null {
  const row = getGoogleOAuthRow("drive_service");
  if (!row) return null;
  return decryptTokens(row.encrypted_tokens);
}

export function setDriveTokens(tokens: GoogleTokens, grantedEmail?: string): void {
  const now = new Date().toISOString();
  upsertGoogleOAuthRow({
    purpose: "drive_service",
    encrypted_tokens: encryptTokens(tokens),
    granted_email: grantedEmail || null,
    granted_at: now,
    updated_at: now,
  });
}

export function clearDriveTokens(): void {
  deleteGoogleOAuthRow("drive_service");
}

export function getDriveStatus(): { connected: boolean; granted_email?: string } {
  const row = getGoogleOAuthRow("drive_service");
  if (!row) return { connected: false };
  const tokens = decryptTokens(row.encrypted_tokens);
  if (!tokens) return { connected: false };
  return { connected: true, granted_email: row.granted_email || undefined };
}

// ===== Drive auth URL =====

export function getDriveAuthUrl(redirectUri: string, state: string): string {
  const oauth2 = getOAuth2Client(redirectUri);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/drive.file"],
    state,
    prompt: "consent", // force consent screen to always get refresh_token
  });
}

// ===== SSO auth URL =====

export function getSsoAuthUrl(redirectUri: string, state: string): string {
  const oauth2 = getOAuth2Client(redirectUri);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    state,
  });
}

// ===== Code exchange =====

export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<GoogleTokens> {
  const oauth2 = getOAuth2Client(redirectUri);
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.access_token) throw new Error("No access_token in response");
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || "",
    expiry_date: tokens.expiry_date || Date.now() + 3600 * 1000,
  };
}

export async function exchangeSsoCode(
  code: string,
  redirectUri: string
): Promise<{ email: string; name?: string; picture?: string }> {
  const oauth2 = getOAuth2Client(redirectUri);
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.id_token) throw new Error("No id_token in SSO response");
  // Decode the id_token JWT payload (no verification needed — Google signed it)
  const parts = tokens.id_token.split(".");
  if (parts.length < 2) throw new Error("Malformed id_token");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  const email: string = payload.email;
  if (!email) throw new Error("No email in id_token payload");
  return {
    email,
    name: payload.name,
    picture: payload.picture,
  };
}

// ===== Authenticated Drive client (with auto-refresh) =====

export async function getValidDriveClient(): Promise<drive_v3.Drive | null> {
  if (!isGoogleConfigured()) return null;
  const tokens = getDriveTokens();
  if (!tokens) return null;

  const redirectUri = process.env.GOOGLE_REDIRECT_URI_PROD || process.env.GOOGLE_REDIRECT_URI_LOCAL || "http://localhost:5000/api/auth/drive/callback";
  const oauth2 = getOAuth2Client(redirectUri);
  oauth2.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  });

  // Refresh if within 5 minutes of expiry
  if (tokens.expiry_date && tokens.expiry_date - Date.now() < 5 * 60 * 1000) {
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      const newTokens: GoogleTokens = {
        access_token: credentials.access_token || tokens.access_token,
        refresh_token: credentials.refresh_token || tokens.refresh_token,
        expiry_date: credentials.expiry_date || Date.now() + 3600 * 1000,
      };
      setDriveTokens(newTokens);
      oauth2.setCredentials(newTokens);
    } catch (e: any) {
      console.error("[google-oauth] Drive token refresh failed:", e.message);
      // Don't return null — try with existing token
    }
  }

  return google.drive({ version: "v3", auth: oauth2 });
}

// ===== CSRF state management (in-memory map) =====

const oauthStateMap = new Map<string, { created: number; purpose: string }>();

export function generateOAuthState(purpose: string): string {
  const state = crypto.randomBytes(16).toString("hex");
  oauthStateMap.set(state, { created: Date.now(), purpose });
  // Cleanup old states (>10 min)
  const now = Date.now();
  for (const [k, v] of oauthStateMap.entries()) {
    if (now - v.created > 10 * 60 * 1000) oauthStateMap.delete(k);
  }
  return state;
}

export function verifyOAuthState(state: string, expectedPurpose?: string): boolean {
  const entry = oauthStateMap.get(state);
  if (!entry) return false;
  // State is single-use
  oauthStateMap.delete(state);
  // Check age (5 min)
  if (Date.now() - entry.created > 5 * 60 * 1000) return false;
  if (expectedPurpose && entry.purpose !== expectedPurpose) return false;
  return true;
}

// ===== Drive folder helper =====

export async function getOrCreateDriveFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId?: string
): Promise<string> {
  // Search for existing folder
  let query = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) query += ` and '${parentId}' in parents`;

  const res = await drive.files.list({
    q: query,
    fields: "files(id, name)",
    spaces: "drive",
  });

  const files = res.data.files || [];
  if (files.length > 0 && files[0].id) {
    return files[0].id;
  }

  // Create folder
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
    },
    fields: "id",
  });
  if (!created.data.id) throw new Error(`Failed to create Drive folder: ${name}`);
  return created.data.id;
}
