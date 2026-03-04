// Eyebrowse protocol types — shared across daemon, MCP, and extension

// ─── Sessions ───────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  name: string;
  workingDir: string;
  pid: number;
  bearerToken: string;
  connectedAt: number;
}

export interface SessionPublic {
  id: string;
  name: string;
  connectedAt: number;
  pairedWindowId: number | null;
}

// ─── Browser Windows ────────────────────────────────────────────────────────

export interface BrowserWindow {
  windowId: number;
  tabId: number;
  url: string;
  title: string;
  pairedSessionId: string | null;
}

// ─── Bridge (daemon ↔ extension) ────────────────────────────────────────────

export interface BridgeRequest {
  requestId: string;
  sessionId: string;
  action:
    | "screenshot"
    | "accessibility-tree"
    | "page-info"
    | "open-window"
    | "overlay"
    | "list-windows"
    | "interact"
    | "navigate"
    | "list-tabs"
    | "switch-tab"
    | "close-window";
  windowId?: number; // paired window — handlers should target this window, not the focused one
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── Extension Events (extension → daemon) ──────────────────────────────────

export type ExtensionEventType =
  | "connected"
  | "hey-sona"
  | "tab-changed"
  | "user-input"
  | "windows-updated";

export interface ExtensionEvent {
  event: ExtensionEventType;
  data: Record<string, unknown>;
}

// ─── Overlay Commands (daemon → extension) ──────────────────────────────────

export type OverlayType = "highlight" | "annotate" | "toast" | "clear";

export interface OverlayCommand {
  type: OverlayType;
  params: {
    selector?: string;
    color?: string;
    message?: string;
    text?: string;
    duration?: number;
  };
}

// ─── AX Tree ────────────────────────────────────────────────────────────────

export interface AXNode {
  nodeId: string;
  role?: { type: string; value: string };
  name?: { type: string; value: string; sources?: unknown[] };
  value?: { type: string; value: string };
  properties?: Array<{
    name: string;
    value: { type: string; value: unknown };
  }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
}

// ─── Tool Params ────────────────────────────────────────────────────────────

export interface LookParams {
  axTree?: boolean;
}

export interface ScreenshotParams {
  fullPage?: boolean;
  quality?: number;
}

export interface HighlightParams {
  selector: string;
  color?: string;
}

export interface AnnotateParams {
  selector: string;
  message: string;
}

export interface ShowMessageParams {
  text: string;
  duration?: number;
}

export interface OpenBrowserParams {
  url: string;
}

export interface PairWindowParams {
  windowId: number;
}

// ─── API Request/Response ───────────────────────────────────────────────────

export interface RegisterRequest {
  id: string;
  name: string;
  workingDir: string;
  pid: number;
}

export interface RegisterResponse {
  bearerToken: string;
}

export interface ToolRequest {
  params?: Record<string, unknown>;
}

export interface ToolResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── Hey Sona Capture ───────────────────────────────────────────────────────

export interface HeySonaCapture {
  screenshot: string; // base64 JPEG
  url: string;
  title: string;
  timestamp: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const DAEMON_PORT = 7890;
export const TOKEN_DIR = `${process.env.HOME}/.eyebrowse`;
export const TOKEN_PATH = `${process.env.HOME}/.eyebrowse/daemon.token`;
export const REAPER_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
export const WS_TIMEOUT_MS = 30 * 1000; // 30 seconds for bridge requests
export const MAX_OVERLAY_MATCHES = 50;
export const OPEN_BROWSER_RATE_LIMIT = 3; // per minute per session
export const AX_TREE_MAX_DEPTH = 6;
export const AX_TREE_MAX_CHARS = 8000;
