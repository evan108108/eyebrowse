const origLog = console.log;
console.log = (...args: any[]) => console.error(...args);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, resolve, dirname } from "node:path";
import crypto from "node:crypto";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ContentBlock = TextContent | ImageContent;
type ToolResult = { content: ContentBlock[] };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DAEMON_BASE = "http://localhost:7890";
const DAEMON_SCRIPT = resolve(dirname(new URL(import.meta.url).pathname), '../daemon/index.ts');
const TOKEN_PATH = `${os.homedir()}/.eyebrowse/daemon.token`;
const SESSION_ID = crypto.randomUUID();
const SESSION_NAME = basename(process.cwd());

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let daemonToken: string | null = null;
let sessionToken: string | null = null;
let registered = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readDaemonToken(): string {
  if (!daemonToken) {
    daemonToken = readFileSync(TOKEN_PATH, "utf-8").trim();
  }
  return daemonToken;
}

function authHeaders(): Record<string, string> {
  return {
    "Authorization": `Bearer ${readDaemonToken()}`,
    "Content-Type": "application/json",
    "x-session-id": SESSION_ID,
    "x-session-name": SESSION_NAME,
  };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function isDaemonReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_BASE}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function startDaemon(): Promise<void> {
  console.log("[eyebrowse-mcp] daemon unreachable, auto-starting...");
  const child = spawn("bun", ["run", DAEMON_SCRIPT], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await sleep(2000);
}

async function registerSession(): Promise<void> {
  const res = await fetch(`${DAEMON_BASE}/api/session/register`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ id: SESSION_ID, name: SESSION_NAME, workingDir: process.cwd(), pid: process.pid }),
  });
  if (!res.ok) {
    throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { bearerToken?: string };
  if (data.bearerToken) {
    sessionToken = data.bearerToken;
  }
  registered = true;
  console.log("[eyebrowse-mcp] registered with daemon");
}

async function ensureRegistered(): Promise<void> {
  if (registered) return;

  if (!(await isDaemonReachable())) {
    await startDaemon();
    if (!(await isDaemonReachable())) {
      throw new Error("Daemon unreachable after auto-start attempt");
    }
  }

  await registerSession();
}

async function deregister(): Promise<void> {
  try {
    await fetch(`${DAEMON_BASE}/api/session/deregister`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ id: SESSION_ID }),
      signal: AbortSignal.timeout(3000),
    });
    console.log("[eyebrowse-mcp] deregistered");
  } catch {
    // best effort
  }
}

// Tools whose response may contain a screenshot image
const IMAGE_TOOLS = new Set(["look", "screenshot"]);

async function callDaemonTool(
  name: string,
  params: Record<string, unknown>
): Promise<ToolResult> {
  // Lazy registration on first tool call
  await ensureRegistered();

  const doRequest = async (): Promise<Response> => {
    return fetch(`${DAEMON_BASE}/api/tool/${name}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ params }),
    });
  };

  let res = await doRequest();

  // Self-healing: re-register on 401/404
  if (res.status === 401 || res.status === 404) {
    console.log(`[eyebrowse-mcp] got ${res.status}, re-registering...`);
    registered = false;
    await ensureRegistered();
    res = await doRequest();
  }

  const body = (await res.json()) as {
    success: boolean;
    data?: any;
    error?: string;
  };

  if (!body.success) {
    return {
      content: [{ type: "text", text: `Error: ${body.error ?? "unknown"}` }],
    };
  }

  // If the tool returns a screenshot, include it as an image content block
  if (IMAGE_TOOLS.has(name) && body.data?.screenshot) {
    const content: ContentBlock[] = [];

    // Strip data URI prefix if present (daemon returns "data:image/jpeg;base64,...")
    let imgData: string = body.data.screenshot;
    const commaIdx = imgData.indexOf(",");
    if (commaIdx !== -1 && imgData.startsWith("data:")) {
      imgData = imgData.slice(commaIdx + 1);
    }

    content.push({
      type: "image",
      data: imgData,
      mimeType: "image/jpeg",
    });

    // Include additional data beyond the screenshot as text
    const { screenshot, ...rest } = body.data;
    if (Object.keys(rest).length > 0) {
      content.push({ type: "text", text: JSON.stringify(rest, null, 2) });
    }

    return { content };
  }

  // Default: return data as JSON text
  return {
    content: [
      { type: "text", text: JSON.stringify(body.data ?? body, null, 2) },
    ],
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer(
  { name: "eyebrowse", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ----- Tools -----

server.tool(
  "look",
  "Screenshot + page URL/title. Optionally include the accessibility tree.",
  { axTree: z.boolean().optional().describe("Include accessibility tree") },
  async ({ axTree }) => callDaemonTool("look", { axTree })
);

server.tool(
  "screenshot",
  "Capture a screenshot of the current page.",
  {
    fullPage: z.boolean().optional().describe("Capture full page"),
    quality: z.number().optional().describe("JPEG quality (0-100)"),
  },
  async ({ fullPage, quality }) => callDaemonTool("screenshot", { fullPage, quality })
);

server.tool(
  "get_page_info",
  "Get current page URL and title. Optionally include the accessibility tree.",
  { axTree: z.boolean().optional().describe("Include accessibility tree") },
  async ({ axTree }) => callDaemonTool("get_page_info", { axTree })
);

server.tool(
  "browser_status",
  "Check connection health and paired window info.",
  async () => callDaemonTool("browser_status", {})
);

server.tool(
  "list_windows",
  "List all Chrome windows.",
  async () => callDaemonTool("list_windows", {})
);

server.tool(
  "pair_window",
  "Pair with a Chrome window by its window ID.",
  { windowId: z.number().describe("Chrome window ID to pair with") },
  async ({ windowId }) => callDaemonTool("pair_window", { windowId })
);

server.tool(
  "unpair",
  "Release the currently paired Chrome window.",
  async () => callDaemonTool("unpair", {})
);

server.tool(
  "open_browser",
  "Open a new Chrome window at the given URL.",
  { url: z.string().describe("URL to open") },
  async ({ url }) => callDaemonTool("open_browser", { url })
);

server.tool(
  "highlight",
  "Highlight elements matching a CSS selector.",
  {
    selector: z.string().describe("CSS selector for elements to highlight"),
    color: z.string().optional().describe("Highlight color (CSS color string)"),
  },
  async ({ selector, color }) => callDaemonTool("highlight", { selector, color })
);

server.tool(
  "annotate",
  "Add a callout annotation near an element.",
  {
    selector: z.string().describe("CSS selector for the target element"),
    message: z.string().describe("Annotation message"),
  },
  async ({ selector, message }) =>
    callDaemonTool("annotate", { selector, message })
);

server.tool(
  "show_message",
  "Show a toast notification in the browser.",
  {
    text: z.string().describe("Message text"),
    duration: z.number().optional().describe("Duration in milliseconds"),
  },
  async ({ text, duration }) =>
    callDaemonTool("show_message", { text, duration })
);

server.tool(
  "clear_overlays",
  "Remove all highlights and annotations from the page.",
  async () => callDaemonTool("clear_overlays", {})
);

server.tool(
  "list_tabs",
  "List all tabs in the paired Chrome window.",
  async () => callDaemonTool("list_tabs", {})
);

server.tool(
  "switch_tab",
  "Switch to a specific tab by its tab ID.",
  { tabId: z.number().describe("Tab ID to activate") },
  async ({ tabId }) => callDaemonTool("switch_tab", { tabId })
);

server.tool(
  "close_window",
  "Close a Chrome window. Closes the paired window by default, or a specific window by ID.",
  {
    windowId: z.number().optional().describe("Window ID to close (defaults to paired window)"),
  },
  async ({ windowId }) => callDaemonTool("close_window", { windowId })
);

server.tool(
  "print_to_pdf",
  "Export the current page as a PDF file. Returns the file path.",
  {
    outputPath: z.string().optional().describe("Output file path (default: /tmp/eyebrowse-print-<timestamp>.pdf)"),
    landscape: z.boolean().optional().describe("Landscape orientation (default: false)"),
    printBackground: z.boolean().optional().describe("Print background graphics (default: true)"),
    scale: z.number().optional().describe("Scale factor (default: 1)"),
    paperWidth: z.number().optional().describe("Paper width in inches (default: 8.5)"),
    paperHeight: z.number().optional().describe("Paper height in inches (default: 11)"),
    displayHeaderFooter: z.boolean().optional().describe("Display header and footer (default: false)"),
    pageRanges: z.string().optional().describe("Page ranges to print, e.g. '1-3, 5'"),
  },
  async ({ outputPath, landscape, printBackground, scale, paperWidth, paperHeight, displayHeaderFooter, pageRanges }) =>
    callDaemonTool("print_to_pdf", { outputPath, landscape, printBackground, scale, paperWidth, paperHeight, displayHeaderFooter, pageRanges })
);

server.tool(
  "evaluate",
  "Execute a JavaScript expression in the current page and return the result. Use for extracting data from the DOM (e.g., links, text content, structured data).",
  {
    expression: z.string().describe("JavaScript expression to evaluate in the page context. Must return a JSON-serializable value."),
  },
  async ({ expression }) => callDaemonTool("evaluate", { expression })
);

server.tool(
  "click",
  "Click an element on the page. Use a CSS selector to target the element, or provide x/y coordinates to click at a specific viewport position.",
  {
    selector: z.string().optional().describe("CSS selector for the element to click"),
    text: z.string().optional().describe("Find element by its visible text content (e.g. 'Submit', 'Edit'). Searches buttons, links, and interactive elements."),
    x: z.number().optional().describe("X coordinate in viewport pixels"),
    y: z.number().optional().describe("Y coordinate in viewport pixels"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default: left)"),
    doubleClick: z.boolean().optional().describe("Double-click instead of single click"),
  },
  async ({ selector, text, x, y, button, doubleClick }) =>
    callDaemonTool("click", { selector, text, x, y, button, doubleClick })
);

server.tool(
  "type",
  "Type text into an element. If no selector is provided, types into the currently focused element.",
  {
    text: z.string().describe("Text to type"),
    selector: z.string().optional().describe("CSS selector for the input element"),
    clear: z.boolean().optional().describe("Clear the field before typing (default: false)"),
    pressEnter: z.boolean().optional().describe("Press Enter after typing (default: false)"),
    delay: z.number().optional().describe("Milliseconds between keystrokes for key-by-key mode (0 = instant, default: 0)"),
  },
  async ({ text, selector, clear, pressEnter, delay }) =>
    callDaemonTool("type", { text, selector, clear, pressEnter, delay })
);

server.tool(
  "navigate",
  "Navigate to a URL, or go back/forward/reload.",
  {
    url: z.string().optional().describe("URL to navigate to"),
    action: z.enum(["back", "forward", "reload"]).optional().describe("Navigation action instead of URL"),
    waitForLoad: z.boolean().optional().describe("Wait for page load to complete (default: true)"),
  },
  async ({ url, action, waitForLoad }) =>
    callDaemonTool("navigate", { url, action, waitForLoad })
);

server.tool(
  "scroll",
  "Scroll the page or scroll a specific element into view.",
  {
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction"),
    amount: z.number().optional().describe("Pixels to scroll (default: 80% of viewport)"),
    selector: z.string().optional().describe("CSS selector for element to scroll into view (overrides direction/amount)"),
    toEdge: z.enum(["top", "bottom"]).optional().describe("Scroll to absolute top or bottom of page"),
  },
  async ({ direction, selector, amount, toEdge }) =>
    callDaemonTool("scroll", { direction, selector, amount, toEdge })
);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("[eyebrowse-mcp] server started on stdio");
}

process.on("SIGINT", async () => {
  await deregister();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await deregister();
  process.exit(0);
});

process.on("beforeExit", async () => {
  await deregister();
});

main().catch((err) => {
  console.error("[eyebrowse-mcp] fatal:", err);
  process.exit(1);
});
