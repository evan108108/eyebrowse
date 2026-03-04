#!/usr/bin/env bun

// Redirect console.log to stderr immediately — stdout must stay clean
const originalLog = console.log;
console.log = (...args: unknown[]) => console.error(...args);

// Global exception handlers to prevent daemon crashes
process.on("uncaughtException", (err) => {
  console.error("[eyebrowse] Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[eyebrowse] Unhandled rejection:", err);
});

import { DAEMON_PORT, REAPER_INTERVAL_MS } from "./src/types";
import { initDaemonToken } from "./src/auth";
import { reapStaleSessions } from "./src/registry";
import { createServer } from "./src/server";

async function main() {
  console.error("[eyebrowse] Starting daemon...");

  // Load or generate daemon token (persists across restarts)
  const token = await initDaemonToken();
  console.error(`[eyebrowse] Daemon token: ~/.eyebrowse/daemon.token`);

  // Port-in-use detection
  try {
    const test = await fetch(`http://localhost:${DAEMON_PORT}/health`).catch(() => null);
    if (test?.ok) {
      console.error(`[eyebrowse] ERROR: Port ${DAEMON_PORT} already in use. Another daemon may be running.`);
      process.exit(1);
    }
  } catch {
    // Expected — port is free
  }

  // Start server
  const server = createServer();
  console.error(`[eyebrowse] Daemon listening on http://localhost:${DAEMON_PORT}`);

  // Stale session reaper
  const reaperInterval = setInterval(() => {
    const reaped = reapStaleSessions();
    if (reaped.length > 0) {
      console.error(`[eyebrowse] Reaped ${reaped.length} stale session(s): ${reaped.join(", ")}`);
    }
  }, REAPER_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = () => {
    console.error("[eyebrowse] Shutting down...");
    clearInterval(reaperInterval);
    server.stop(true); // graceful
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[eyebrowse] Fatal error:", err);
  process.exit(1);
});
