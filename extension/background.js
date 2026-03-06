// Eyebrowse — Chrome Extension Service Worker (Manifest V3)
// Connects to the local Eyebrowse daemon via WebSocket and bridges
// Chrome browser state + capture APIs to Sona / Claude Code.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const WS_URL = "ws://localhost:7890/ws";
const KEEPALIVE_INTERVAL_MS = 20_000;
const ALARM_WAKEUP = "eyebrowse-wakeup";
const ALARM_INTERVAL_S = 25; // chrome.alarms minimum is ~1 min in MV3, but we set desired
const RECONNECT_DELAYS = [3000, 6000, 12000, 30000, 60000]; // exponential backoff caps at 60s
const DEBOUNCE_TAB_MS = 500;

// CDP allowlist — only these commands may be sent via chrome.debugger
const CDP_ALLOWLIST = new Set([
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Page.printToPDF",
  "Runtime.evaluate",
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let keepaliveTimer = null;
let tabDebounceTimer = null;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
async function setConnectionStatus(status) {
  // status: "connected" | "disconnected" | "connecting" | "setup-needed"
  await chrome.storage.session.set({ connectionStatus: status });
}

// ---------------------------------------------------------------------------
// Window / Tab helpers
// ---------------------------------------------------------------------------
async function getWindowList() {
  const windows = await chrome.windows.getAll({ populate: true });
  return windows
    .filter((w) => w.type === "normal")
    .map((w) => {
      const active = w.tabs?.find((t) => t.active);
      return {
        windowId: w.id,
        tabId: active?.id ?? null,
        url: active?.url ?? "",
        title: active?.title ?? "",
        pairedSessionId: null,
      };
    });
}

async function getActiveTabInfo(windowId) {
  const tabs = await chrome.tabs.query({ active: true, windowId });
  const tab = tabs[0];
  if (!tab) return null;
  return { windowId: tab.windowId, tabId: tab.id, url: tab.url, title: tab.title };
}

// ---------------------------------------------------------------------------
// WebSocket — send helpers
// ---------------------------------------------------------------------------
function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendEvent(event, data = {}) {
  wsSend({ event, data });
}

function sendResponse(requestId, success, dataOrError) {
  if (success) {
    wsSend({ requestId, success: true, data: dataOrError });
  } else {
    wsSend({ requestId, success: false, error: String(dataOrError) });
  }
}

// ---------------------------------------------------------------------------
// Request handlers — all receive (params, windowId?) where windowId targets
// the paired window. Falls back to lastFocusedWindow if not provided.
// ---------------------------------------------------------------------------

/** Get the active tab for a specific window, or fall back to last focused */
async function getTargetTab(windowId) {
  if (windowId) {
    const tabs = await chrome.tabs.query({ active: true, windowId });
    if (tabs[0]) return tabs[0];
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function handleScreenshot(params, windowId) {
  const quality = params?.quality ?? 70;
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId ?? null, {
    format: "jpeg",
    quality,
  });
  return { image: dataUrl };
}

async function handleAccessibilityTree(params, windowId) {
  const activeTab = await getTargetTab(windowId);
  if (!activeTab) throw new Error("No active tab found");

  const target = { tabId: activeTab.id };

  // Check for restricted pages
  const url = activeTab.url || "";
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:")) {
    throw new Error(`Cannot attach debugger to restricted page: ${url}`);
  }

  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    throw new Error(`Debugger attach failed: ${e.message}`);
  }

  try {
    const command = params?.partial ? "Accessibility.getPartialAXTree" : "Accessibility.getFullAXTree";
    if (!CDP_ALLOWLIST.has(command)) {
      throw new Error(`CDP command not allowed: ${command}`);
    }
    const commandParams = params?.partial ? { nodeId: params.nodeId } : {};
    const result = await chrome.debugger.sendCommand(target, command, commandParams);
    return { nodes: result.nodes || [] };
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch (_) {
      // already detached
    }
  }
}

async function handlePrintToPDF(params, windowId) {
  const activeTab = await getTargetTab(windowId);
  if (!activeTab) throw new Error("No active tab found");

  const target = { tabId: activeTab.id };

  const url = activeTab.url || "";
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:")) {
    throw new Error(`Cannot print restricted page to PDF: ${url}`);
  }

  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    throw new Error(`Debugger attach failed: ${e.message}`);
  }

  try {
    const result = await chrome.debugger.sendCommand(target, "Page.printToPDF", {
      landscape: params?.landscape ?? false,
      displayHeaderFooter: params?.displayHeaderFooter ?? false,
      printBackground: params?.printBackground ?? true,
      scale: params?.scale ?? 1,
      paperWidth: params?.paperWidth ?? 8.5,
      paperHeight: params?.paperHeight ?? 11,
      marginTop: params?.marginTop ?? 0.4,
      marginBottom: params?.marginBottom ?? 0.4,
      marginLeft: params?.marginLeft ?? 0.4,
      marginRight: params?.marginRight ?? 0.4,
      pageRanges: params?.pageRanges ?? "",
    });
    return { data: result.data, stream: result.stream };
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch (_) {}
  }
}

async function handlePageInfo(_params, windowId) {
  const tab = await getTargetTab(windowId);
  if (!tab) throw new Error("No active tab");
  return { url: tab.url, title: tab.title };
}

async function handleOpenWindow(params) {
  const url = params?.url;
  if (!url) throw new Error("Missing url parameter");
  // Only allow http/https
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("Only http: and https: URLs are allowed");
  }
  const win = await chrome.windows.create({ url, focused: true });
  return { windowId: win.id };
}

async function handleListWindows(_params) {
  const list = await getWindowList();
  return { windows: list };
}

async function handleOverlay(params, windowId) {
  const tab = await getTargetTab(windowId);
  if (!tab) throw new Error("No active tab for overlay");

  // Inject content script if it hasn't been injected yet
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (_) {
    // May fail if already injected or page restricted — that's fine, try sending anyway
  }

  // Forward to content script (content.js expects { action: "eyebrowse-overlay", command: {...} })
  const response = await chrome.tabs.sendMessage(tab.id, {
    action: "eyebrowse-overlay",
    command: params,
  });
  return response || { ok: true };
}

async function handleInteract(params, windowId) {
  const tab = await getTargetTab(windowId);
  if (!tab) throw new Error("No active tab for interaction");

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (_) {}

  const response = await chrome.tabs.sendMessage(tab.id, {
    action: "eyebrowse-interact",
    command: params,
  });
  return response || { success: true };
}

async function handleListTabs(_params, windowId) {
  if (!windowId) throw new Error("No paired window");
  const tabs = await chrome.tabs.query({ windowId });
  return {
    tabs: tabs.map((t) => ({
      tabId: t.id,
      url: t.url || "",
      title: t.title || "",
      active: t.active,
      index: t.index,
    })),
  };
}

async function handleSwitchTab(params, _windowId) {
  const tabId = params?.tabId;
  if (!tabId) throw new Error("tabId required");
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  return { tabId: tab.id, url: tab.url, title: tab.title };
}

async function handleCloseWindow(params, windowId) {
  const targetId = params?.windowId ?? windowId;
  if (!targetId) throw new Error("No window to close");
  await chrome.windows.remove(targetId);
  return { closed: true, windowId: targetId };
}

async function handleNavigate(params, windowId) {
  const tab = await getTargetTab(windowId);
  if (!tab) throw new Error("No active tab");

  const waitForLoad = params.waitForLoad !== false;

  if (params.url) {
    await chrome.tabs.update(tab.id, { url: params.url });
  } else if (params.navAction === "back") {
    await chrome.tabs.goBack(tab.id);
  } else if (params.navAction === "forward") {
    await chrome.tabs.goForward(tab.id);
  } else if (params.navAction === "reload") {
    await chrome.tabs.reload(tab.id);
  } else {
    throw new Error("No url or valid navAction provided");
  }

  if (waitForLoad) {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15000);

      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === "complete") {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  const updatedTab = await chrome.tabs.get(tab.id);
  return { url: updatedTab.url, title: updatedTab.title };
}

async function handleEvaluate(params, windowId) {
  const tab = await getTargetTab(windowId);
  if (!tab) throw new Error("No active tab for evaluate");
  const { expression } = params;
  if (!expression || typeof expression !== "string") {
    throw new Error("expression (string) required");
  }

  const url = tab.url || "";
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:")) {
    throw new Error(`Cannot evaluate on restricted page: ${url}`);
  }

  const target = { tabId: tab.id };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    throw new Error(`Debugger attach failed: ${e.message}`);
  }

  try {
    const result = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `JSON.stringify(${expression})`,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Evaluation error");
    }
    const raw = result.result?.value;
    try { return { result: JSON.parse(raw) }; }
    catch { return { result: raw }; }
  } finally {
    try { await chrome.debugger.detach(target); } catch (_) {}
  }
}

// Dispatch table
const REQUEST_HANDLERS = {
  screenshot: handleScreenshot,
  "accessibility-tree": handleAccessibilityTree,
  "page-info": handlePageInfo,
  "open-window": handleOpenWindow,
  "list-windows": handleListWindows,
  overlay: handleOverlay,
  interact: handleInteract,
  navigate: handleNavigate,
  evaluate: handleEvaluate,
  "list-tabs": handleListTabs,
  "switch-tab": handleSwitchTab,
  "close-window": handleCloseWindow,
  "print-to-pdf": handlePrintToPDF,
};

// ---------------------------------------------------------------------------
// Incoming message router
// ---------------------------------------------------------------------------
async function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.warn("[eyebrowse] Received non-JSON message:", raw);
    return;
  }

  // Request from daemon (has requestId + action)
  if (msg.requestId && msg.action) {
    const handler = REQUEST_HANDLERS[msg.action];
    if (!handler) {
      sendResponse(msg.requestId, false, `Unknown action: ${msg.action}`);
      return;
    }
    try {
      const data = await handler(msg.params || {}, msg.windowId);
      sendResponse(msg.requestId, true, data);
    } catch (e) {
      console.error(`[eyebrowse] Handler error (${msg.action}):`, e);
      sendResponse(msg.requestId, false, e.message || String(e));
    }
    return;
  }

  // Response to a popup request (has requestId + success, no action)
  if (msg.requestId && pendingPopupRequests.has(msg.requestId)) {
    const { sendResponse: respond, timer } = pendingPopupRequests.get(msg.requestId);
    clearTimeout(timer);
    pendingPopupRequests.delete(msg.requestId);
    respond(msg.success ? (msg.data || {}) : { error: msg.error });
    return;
  }

  // Pairing changed server-side (via MCP pair_window / open_browser / unpair)
  if (msg.event === "pairing-changed" && msg.data) {
    const { windowId, sessionName } = msg.data;
    const { windowPairings } = await chrome.storage.session.get("windowPairings");
    const pairings = windowPairings || {};
    if (sessionName) {
      pairings[windowId] = sessionName;
    } else {
      delete pairings[windowId];
    }
    await chrome.storage.session.set({ windowPairings: pairings });
    return;
  }

  // Could be an ack or other daemon message — log for debugging
  console.log("[eyebrowse] Daemon message:", JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// WebSocket lifecycle
// ---------------------------------------------------------------------------
async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  await setConnectionStatus("connecting");

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.error("[eyebrowse] WebSocket constructor error:", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = async () => {
    console.log("[eyebrowse] Connected to daemon");
    reconnectAttempt = 0;
    await setConnectionStatus("connected");

    // Start keepalive
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: "ping" }));
      }
    }, KEEPALIVE_INTERVAL_MS);

    // Send connected event with current window state
    const windows = await getWindowList();
    sendEvent("connected", { windows });
  };

  ws.onmessage = (evt) => {
    onMessage(evt.data);
  };

  ws.onclose = async (evt) => {
    console.log(`[eyebrowse] WS closed: code=${evt.code} reason=${evt.reason}`);
    cleanup();
    await setConnectionStatus("disconnected");
    scheduleReconnect();
  };

  ws.onerror = (evt) => {
    console.error("[eyebrowse] WS error:", evt);
    // onclose will fire after this
  };
}

function cleanup() {
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
  ws = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempt++;
  console.log(`[eyebrowse] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// ---------------------------------------------------------------------------
// Chrome event listeners — outgoing events to daemon
// ---------------------------------------------------------------------------

// Windows created / removed → send full list
chrome.windows.onCreated.addListener(async () => {
  const windows = await getWindowList();
  sendEvent("windows-updated", { windows });
});

chrome.windows.onRemoved.addListener(async () => {
  const windows = await getWindowList();
  sendEvent("windows-updated", { windows });
});

// Tab activated or updated → debounced tab-changed event
function emitTabChanged(tabId, windowId) {
  clearTimeout(tabDebounceTimer);
  tabDebounceTimer = setTimeout(async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      sendEvent("tab-changed", {
        windowId: tab.windowId,
        tabId: tab.id,
        url: tab.url || "",
        title: tab.title || "",
      });
    } catch (_) {
      // Tab may have been closed between debounce
    }
  }, DEBOUNCE_TAB_MS);
}

chrome.tabs.onActivated.addListener((info) => {
  emitTabChanged(info.tabId, info.windowId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only care about URL or title changes on the active tab
  if (tab.active && (changeInfo.url || changeInfo.title)) {
    emitTabChanged(tabId, tab.windowId);
  }
});

// ---------------------------------------------------------------------------
// Hey Sona command — capture screenshot + page info, send to daemon
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "hey-sona") return;
  console.log("[eyebrowse] hey-sona command triggered");

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;

    let screenshot = null;
    try {
      screenshot = await chrome.tabs.captureVisibleTab(null, {
        format: "jpeg",
        quality: 70,
      });
    } catch (e) {
      console.warn("[eyebrowse] hey-sona screenshot failed:", e.message);
    }

    sendEvent("hey-sona", {
      windowId: tab.windowId,
      screenshot,
      url: tab.url || "",
      title: tab.title || "",
    });
  } catch (e) {
    console.error("[eyebrowse] hey-sona error:", e);
  }
});

// ---------------------------------------------------------------------------
// Alarm — backup wakeup to keep service worker alive & reconnect if needed
// ---------------------------------------------------------------------------
chrome.alarms.create(ALARM_WAKEUP, { periodInMinutes: ALARM_INTERVAL_S / 60 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_WAKEUP) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log("[eyebrowse] Alarm wakeup — reconnecting");
      connect();
    }
  }
});


// ---------------------------------------------------------------------------
// Popup message handler
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getSessions") {
    // Fetch sessions from daemon via WS request
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({ sessions: [] });
      return;
    }
    // Ask daemon for session list via a bridge request
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingPopupRequests.delete(requestId);
      sendResponse({ sessions: [] });
    }, 5000);
    pendingPopupRequests.set(requestId, { sendResponse, timer });
    ws.send(JSON.stringify({ requestId, action: "list-sessions" }));
    return true; // async response
  }

  if (msg.type === "pairWindow") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({ success: false });
      return;
    }
    const requestId = crypto.randomUUID();
    const wId = msg.windowId;
    const sName = msg.sessionName;
    const timer = setTimeout(() => {
      pendingPopupRequests.delete(requestId);
      sendResponse({ success: false });
    }, 5000);
    pendingPopupRequests.set(requestId, {
      sendResponse: async (resp) => {
        if (!resp.error) {
          const { windowPairings } = await chrome.storage.session.get("windowPairings");
          const pairings = windowPairings || {};
          pairings[wId] = sName;
          await chrome.storage.session.set({ windowPairings: pairings });
        }
        sendResponse(resp);
      },
      timer,
    });
    ws.send(JSON.stringify({ requestId, action: "pair", params: { windowId: wId, sessionName: sName } }));
    return true;
  }

  if (msg.type === "unpairWindow") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sendResponse({ success: false });
      return;
    }
    const requestId = crypto.randomUUID();
    const wId = msg.windowId;
    const timer = setTimeout(() => {
      pendingPopupRequests.delete(requestId);
      sendResponse({ success: false });
    }, 5000);
    pendingPopupRequests.set(requestId, {
      sendResponse: async (resp) => {
        if (!resp.error) {
          const { windowPairings } = await chrome.storage.session.get("windowPairings");
          const pairings = windowPairings || {};
          delete pairings[wId];
          await chrome.storage.session.set({ windowPairings: pairings });
        }
        sendResponse(resp);
      },
      timer,
    });
    ws.send(JSON.stringify({ requestId, action: "unpair", params: { windowId: wId } }));
    return true;
  }
});

// Pending popup requests (separate from bridge requests)
const pendingPopupRequests = new Map();

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
console.log("[eyebrowse] Service worker starting");
connect();
