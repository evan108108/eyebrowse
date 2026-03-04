import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { TOKEN_DIR, TOKEN_PATH } from "./types";

let daemonToken: string | null = null;

/** Load existing daemon token or generate a new one. Persists across restarts. */
export async function initDaemonToken(): Promise<string> {
  if (!existsSync(TOKEN_DIR)) {
    await mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  }

  // Reuse existing token if present
  const existing = await readDaemonToken();
  if (existing) {
    daemonToken = existing;
    return existing;
  }

  // First run — generate and persist
  const token = crypto.randomUUID();
  await writeFile(TOKEN_PATH, token, { mode: 0o600 });
  daemonToken = token;
  return token;
}

/** Read daemon token from disk (used by MCP client) */
export async function readDaemonToken(): Promise<string | null> {
  try {
    const token = (await readFile(TOKEN_PATH, "utf-8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

/** Get the current in-memory daemon token */
export function getDaemonToken(): string | null {
  return daemonToken;
}

/** Validate a bearer token against the daemon token */
export function validateDaemonToken(token: string): boolean {
  if (!daemonToken) return false;
  // Constant-time comparison to prevent timing attacks
  if (token.length !== daemonToken.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ daemonToken.charCodeAt(i);
  }
  return result === 0;
}

/** Extract bearer token from Authorization header */
export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/** Per-session bearer tokens — daemon issues these on registration */
const sessionTokens = new Map<string, string>();

export function generateSessionToken(sessionId: string): string {
  const token = crypto.randomUUID();
  sessionTokens.set(sessionId, token);
  return token;
}

export function validateSessionToken(sessionId: string, token: string): boolean {
  const expected = sessionTokens.get(sessionId);
  if (!expected) return false;
  if (token.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

export function removeSessionToken(sessionId: string): void {
  sessionTokens.delete(sessionId);
}
