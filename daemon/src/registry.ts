import type { Session, SessionPublic, BrowserWindow } from "./types";
import { generateSessionToken, removeSessionToken } from "./auth";

// ─── In-memory registries ───────────────────────────────────────────────────

const sessions = new Map<string, Session>();
const windows = new Map<number, BrowserWindow>();
const pairings = new Map<string, number>(); // sessionId → windowId
const reversePairings = new Map<number, string>(); // windowId → sessionId

// ─── Rate limiting for open_browser ─────────────────────────────────────────

const openBrowserCounts = new Map<string, { count: number; resetAt: number }>();

// ─── Session Management ─────────────────────────────────────────────────────

export function registerSession(
  id: string,
  name: string,
  workingDir: string,
  pid: number
): string {
  const bearerToken = generateSessionToken(id);
  const session: Session = {
    id,
    name,
    workingDir,
    pid,
    bearerToken,
    connectedAt: Date.now(),
  };
  sessions.set(id, session);
  return bearerToken;
}

export function deregisterSession(id: string): void {
  unpairWindow(id);
  removeSessionToken(id);
  sessions.delete(id);
  openBrowserCounts.delete(id);
}

/** Auto-register a session if unknown (self-healing) */
export function autoRegister(id: string, name: string): Session {
  const existing = sessions.get(id);
  if (existing) return existing;

  const bearerToken = registerSession(id, name, "", 0);
  return sessions.get(id)!;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): SessionPublic[] {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    name: s.name,
    connectedAt: s.connectedAt,
    pairedWindowId: pairings.get(s.id) ?? null,
  }));
}

// ─── Window Management ──────────────────────────────────────────────────────

export function updateWindows(windowList: BrowserWindow[]): void {
  // Keep pairing info when updating window list
  const newWindowIds = new Set(windowList.map((w) => w.windowId));

  // Remove windows that no longer exist
  for (const [wid] of windows) {
    if (!newWindowIds.has(wid)) {
      const sessionId = reversePairings.get(wid);
      if (sessionId) {
        pairings.delete(sessionId);
        reversePairings.delete(wid);
      }
      windows.delete(wid);
    }
  }

  // Add/update windows
  for (const w of windowList) {
    const existing = windows.get(w.windowId);
    windows.set(w.windowId, {
      ...w,
      pairedSessionId: existing?.pairedSessionId ?? w.pairedSessionId,
    });
  }
}

export function updateWindow(windowId: number, url: string, title: string, tabId: number): void {
  const existing = windows.get(windowId);
  if (existing) {
    existing.url = url;
    existing.title = title;
    existing.tabId = tabId;
  } else {
    windows.set(windowId, { windowId, tabId, url, title, pairedSessionId: null });
  }
}

export function removeWindow(windowId: number): void {
  const sessionId = reversePairings.get(windowId);
  if (sessionId) {
    pairings.delete(sessionId);
    reversePairings.delete(windowId);
  }
  windows.delete(windowId);
}

export function getWindow(windowId: number): BrowserWindow | undefined {
  return windows.get(windowId);
}

export function listWindows(): BrowserWindow[] {
  return Array.from(windows.values());
}

// ─── Pairing ────────────────────────────────────────────────────────────────

export function pairWindow(sessionId: string, windowId: number): { success: boolean; error?: string } {
  if (!sessions.has(sessionId)) {
    return { success: false, error: "Session not found" };
  }
  if (!windows.has(windowId)) {
    return { success: false, error: "Window not found" };
  }

  // Enforce 1:1 — unpair existing pairs
  const existingWindowId = pairings.get(sessionId);
  if (existingWindowId !== undefined) {
    const oldWindow = windows.get(existingWindowId);
    if (oldWindow) oldWindow.pairedSessionId = null;
    reversePairings.delete(existingWindowId);
  }

  const existingSessionId = reversePairings.get(windowId);
  if (existingSessionId !== undefined) {
    pairings.delete(existingSessionId);
  }

  pairings.set(sessionId, windowId);
  reversePairings.set(windowId, sessionId);

  const window = windows.get(windowId);
  if (window) window.pairedSessionId = sessionId;

  return { success: true };
}

export function unpairWindow(sessionId: string): void {
  const windowId = pairings.get(sessionId);
  if (windowId !== undefined) {
    const window = windows.get(windowId);
    if (window) window.pairedSessionId = null;
    reversePairings.delete(windowId);
    pairings.delete(sessionId);
  }
}

export function getWindowForSession(sessionId: string): BrowserWindow | undefined {
  const windowId = pairings.get(sessionId);
  if (windowId === undefined) return undefined;
  return windows.get(windowId);
}

export function getSessionForWindow(windowId: number): Session | undefined {
  const sessionId = reversePairings.get(windowId);
  if (!sessionId) return undefined;
  return sessions.get(sessionId);
}

// ─── Rate Limiting ──────────────────────────────────────────────────────────

export function checkOpenBrowserRate(sessionId: string, limit: number): boolean {
  const now = Date.now();
  let entry = openBrowserCounts.get(sessionId);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    openBrowserCounts.set(sessionId, entry);
  }

  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// ─── Stale Session Reaper ───────────────────────────────────────────────────

export function reapStaleSessions(): string[] {
  const reaped: string[] = [];

  for (const [id, session] of sessions) {
    if (session.pid === 0) continue; // auto-registered, no PID to check

    try {
      process.kill(session.pid, 0); // signal 0 = check existence
    } catch {
      // Process doesn't exist
      deregisterSession(id);
      reaped.push(id);
    }
  }

  return reaped;
}

// ─── Hey Sona captures (one per session, overwritten) ───────────────────────

import type { HeySonaCapture } from "./types";

const heySonaCaptures = new Map<string, HeySonaCapture>();

export function storeHeySonaCapture(sessionId: string, capture: HeySonaCapture): void {
  heySonaCaptures.set(sessionId, capture);
}

export function consumeHeySonaCapture(sessionId: string): HeySonaCapture | undefined {
  const capture = heySonaCaptures.get(sessionId);
  if (capture) heySonaCaptures.delete(sessionId);
  return capture;
}
