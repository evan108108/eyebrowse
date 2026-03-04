/**
 * Eyebrowse — Overlay Content Script
 *
 * Injected on-demand via chrome.scripting.executeScript.
 * Provides highlight, annotate, toast, and clear overlay commands.
 */

(() => {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────
  const OVERLAY_ROOT_ID = "eyebrowse-overlay-root";
  const DEFAULT_HIGHLIGHT_COLOR = "rgba(66, 133, 244, 0.3)";
  const DEFAULT_MAX_ELEMENTS = 50;
  const DEFAULT_TOAST_DURATION = 5000;
  const AUTO_CLEAR_MS = 30000;
  const REPOSITION_DEBOUNCE_MS = 200;
  const MAX_MESSAGE_LENGTH = 500;

  // ── State ──────────────────────────────────────────────────────────────
  let overlayRoot = null;
  let autoClearTimer = null;
  let repositionTimer = null;
  let mutationObserver = null;
  let resizeObservers = [];
  let trackedOverlays = []; // { el: overlayDiv, target: domElement, type: string }

  // ── Helpers ────────────────────────────────────────────────────────────

  function ensureRoot() {
    const existing = document.getElementById(OVERLAY_ROOT_ID);
    if (existing) {
      overlayRoot = existing;
      return overlayRoot;
    }

    overlayRoot = document.createElement("div");
    overlayRoot.id = OVERLAY_ROOT_ID;
    Object.assign(overlayRoot.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      zIndex: "2147483647",
      pointerEvents: "none",
      overflow: "visible",
    });
    document.documentElement.appendChild(overlayRoot);
    return overlayRoot;
  }

  function resetAutoClear(duration) {
    if (autoClearTimer) clearTimeout(autoClearTimer);
    const ms = typeof duration === "number" && duration > 0 ? duration : AUTO_CLEAR_MS;
    autoClearTimer = setTimeout(() => {
      clearAll();
    }, ms);
  }

  function makeLabel() {
    const label = document.createElement("span");
    label.textContent = "eyebrowse";
    Object.assign(label.style, {
      position: "absolute",
      bottom: "2px",
      right: "4px",
      fontSize: "8px",
      fontFamily: "system-ui, sans-serif",
      opacity: "0.35",
      color: "#fff",
      pointerEvents: "none",
      lineHeight: "1",
      letterSpacing: "0.5px",
    });
    return label;
  }

  function opaqueColor(rgba, targetAlpha) {
    // Bump alpha for border
    const match = rgba.match(
      /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/
    );
    if (match) {
      return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${targetAlpha})`;
    }
    return rgba;
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function queryElements(selector, maxElements) {
    const cap = typeof maxElements === "number" ? maxElements : DEFAULT_MAX_ELEMENTS;
    try {
      const all = document.querySelectorAll(selector);
      return Array.from(all).slice(0, cap);
    } catch {
      return [];
    }
  }

  // ── Overlay Positioning ────────────────────────────────────────────────

  function positionOverBox(overlay, rect) {
    Object.assign(overlay.style, {
      position: "fixed",
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px",
    });
  }

  function positionCallout(overlay, rect) {
    const padding = 8;
    const calloutWidth = 260;

    // Prefer above the element; if not enough space, go right
    let top, left;

    const above = rect.top - padding;
    if (above > 80) {
      // Place above
      top = rect.top - padding;
      left = clamp(rect.left, 4, window.innerWidth - calloutWidth - 4);
      overlay.style.transform = "translateY(-100%)";
      overlay.dataset.placement = "above";
    } else {
      // Place to the right
      top = clamp(rect.top, 4, window.innerHeight - 80);
      left = clamp(rect.right + padding, 4, window.innerWidth - calloutWidth - 4);
      overlay.style.transform = "none";
      overlay.dataset.placement = "right";
    }

    Object.assign(overlay.style, {
      position: "fixed",
      top: top + "px",
      left: left + "px",
      maxWidth: calloutWidth + "px",
    });
  }

  function repositionAll() {
    for (const entry of trackedOverlays) {
      if (!entry.target || !entry.target.isConnected) {
        entry.el.remove();
        continue;
      }
      const rect = entry.target.getBoundingClientRect();
      if (entry.type === "highlight") {
        positionOverBox(entry.el, rect);
      } else if (entry.type === "annotate") {
        positionCallout(entry.el, rect);
      }
    }
    // Prune removed
    trackedOverlays = trackedOverlays.filter(
      (e) => e.el.isConnected && e.target && e.target.isConnected
    );
  }

  function debouncedReposition() {
    if (repositionTimer) clearTimeout(repositionTimer);
    repositionTimer = setTimeout(repositionAll, REPOSITION_DEBOUNCE_MS);
  }

  // ── SPA Observers ─────────────────────────────────────────────────────

  function startObservers() {
    if (!mutationObserver) {
      mutationObserver = new MutationObserver(debouncedReposition);
      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    }
  }

  function trackElement(target, overlay, type) {
    trackedOverlays.push({ el: overlay, target, type });

    const ro = new ResizeObserver(debouncedReposition);
    ro.observe(target);
    resizeObservers.push(ro);
  }

  // ── Commands ───────────────────────────────────────────────────────────

  function cmdHighlight(cmd) {
    const root = ensureRoot();
    const color = cmd.color || DEFAULT_HIGHLIGHT_COLOR;
    const borderColor = opaqueColor(color, 0.6);
    const elements = queryElements(cmd.selector, cmd.maxElements);

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "fixed",
        boxSizing: "border-box",
        backgroundColor: color,
        border: `2px solid ${borderColor}`,
        borderRadius: "3px",
        pointerEvents: "none",
        overflow: "hidden",
      });
      positionOverBox(box, rect);
      box.appendChild(makeLabel());
      root.appendChild(box);
      trackElement(el, box, "highlight");
    }

    startObservers();
    return elements.length;
  }

  function cmdAnnotate(cmd) {
    const root = ensureRoot();
    const elements = queryElements(cmd.selector, cmd.maxElements);
    let message = typeof cmd.message === "string" ? cmd.message : "";
    if (message.length > MAX_MESSAGE_LENGTH) {
      message = message.slice(0, MAX_MESSAGE_LENGTH) + "…";
    }

    for (const el of elements) {
      const rect = el.getBoundingClientRect();

      // Subtle highlight on the target element
      const highlight = document.createElement("div");
      Object.assign(highlight.style, {
        position: "fixed",
        boxSizing: "border-box",
        border: "2px solid rgba(255, 193, 7, 0.6)",
        backgroundColor: "rgba(255, 193, 7, 0.1)",
        borderRadius: "3px",
        pointerEvents: "none",
      });
      positionOverBox(highlight, rect);
      root.appendChild(highlight);
      trackedOverlays.push({ el: highlight, target: el, type: "highlight" });

      // Callout box
      const callout = document.createElement("div");
      Object.assign(callout.style, {
        position: "fixed",
        boxSizing: "border-box",
        backgroundColor: "#1a1a2e",
        color: "#fff",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: "13px",
        lineHeight: "1.4",
        padding: "10px 12px",
        borderRadius: "8px",
        pointerEvents: "none",
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        maxWidth: "260px",
        wordWrap: "break-word",
        overflow: "hidden",
      });

      const text = document.createElement("div");
      text.textContent = message;
      callout.appendChild(text);
      callout.appendChild(makeLabel());

      positionCallout(callout, rect);
      root.appendChild(callout);
      trackElement(el, callout, "annotate");
    }

    startObservers();
    return elements.length;
  }

  function cmdToast(cmd) {
    const root = ensureRoot();
    const duration =
      typeof cmd.duration === "number" && cmd.duration > 0
        ? cmd.duration
        : DEFAULT_TOAST_DURATION;

    let text = typeof cmd.text === "string" ? cmd.text : "";
    if (text.length > MAX_MESSAGE_LENGTH) {
      text = text.slice(0, MAX_MESSAGE_LENGTH) + "…";
    }

    const toast = document.createElement("div");
    Object.assign(toast.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      maxWidth: "360px",
      backgroundColor: "#1a1a2e",
      color: "#fff",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "14px",
      lineHeight: "1.4",
      padding: "12px 16px",
      borderRadius: "10px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.35)",
      pointerEvents: "auto",
      opacity: "0",
      transform: "translateX(40px)",
      transition: "opacity 0.3s ease, transform 0.3s ease",
      wordWrap: "break-word",
      overflow: "hidden",
      zIndex: "2147483647",
    });

    const textEl = document.createElement("div");
    textEl.textContent = text;
    toast.appendChild(textEl);
    toast.appendChild(makeLabel());
    root.appendChild(toast);

    // Slide in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateX(0)";
      });
    });

    // Auto-dismiss
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(40px)";
      setTimeout(() => {
        if (toast.isConnected) toast.remove();
      }, 350);
    }, duration);

    return 1;
  }

  function clearAll() {
    // Remove all overlay elements
    if (overlayRoot && overlayRoot.isConnected) {
      overlayRoot.remove();
    }
    overlayRoot = null;

    // Disconnect observers
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    for (const ro of resizeObservers) {
      ro.disconnect();
    }
    resizeObservers = [];
    trackedOverlays = [];

    // Clear timers
    if (autoClearTimer) {
      clearTimeout(autoClearTimer);
      autoClearTimer = null;
    }
    if (repositionTimer) {
      clearTimeout(repositionTimer);
      repositionTimer = null;
    }
  }

  // ── Message Listener ──────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action !== "eyebrowse-overlay" || !message.command) {
      return false;
    }

    const cmd = message.command;
    let count = 0;

    try {
      switch (cmd.type) {
        case "highlight":
          count = cmdHighlight(cmd);
          resetAutoClear(cmd.autoClearMs);
          break;

        case "annotate":
          count = cmdAnnotate(cmd);
          resetAutoClear(cmd.autoClearMs);
          break;

        case "toast":
          count = cmdToast(cmd);
          // Toasts have their own dismiss; still reset the global clear
          resetAutoClear(cmd.autoClearMs);
          break;

        case "clear":
          clearAll();
          count = 0;
          break;

        default:
          sendResponse({ success: false, error: "Unknown command type: " + cmd.type });
          return false;
      }

      sendResponse({ success: true, count });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }

    return false; // synchronous response
  });

  // ── Reposition on scroll / resize ─────────────────────────────────────
  window.addEventListener("scroll", debouncedReposition, { passive: true });
  window.addEventListener("resize", debouncedReposition, { passive: true });

  // ── Interaction Commands ────────────────────────────────────────────

  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
    return `${tag}${id}${cls}`;
  }

  /** Find a visible, interactive element by its text content */
  function findByText(text) {
    const candidates = document.querySelectorAll('button, a, [role="button"], [role="link"], [role="menuitem"], input[type="submit"], label, summary');
    for (const el of candidates) {
      if (el.offsetParent === null && getComputedStyle(el).position !== "fixed" && getComputedStyle(el).position !== "sticky") continue;
      const elText = el.textContent?.trim();
      if (elText === text) return el;
    }
    // Fuzzy: check for includes (e.g. icon + text)
    for (const el of candidates) {
      if (el.offsetParent === null && getComputedStyle(el).position !== "fixed" && getComputedStyle(el).position !== "sticky") continue;
      const elText = el.textContent?.trim();
      if (elText && elText.includes(text) && elText.length < text.length * 3) return el;
    }
    return null;
  }

  function cmdClick(cmd) {
    let target;

    if (cmd.text) {
      target = findByText(cmd.text);
      if (!target) {
        return { success: false, error: `No element found with text: "${cmd.text}"` };
      }
      const rect = target.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight ||
          rect.left < 0 || rect.right > window.innerWidth) {
        target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      }
    } else if (cmd.selector) {
      target = document.querySelector(cmd.selector);
      if (!target) {
        return { success: false, error: `No element found for selector: ${cmd.selector}` };
      }
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return { success: false, error: "Element has zero dimensions (not visible)" };
      }
      // Scroll into view if offscreen
      if (rect.top < 0 || rect.bottom > window.innerHeight ||
          rect.left < 0 || rect.right > window.innerWidth) {
        target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      }
    } else if (cmd.x !== undefined && cmd.y !== undefined) {
      target = document.elementFromPoint(cmd.x, cmd.y);
      if (!target) {
        return { success: false, error: `No element at coordinates (${cmd.x}, ${cmd.y})` };
      }
    } else {
      return { success: false, error: "Either text, selector, or x/y coordinates required" };
    }

    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const buttonCode = cmd.button === "right" ? 2 : cmd.button === "middle" ? 1 : 0;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button: buttonCode,
    };

    target.dispatchEvent(new MouseEvent("mousedown", eventInit));
    target.dispatchEvent(new MouseEvent("mouseup", eventInit));
    target.dispatchEvent(new MouseEvent("click", eventInit));

    if (cmd.doubleClick) {
      target.dispatchEvent(new MouseEvent("mousedown", eventInit));
      target.dispatchEvent(new MouseEvent("mouseup", eventInit));
      target.dispatchEvent(new MouseEvent("click", eventInit));
      target.dispatchEvent(new MouseEvent("dblclick", { ...eventInit, detail: 2 }));
    }

    if (cmd.button === "right") {
      target.dispatchEvent(new MouseEvent("contextmenu", eventInit));
    }

    const text = (target.textContent || "").trim().slice(0, 80);
    return {
      success: true,
      clicked: describeElement(target),
      text: text || undefined,
      position: { x: Math.round(cx), y: Math.round(cy) },
    };
  }

  function cmdTypeSync(cmd) {
    let target;

    if (cmd.selector) {
      target = document.querySelector(cmd.selector);
      if (!target) {
        return { success: false, error: `No element found for selector: ${cmd.selector}` };
      }
    } else {
      target = document.activeElement;
      if (!target || target === document.body || target === document.documentElement) {
        return { success: false, error: "No element is focused and no selector provided" };
      }
    }

    target.focus();

    const isContentEditable = target.isContentEditable;
    const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

    if (!isContentEditable && !isInput) {
      return { success: false, error: `Element <${target.tagName.toLowerCase()}> is not an input, textarea, or contenteditable` };
    }

    if (cmd.clear) {
      if (isContentEditable) {
        target.textContent = "";
      } else {
        target.select();
        document.execCommand("delete", false);
      }
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }

    document.execCommand("insertText", false, cmd.text);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));

    if (cmd.pressEnter) {
      const enterInit = { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent("keydown", enterInit));
      target.dispatchEvent(new KeyboardEvent("keypress", enterInit));
      target.dispatchEvent(new KeyboardEvent("keyup", enterInit));
      const form = target.closest("form");
      if (form) {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    }

    const currentValue = isContentEditable
      ? (target.textContent || "").slice(0, 100)
      : (target.value || "").slice(0, 100);

    return {
      success: true,
      typed: cmd.text.length + " chars",
      currentValue,
      element: describeElement(target),
    };
  }

  async function cmdTypeAsync(cmd) {
    let target;

    if (cmd.selector) {
      target = document.querySelector(cmd.selector);
      if (!target) {
        return { success: false, error: `No element found for selector: ${cmd.selector}` };
      }
    } else {
      target = document.activeElement;
      if (!target || target === document.body || target === document.documentElement) {
        return { success: false, error: "No element is focused and no selector provided" };
      }
    }

    target.focus();

    const isContentEditable = target.isContentEditable;
    const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

    if (!isContentEditable && !isInput) {
      return { success: false, error: `Element <${target.tagName.toLowerCase()}> is not an input, textarea, or contenteditable` };
    }

    if (cmd.clear) {
      if (isContentEditable) {
        target.textContent = "";
      } else {
        target.select();
        document.execCommand("delete", false);
      }
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }

    for (const char of cmd.text) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
      document.execCommand("insertText", false, char);
      target.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      await new Promise(r => setTimeout(r, cmd.delay));
    }

    if (cmd.pressEnter) {
      const enterInit = { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent("keydown", enterInit));
      target.dispatchEvent(new KeyboardEvent("keypress", enterInit));
      target.dispatchEvent(new KeyboardEvent("keyup", enterInit));
      const form = target.closest("form");
      if (form) {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    }

    const currentValue = isContentEditable
      ? (target.textContent || "").slice(0, 100)
      : (target.value || "").slice(0, 100);

    return {
      success: true,
      typed: cmd.text.length + " chars",
      currentValue,
      element: describeElement(target),
    };
  }

  function cmdScroll(cmd) {
    // Mode 1: Scroll element into view
    if (cmd.selector) {
      const target = document.querySelector(cmd.selector);
      if (!target) {
        return { success: false, error: `No element found for selector: ${cmd.selector}` };
      }
      target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      const rect = target.getBoundingClientRect();
      return {
        success: true,
        scrolledTo: cmd.selector,
        elementPosition: { x: Math.round(rect.left), y: Math.round(rect.top) },
      };
    }

    // Mode 2: Scroll to edge
    if (cmd.toEdge) {
      if (cmd.toEdge === "top") {
        window.scrollTo({ top: 0, behavior: "instant" });
      } else if (cmd.toEdge === "bottom") {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      }
      return {
        success: true,
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
      };
    }

    // Mode 3: Directional scroll
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const isHorizontal = cmd.direction === "left" || cmd.direction === "right";
    const amount = cmd.amount || (isHorizontal ? viewportW * 0.8 : viewportH * 0.8);

    switch (cmd.direction) {
      case "down":  window.scrollBy({ top: amount, behavior: "instant" }); break;
      case "up":    window.scrollBy({ top: -amount, behavior: "instant" }); break;
      case "right": window.scrollBy({ left: amount, behavior: "instant" }); break;
      case "left":  window.scrollBy({ left: -amount, behavior: "instant" }); break;
    }

    return {
      success: true,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      atTop: window.scrollY <= 0,
      atBottom: Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight,
    };
  }

  // ── Interaction Message Listener ──────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action !== "eyebrowse-interact" || !message.command) {
      return false;
    }

    const cmd = message.command;

    try {
      switch (cmd.type) {
        case "click": {
          sendResponse(cmdClick(cmd));
          return false;
        }
        case "type": {
          if (cmd.delay && cmd.delay > 0) {
            cmdTypeAsync(cmd).then(result => sendResponse(result));
            return true; // async response
          }
          sendResponse(cmdTypeSync(cmd));
          return false;
        }
        case "scroll": {
          sendResponse(cmdScroll(cmd));
          return false;
        }
        default:
          sendResponse({ success: false, error: "Unknown interaction type: " + cmd.type });
          return false;
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
      return false;
    }
  });
})();
