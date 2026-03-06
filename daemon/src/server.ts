import { Hono } from "hono";
import type { ServerWebSocket } from "bun";
import type {
  BridgeRequest,
  BridgeResponse,
  ExtensionEvent,
  ToolResponse,
  RegisterRequest,
  RegisterResponse,
  BrowserWindow,
  HeySonaCapture,
} from "./types";
import {
  DAEMON_PORT,
  WS_TIMEOUT_MS,
  OPEN_BROWSER_RATE_LIMIT,
  MAX_OVERLAY_MATCHES,
} from "./types";
import {
  getDaemonToken,
  validateDaemonToken,
  extractBearerToken,
  validateSessionToken,
} from "./auth";
import {
  registerSession,
  deregisterSession,
  autoRegister,
  getSession,
  listSessions,
  listWindows,
  pairWindow,
  unpairWindow,
  getWindowForSession,
  updateWindows,
  updateWindow,
  removeWindow,
  checkOpenBrowserRate,
  storeHeySonaCapture,
  consumeHeySonaCapture,
} from "./registry";
import { formatAXTree } from "./ax-tree";

// ─── Extension WebSocket state ──────────────────────────────────────────────

let extensionWs: ServerWebSocket<{ type: string }> | null = null;

// Pending bridge requests: requestId → { resolve, reject, timer }
const pendingRequests = new Map<
  string,
  {
    resolve: (value: BridgeResponse) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/** Notify extension of a pairing change so it can update popup UI */
function notifyPairingChanged(windowId: number, sessionName: string | null): void {
  if (extensionWs) {
    try {
      extensionWs.send(JSON.stringify({
        event: "pairing-changed",
        data: { windowId, sessionName },
      }));
    } catch (_) { /* best effort */ }
  }
}

/** Send a bridge request to the extension and wait for response */
function sendToExtension(request: BridgeRequest): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    if (!extensionWs) {
      return reject(new Error("No browser extension connected"));
    }

    const timer = setTimeout(() => {
      pendingRequests.delete(request.requestId);
      reject(new Error("Extension request timed out"));
    }, WS_TIMEOUT_MS);

    pendingRequests.set(request.requestId, { resolve, reject, timer });

    try {
      extensionWs.send(JSON.stringify(request));
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(request.requestId);
      reject(new Error("Failed to send to extension"));
    }
  });
}

/** Reject all pending requests (called on WS close) */
function rejectAllPending(): void {
  for (const [id, { reject, timer }] of pendingRequests) {
    clearTimeout(timer);
    reject(new Error("Extension disconnected"));
  }
  pendingRequests.clear();
}

// ─── Hono App (HTTP routes) ─────────────────────────────────────────────────

const app = new Hono();

// Auth middleware — daemon token required on all routes
app.use("*", async (c, next) => {
  const token = extractBearerToken(c.req.header("Authorization"));
  if (!token || !validateDaemonToken(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// POST /api/session/register
app.post("/api/session/register", async (c) => {
  const body = (await c.req.json()) as RegisterRequest;
  const { id, name, workingDir, pid } = body;

  if (!id || !name) {
    return c.json({ error: "id and name required" }, 400);
  }

  const bearerToken = registerSession(id, name, workingDir || "", pid || 0);
  console.error(`[eyebrowse] Session registered: ${name} (${id})`);
  return c.json({ bearerToken } satisfies RegisterResponse);
});

// POST /api/session/deregister
app.post("/api/session/deregister", async (c) => {
  const { id } = (await c.req.json()) as { id: string };
  if (!id) return c.json({ error: "id required" }, 400);

  deregisterSession(id);
  console.error(`[eyebrowse] Session deregistered: ${id}`);
  return c.json({ success: true });
});

// POST /api/pair
app.post("/api/pair", async (c) => {
  const { sessionId, windowId } = (await c.req.json()) as {
    sessionId: string;
    windowId: number;
  };
  if (!sessionId || windowId === undefined) {
    return c.json({ error: "sessionId and windowId required" }, 400);
  }

  const result = pairWindow(sessionId, windowId);
  if (!result.success) return c.json({ error: result.error }, 400);

  console.error(`[eyebrowse] Paired session ${sessionId} ↔ window ${windowId}`);
  return c.json({ success: true });
});

// POST /api/unpair
app.post("/api/unpair", async (c) => {
  const { sessionId } = (await c.req.json()) as { sessionId: string };
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);

  unpairWindow(sessionId);
  return c.json({ success: true });
});

// GET /api/sessions
app.get("/api/sessions", (c) => {
  return c.json({ sessions: listSessions() });
});

// GET /api/windows
app.get("/api/windows", (c) => {
  return c.json({ windows: listWindows() });
});

// ─── Tool Execution ─────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  sessionId: string,
  params: Record<string, unknown>
): Promise<ToolResponse> {
  const pairedWindow = getWindowForSession(sessionId);
  const windowId = pairedWindow?.windowId;

  /** Send request to extension, auto-injecting the paired windowId */
  function sendRequest(req: Omit<BridgeRequest, "windowId">): Promise<BridgeResponse> {
    return sendToExtension({ ...req, windowId });
  }

  switch (name) {
    case "browser_status": {
      return {
        success: true,
        data: {
          extensionConnected: extensionWs !== null,
          pairedWindow: pairedWindow
            ? { windowId: pairedWindow.windowId, url: pairedWindow.url, title: pairedWindow.title }
            : null,
          sessions: listSessions(),
        },
      };
    }

    case "list_windows": {
      return { success: true, data: { windows: listWindows() } };
    }

    case "pair_window": {
      const windowId = params.windowId as number;
      if (windowId === undefined) return { success: false, error: "windowId required" };
      const result = pairWindow(sessionId, windowId);
      if (result.success) {
        const session = getSession(sessionId);
        notifyPairingChanged(windowId, session?.name ?? sessionId);
      }
      return result.success
        ? { success: true, data: { windowId } }
        : { success: false, error: result.error };
    }

    case "unpair": {
      const unpairedWindow = getWindowForSession(sessionId);
      unpairWindow(sessionId);
      if (unpairedWindow) {
        notifyPairingChanged(unpairedWindow.windowId, null);
      }
      return { success: true };
    }

    case "open_browser": {
      const url = params.url as string;
      if (!url) return { success: false, error: "url required" };

      // Scheme allowlist
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { success: false, error: "Only http and https URLs allowed" };
        }
      } catch {
        return { success: false, error: "Invalid URL" };
      }

      // Rate limit
      if (!checkOpenBrowserRate(sessionId, OPEN_BROWSER_RATE_LIMIT)) {
        return { success: false, error: "Rate limited: max 3 open_browser calls per minute" };
      }

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "open-window",
        params: { url },
      });

      if (!response.success) return { success: false, error: response.error };

      // Auto-pair the new window — register it first since windows-updated event is async
      const newWindowId = (response.data as { windowId: number })?.windowId;
      if (newWindowId) {
        updateWindow(newWindowId, url, "", 0);
        pairWindow(sessionId, newWindowId);
        const session = getSession(sessionId);
        notifyPairingChanged(newWindowId, session?.name ?? sessionId);
      }

      return { success: true, data: response.data };
    }

    case "look": {
      if (!pairedWindow) {
        return {
          success: false,
          error: "No browser connected. Pair a window from the extension or use open_browser(url).",
        };
      }

      const includeAx = params.axTree === true;

      // Get screenshot
      const screenshotReqId = crypto.randomUUID();
      const screenshotResp = await sendRequest({
        requestId: screenshotReqId,
        sessionId,
        action: "screenshot",
        params: { quality: 70 },
      });

      if (!screenshotResp.success) {
        return { success: false, error: screenshotResp.error };
      }

      const result: Record<string, unknown> = {
        screenshot: (screenshotResp.data as { image: string })?.image,
        url: pairedWindow.url,
        title: pairedWindow.title,
      };

      // Optionally get AX tree
      if (includeAx) {
        const axReqId = crypto.randomUUID();
        const axResp = await sendRequest({
          requestId: axReqId,
          sessionId,
          action: "accessibility-tree",
          params: {},
        });

        if (axResp.success) {
          const nodes = (axResp.data as { nodes: unknown[] })?.nodes;
          result.axTree = formatAXTree(nodes as any);
        }
      }

      return { success: true, data: result };
    }

    case "screenshot": {
      if (!pairedWindow) {
        return {
          success: false,
          error: "No browser connected. Pair a window from the extension or use open_browser(url).",
        };
      }

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "screenshot",
        params: {
          quality: (params.quality as number) ?? 70,
          fullPage: params.fullPage ?? false,
        },
      });

      if (!response.success) {
        return { success: false, error: response.error };
      }
      // Normalize: extension returns { image }, MCP expects { screenshot }
      const imgData = (response.data as { image: string })?.image;
      return { success: true, data: { screenshot: imgData } };
    }

    case "get_page_info": {
      if (!pairedWindow) {
        return {
          success: false,
          error: "No browser connected. Pair a window from the extension or use open_browser(url).",
        };
      }

      const result: Record<string, unknown> = {
        url: pairedWindow.url,
        title: pairedWindow.title,
      };

      if (params.axTree === true) {
        const reqId = crypto.randomUUID();
        const axResp = await sendRequest({
          requestId: reqId,
          sessionId,
          action: "accessibility-tree",
          params: {},
        });
        if (axResp.success) {
          const nodes = (axResp.data as { nodes: unknown[] })?.nodes;
          result.axTree = formatAXTree(nodes as any);
        }
      }

      return { success: true, data: result };
    }

    case "highlight": {
      if (!pairedWindow) {
        return { success: false, error: "No browser connected." };
      }

      const selector = params.selector as string;
      if (!selector) return { success: false, error: "selector required" };

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "overlay",
        params: {
          type: "highlight",
          selector,
          color: params.color ?? "rgba(66, 133, 244, 0.3)",
          maxElements: MAX_OVERLAY_MATCHES,
        },
      });

      return response.success
        ? { success: true }
        : { success: false, error: response.error };
    }

    case "annotate": {
      if (!pairedWindow) {
        return { success: false, error: "No browser connected." };
      }

      const selector = params.selector as string;
      const message = params.message as string;
      if (!selector || !message) {
        return { success: false, error: "selector and message required" };
      }

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "overlay",
        params: { type: "annotate", selector, message, maxElements: MAX_OVERLAY_MATCHES },
      });

      return response.success
        ? { success: true }
        : { success: false, error: response.error };
    }

    case "show_message": {
      if (!pairedWindow) {
        return { success: false, error: "No browser connected." };
      }

      const text = params.text as string;
      if (!text) return { success: false, error: "text required" };

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "overlay",
        params: { type: "toast", text, duration: params.duration ?? 5000 },
      });

      return response.success
        ? { success: true }
        : { success: false, error: response.error };
    }

    case "clear_overlays": {
      if (!pairedWindow) {
        return { success: false, error: "No browser connected." };
      }

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "overlay",
        params: { type: "clear" },
      });

      return response.success
        ? { success: true }
        : { success: false, error: response.error };
    }

    case "click": {
      if (!pairedWindow) return { success: false, error: "No browser connected." };

      const text = params.text as string | undefined;
      const selector = params.selector as string | undefined;
      const x = params.x as number | undefined;
      const y = params.y as number | undefined;

      if (!text && !selector && (x === undefined || y === undefined)) {
        return { success: false, error: "Either text, selector, or both x and y coordinates required" };
      }

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "interact",
        params: {
          type: "click",
          text,
          selector,
          x,
          y,
          button: params.button ?? "left",
          doubleClick: params.doubleClick ?? false,
        },
      });

      return response.success
        ? { success: true, data: response.data }
        : { success: false, error: response.error };
    }

    case "type": {
      if (!pairedWindow) return { success: false, error: "No browser connected." };

      const text = params.text as string;
      if (text === undefined || text === null) {
        return { success: false, error: "text required" };
      }

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "interact",
        params: {
          type: "type",
          text,
          selector: params.selector,
          clear: params.clear ?? false,
          pressEnter: params.pressEnter ?? false,
          delay: params.delay ?? 0,
        },
      });

      return response.success
        ? { success: true, data: response.data }
        : { success: false, error: response.error };
    }

    case "scroll": {
      if (!pairedWindow) return { success: false, error: "No browser connected." };

      const selector = params.selector as string | undefined;
      const direction = params.direction as string | undefined;
      const toEdge = params.toEdge as string | undefined;

      if (!selector && !direction && !toEdge) {
        return { success: false, error: "One of selector, direction, or toEdge is required" };
      }

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "interact",
        params: {
          type: "scroll",
          selector,
          direction,
          amount: params.amount,
          toEdge,
        },
      });

      return response.success
        ? { success: true, data: response.data }
        : { success: false, error: response.error };
    }

    case "list_tabs": {
      if (!pairedWindow) return { success: false, error: "No browser connected." };

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "list-tabs",
        params: {},
      });

      return response.success
        ? { success: true, data: response.data }
        : { success: false, error: response.error };
    }

    case "switch_tab": {
      if (!pairedWindow) return { success: false, error: "No browser connected." };

      const tabId = params.tabId as number;
      if (!tabId) return { success: false, error: "tabId required" };

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "switch-tab",
        params: { tabId },
      });

      return response.success
        ? { success: true, data: response.data }
        : { success: false, error: response.error };
    }

    case "close_window": {
      // Can close the paired window (default) or a specific windowId
      const targetWindowId = (params.windowId as number) ?? windowId;
      if (!targetWindowId) return { success: false, error: "No window to close. Pair a window first or provide windowId." };

      const reqId = crypto.randomUUID();
      const response = await sendToExtension({
        requestId: reqId,
        sessionId,
        action: "close-window",
        params: { windowId: targetWindowId },
      });

      if (response.success) {
        // Clean up: unpair if it was the paired window and remove from registry
        if (targetWindowId === windowId) {
          unpairWindow(sessionId);
          notifyPairingChanged(targetWindowId, null);
        }
        removeWindow(targetWindowId);
      }

      return response.success
        ? { success: true, data: response.data }
        : { success: false, error: response.error };
    }

    case "print_to_pdf": {
      if (!pairedWindow) return { success: false, error: "No browser connected." };

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "print-to-pdf",
        params: {
          landscape: params.landscape ?? false,
          displayHeaderFooter: params.displayHeaderFooter ?? false,
          printBackground: params.printBackground ?? true,
          scale: params.scale ?? 1,
          paperWidth: params.paperWidth,
          paperHeight: params.paperHeight,
          marginTop: params.marginTop,
          marginBottom: params.marginBottom,
          marginLeft: params.marginLeft,
          marginRight: params.marginRight,
          pageRanges: params.pageRanges,
        },
      });

      if (!response.success) {
        return { success: false, error: response.error };
      }

      // Extension returns { data: base64string }
      const pdfData = (response.data as { data: string })?.data;
      if (!pdfData) {
        return { success: false, error: "No PDF data returned" };
      }

      // Save to temp file and return path
      const filename = params.outputPath as string || `/tmp/eyebrowse-print-${Date.now()}.pdf`;
      await Bun.write(filename, Buffer.from(pdfData, "base64"));

      return {
        success: true,
        data: {
          path: filename,
          size: Math.round(pdfData.length * 0.75), // approx decoded size
          url: pairedWindow.url,
          title: pairedWindow.title,
        },
      };
    }

    case "evaluate": {
      if (!pairedWindow) return { success: false, error: "No browser connected." };
      const expression = params.expression as string;
      if (!expression) return { success: false, error: "expression required" };

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "evaluate",
        params: { expression },
      });

      return response.success
        ? { success: true, data: response.data }
        : { success: false, error: response.error };
    }

    case "navigate": {
      if (!pairedWindow) return { success: false, error: "No browser connected." };

      const url = params.url as string | undefined;
      const action = params.action as string | undefined;

      if (!url && !action) {
        return { success: false, error: "Either url or action (back/forward/reload) required" };
      }

      if (url) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return { success: false, error: "Only http and https URLs allowed" };
          }
        } catch {
          return { success: false, error: "Invalid URL" };
        }
      }

      const reqId = crypto.randomUUID();
      const response = await sendRequest({
        requestId: reqId,
        sessionId,
        action: "navigate",
        params: {
          url,
          navAction: action,
          waitForLoad: params.waitForLoad ?? true,
        },
      });

      return response.success
        ? { success: true, data: response.data }
        : { success: false, error: response.error };
    }

    default:
      return { success: false, error: `Unknown tool: ${name}` };
  }
}

// ─── Extension requests (popup → background → daemon) ───────────────────────

function handleExtensionRequest(
  ws: ServerWebSocket<{ type: string }>,
  requestId: string,
  action: string,
  params: Record<string, unknown>
): void {
  try {
    const reply = (success: boolean, data?: unknown, error?: string) => {
      try {
        ws.send(JSON.stringify({ requestId, success, data, error }));
      } catch (err) {
        console.error(`[eyebrowse] Failed to send extension request response: ${err}`);
      }
    };

    switch (action) {
      case "list-sessions": {
        const sessions = listSessions().map((s) => ({ id: s.id, name: s.name }));
        reply(true, { sessions });
        break;
      }

      case "pair": {
        const { windowId, sessionName } = params as { windowId: number; sessionName: string };
        // Find session by name
        const session = listSessions().find((s) => s.name === sessionName || s.id === sessionName);
        if (!session) {
          reply(false, undefined, "Session not found");
          return;
        }
        const result = pairWindow(session.id, windowId);
        if (result.success) {
          console.error(`[eyebrowse] Paired session ${session.name} ↔ window ${windowId}`);
          reply(true);
        } else {
          reply(false, undefined, result.error);
        }
        break;
      }

      case "unpair": {
        const { windowId: wId } = params as { windowId: number };
        // Find which session is paired to this window
        const sessions = listSessions();
        const paired = sessions.find((s) => s.pairedWindowId === wId);
        if (paired) {
          unpairWindow(paired.id);
          reply(true);
        } else {
          reply(true); // not paired, that's fine
        }
        break;
      }

      default:
        reply(false, undefined, `Unknown extension request: ${action}`);
    }
  } catch (err) {
    console.error(`[eyebrowse] Error handling extension request: ${err}`);
    try {
      ws.send(JSON.stringify({ requestId, success: false, error: "Internal error" }));
    } catch {}
  }
}

// ─── Extension WebSocket handler ────────────────────────────────────────────

function handleExtensionMessage(ws: ServerWebSocket<{ type: string }>, data: string): void {
  try {
    let msg: BridgeResponse | ExtensionEvent;
    try {
      msg = JSON.parse(data);
    } catch {
      console.error("[eyebrowse] Invalid JSON from extension");
      return;
    }

    // Extension request (has requestId + action) — popup asking daemon for data
    if ("requestId" in msg && "action" in msg) {
      const req = msg as { requestId: string; action: string; params?: Record<string, unknown> };
      handleExtensionRequest(ws, req.requestId, req.action, req.params ?? {});
      return;
    }

    // Bridge response (has requestId + success)
    if ("requestId" in msg && "success" in msg) {
      const response = msg as BridgeResponse;
      const pending = pendingRequests.get(response.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(response.requestId);
        pending.resolve(response);
      }
      return;
    }

    // Extension event
    const event = msg as ExtensionEvent;
    switch (event.event) {
      case "connected":
        console.error("[eyebrowse] Extension connected");
        break;

      case "windows-updated": {
        const windowList = event.data.windows as BrowserWindow[];
        if (windowList) updateWindows(windowList);
        break;
      }

      case "tab-changed": {
        const { windowId, tabId, url, title } = event.data as {
          windowId: number;
          tabId: number;
          url: string;
          title: string;
        };
        updateWindow(windowId, url, title, tabId);
        break;
      }

      case "hey-sona": {
        // Store the capture for the paired session
        const { windowId, screenshot, url, title } = event.data as {
          windowId: number;
          screenshot: string;
          url: string;
          title: string;
        };
        // Find which session is paired to this window
        const session = (() => {
          for (const s of listSessions()) {
            if (s.pairedWindowId === windowId) {
              return getSession(s.id);
            }
          }
          return undefined;
        })();

        if (session) {
          storeHeySonaCapture(session.id, {
            screenshot,
            url,
            title,
            timestamp: Date.now(),
          });
          console.error(`[eyebrowse] Hey Sona capture stored for session ${session.name}`);
        }
        break;
      }

      case "ping":
        // Keepalive — no action needed
        break;

      case "user-input":
        // Phase 2 — pause AI control
        break;

      default:
        console.error(`[eyebrowse] Unknown extension event: ${event.event}`);
    }
  } catch (err) {
    console.error(`[eyebrowse] Error handling extension message: ${err}`);
  }
}

// ─── Bun.serve — single port for HTTP + WebSocket ───────────────────────────

export function createServer() {
  const server = Bun.serve<{ type: string }>({
    port: DAEMON_PORT,
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade on /ws
      if (url.pathname === "/ws") {
        // Origin validation: only chrome-extension:// allowed
        const origin = req.headers.get("origin") ?? "";
        if (!origin.startsWith("chrome-extension://")) {
          return new Response("Forbidden: invalid origin", { status: 403 });
        }

        const success = server.upgrade(req, {
          data: { type: "extension" },
        });

        return success
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 500 });
      }

      // Health check
      if (url.pathname === "/health") {
        return new Response("ok");
      }

      // Tool endpoint — handle directly (Hono body parsing unreliable with Bun parameterized routes)
      const toolMatch = url.pathname.match(/^\/api\/tool\/(.+)$/);
      if (toolMatch && req.method === "POST") {
        const authToken = extractBearerToken(req.headers.get("Authorization"));
        if (!authToken || !validateDaemonToken(authToken)) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
        }
        const toolName = toolMatch[1];
        const sessionId = req.headers.get("x-session-id");
        const sessionName = req.headers.get("x-session-name");
        if (!sessionId) {
          return new Response(JSON.stringify({ error: "x-session-id header required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (!getSession(sessionId) && sessionName) {
          autoRegister(sessionId, sessionName);
        }
        let params: Record<string, unknown> = {};
        try {
          const body = await req.json();
          params = (body as any)?.params ?? {};
        } catch {}
        try {
          const result = await executeTool(toolName, sessionId, params);
          return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return new Response(JSON.stringify({ success: false, error: message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
      }

      // Hono handles all other HTTP routes
      return app.fetch(req);
    },

    websocket: {
      open(ws) {
        // Replace any existing extension connection
        if (extensionWs) {
          try {
            extensionWs.close(1000, "Replaced by new connection");
          } catch {}
          rejectAllPending();
        }
        extensionWs = ws;
        console.error("[eyebrowse] Extension WebSocket connected");
      },

      message(ws, data) {
        handleExtensionMessage(ws, typeof data === "string" ? data : new TextDecoder().decode(data));
      },

      close(ws, code, reason) {
        if (extensionWs === ws) {
          extensionWs = null;
          rejectAllPending();
          console.error(`[eyebrowse] Extension WebSocket closed: ${code} ${reason}`);
        }
      },
    },
  });

  return server;
}
