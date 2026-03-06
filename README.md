# Eyebrowse

**Give your AI agent eyes and hands in the browser.**

Eyebrowse is an MCP server that connects AI coding agents to real Chrome browsers. Not headless. Not isolated. Your browser, your session, AI-assisted.

## What is Eyebrowse?

Eyebrowse bridges AI agents and Chrome through the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). Your AI sees screenshots, reads page structure via accessibility trees, and interacts with pages -- clicking, typing, scrolling, navigating -- all in a real Chrome window you can watch and use alongside it.

Unlike headless browser tools, Eyebrowse operates in your actual browser. Same cookies, same logins, same tabs. The AI is a copilot in your browser, not a robot in a hidden one.

## Why Eyebrowse?

| | Eyebrowse | Playwright/Puppeteer MCP | Headless agents |
|---|---|---|---|
| Browser | Your real Chrome | Hidden headless browser | Hidden headless browser |
| Session | Shared -- your cookies, logins, state | Isolated -- starts fresh | Isolated |
| Visibility | You see everything the AI does | Invisible | Invisible |
| Interaction | AI and human use the same window | AI only | AI only |
| Setup | Extension + daemon | npm package | Varies |

## Use Cases

- **Web scraping** -- "Search for X on these 5 sites, extract prices and links" (supports parallel workers with separate windows)
- **QA review** -- "Look at this page and tell me what's broken"
- **Form filling** -- "Fill out this application with these details"
- **Research** -- "Find recent articles about Y, summarize the top 3"
- **Page capture** -- "Save this page as a PDF" or "Take a screenshot of the dashboard"
- **Debugging** -- "Open localhost:3000, click the login button, tell me what happens"
- **Monitoring** -- watch a page for changes using your existing logged-in session
- **Workflow automation** -- automate repetitive browser tasks in your authenticated session

## Features

- **Screenshots** -- capture visible tab or full-page screenshots as JPEG
- **Accessibility tree** -- read page structure via Chrome DevTools Protocol
- **Click, type, scroll, navigate** -- full browser interaction by CSS selector, text content, or coordinates
- **Multi-window and multi-tab** -- pair specific windows to sessions, list and switch tabs
- **Highlights and annotations** -- overlay elements with colored highlights, callout annotations, or toast messages
- **Print to PDF** -- export pages with configurable paper size, orientation, and page ranges
- **Evaluate JavaScript** -- run expressions in the page context and return structured data, ideal for bulk DOM extraction
- **Auto-start daemon** -- MCP server spawns the daemon automatically on first tool call
- **Session isolation** -- each Claude Code session registers independently with its own pairing

## Quick Install

```sh
npx eyebrowse install
```

The installer checks prerequisites, configures Claude Code's MCP settings, and walks you through loading the Chrome extension. See [Manual Setup](#manual-setup) if you prefer to do it yourself.

## Manual Setup

### 1. Install Bun

```sh
curl -fsSL https://bun.sh/install | bash
```

### 2. Clone the repository

```sh
git clone https://github.com/evan108108/eyebrowse.git
cd eyebrowse
```

### 3. Install dependencies

```sh
bun install
```

### 4. Load the Chrome extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` directory from this repository

### 5. Add the MCP server to Claude Code

Add the following to `~/.claude.json` (or your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "eyebrowse": {
      "command": "bun",
      "args": ["run", "/path/to/eyebrowse/mcp/index.ts"]
    }
  }
}
```

Replace `/path/to/eyebrowse` with the actual path where you cloned the repo.

## Architecture

```
+-------------------+       WebSocket        +-------------------+       stdio/MCP       +-------------------+
|                   |  ws://localhost:7890/ws |                   |                       |                   |
|  Chrome Extension |<---------------------->|  Daemon (Bun)     |<--------------------->|  MCP Server       |
|  (Manifest V3)    |                        |  Port 7890        |   HTTP JSON API       |  (stdio transport)|
|                   |  events, bridge req/res|                   |                       |                   |
+-------------------+                        +-------------------+                       +-------------------+
        |                                            |                                           |
        v                                            v                                           v
  chrome.tabs API                             Session registry                            Claude Code
  chrome.debugger API                         Window pairing                              (MCP client)
  chrome.scripting API                        Auth token management
  Content script injection                    Rate limiting
```

**Chrome Extension** -- Manifest V3 service worker that connects to the daemon over WebSocket. Bridges Chrome APIs (tabs, debugger, scripting) to daemon requests. Handles screenshots, accessibility tree capture, page interactions, overlays, and PDF export. Maintains a persistent connection with keepalive pings and exponential backoff reconnection.

**Daemon** -- Bun HTTP + WebSocket server on port 7890. Routes tool calls from the MCP server to the extension, manages session registration, window pairing, and authentication. Runs a stale session reaper every 2 minutes.

**MCP Server** -- Thin MCP-protocol wrapper that exposes 21 tools over stdio. Communicates with the daemon via HTTP. Auto-starts the daemon if unreachable. Each instance registers as a session identified by the working directory name.

## Available Tools

| Tool | Description |
|------|-------------|
| `look` | Screenshot + page URL/title. Optionally include the accessibility tree. |
| `screenshot` | Capture a screenshot of the current page. Supports full-page and quality settings. |
| `get_page_info` | Get current page URL and title. Optionally include the accessibility tree. |
| `browser_status` | Check connection health and paired window info. |
| `list_windows` | List all Chrome windows. |
| `pair_window` | Pair with a Chrome window by its window ID. |
| `unpair` | Release the currently paired Chrome window. |
| `open_browser` | Open a new Chrome window at the given URL. Auto-pairs to the session. |
| `click` | Click an element by CSS selector, visible text, or x/y coordinates. |
| `type` | Type text into an element. Supports clearing, pressing Enter, and keystroke delay. |
| `scroll` | Scroll the page by direction/amount, to an edge, or scroll an element into view. |
| `navigate` | Navigate to a URL, or go back/forward/reload. |
| `highlight` | Highlight elements matching a CSS selector with a configurable color. |
| `annotate` | Add a callout annotation near an element. |
| `show_message` | Show a toast notification in the browser. |
| `clear_overlays` | Remove all highlights and annotations from the page. |
| `list_tabs` | List all tabs in the paired Chrome window. |
| `switch_tab` | Switch to a specific tab by its tab ID. |
| `close_window` | Close the paired window or a specific window by ID. |
| `evaluate` | Execute a JavaScript expression in the page and return the result. Use for bulk DOM data extraction. |
| `print_to_pdf` | Export the current page as a PDF file. Returns the file path. |

## How It Works

1. **Connect** -- The Chrome extension opens a WebSocket connection to the daemon at `ws://localhost:7890/ws`. The daemon validates the origin is a `chrome-extension://` URL.

2. **Register** -- When Claude Code starts a session, the MCP server registers with the daemon over HTTP, receiving a session ID and bearer token. If the daemon is not running, the MCP server spawns it automatically.

3. **Pair** -- A Chrome window is paired to the session, either from the extension popup or programmatically via `open_browser` or `pair_window`. Each window can only be paired to one session at a time.

4. **Execute** -- Claude Code calls MCP tools. The MCP server forwards them as HTTP requests to the daemon, which translates them into bridge requests over WebSocket to the extension. The extension executes them using Chrome APIs and returns results back through the same chain.

## Security

Eyebrowse operates entirely locally. Your data never leaves your machine. No cloud services, no telemetry, no external connections.

- **Local-only** -- The daemon binds to `localhost:7890`. The extension connects only to `ws://localhost:7890/ws`.
- **Token authentication** -- The daemon generates a random UUID token on first run, stored at `~/.eyebrowse/daemon.token` with `0600` permissions. All HTTP requests require this token as a Bearer header. Constant-time comparison prevents timing attacks.
- **Origin validation** -- WebSocket upgrades are rejected unless the origin starts with `chrome-extension://`.
- **CDP allowlist** -- Only four Chrome DevTools Protocol commands are permitted: `Accessibility.getFullAXTree`, `Accessibility.getPartialAXTree`, `Page.printToPDF`, and `Runtime.evaluate`.
- **URL validation** -- `open_browser` and `navigate` only accept `http:` and `https:` URLs.
- **Rate limiting** -- `open_browser` is limited to 3 calls per minute per session.
- **Session isolation** -- Each MCP server instance registers as a separate session with independent window pairing.

## Development

### Run the daemon

```sh
bun run daemon/index.ts
```

The daemon starts on `http://localhost:7890`. Logs go to stderr. A daemon token is created at `~/.eyebrowse/daemon.token` on first run.

### Run the MCP server (standalone)

```sh
bun run mcp/index.ts
```

The MCP server communicates over stdio. It will auto-start the daemon if it is not already running.

### Optional: launchd (macOS auto-start)

A template plist is provided at `com.eyebrowse.daemon.plist`. Replace the placeholder paths (`__BUN_PATH__`, `__EYEBROWSE_HOME__`, `__BUN_DIR__`) and copy to `~/Library/LaunchAgents/` to have the daemon start at login.

## License

MIT
