#!/usr/bin/env node

// eyebrowse installer — plain Node.js, no dependencies
// Usage: npx eyebrowse install

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
};

const ok = `${c.green}✔${c.reset}`;
const warn = `${c.yellow}⚠${c.reset}`;
const fail = `${c.red}✖${c.reset}`;
const arrow = `${c.cyan}→${c.reset}`;
const dot = `${c.dim}·${c.reset}`;

function heading(n, text) {
  console.log(`\n${c.bold}${c.blue}[${n}]${c.reset} ${c.bold}${text}${c.reset}`);
}

function info(text) {
  console.log(`  ${dot} ${text}`);
}

function success(text) {
  console.log(`  ${ok} ${text}`);
}

function warning(text) {
  console.log(`  ${warn} ${text}`);
}

function error(text) {
  console.log(`  ${fail} ${text}`);
}

function banner() {
  console.log(`
${c.bold}${c.cyan}  ╭──────────────────────────────────╮
  │         ${c.white}eyebrowse${c.cyan}  installer       │
  │   ${c.dim}Chrome bridge for AI agents${c.cyan}${c.bold}     │
  ╰──────────────────────────────────╯${c.reset}
`);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function which(cmd) {
  try {
    return execSync(`which ${cmd}`, { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${arrow} ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Step 1 — Prerequisites
// ---------------------------------------------------------------------------
function checkPrereqs() {
  heading(1, "Checking prerequisites");

  // Node
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split(".")[0], 10);
  if (major < 18) {
    error(`Node.js >= 18 required (found v${nodeVersion})`);
    process.exit(1);
  }
  success(`Node.js v${nodeVersion}`);

  // Bun
  const bunPath = which("bun");
  if (!bunPath) {
    error("Bun is required but not found in PATH");
    info(`Install: ${c.cyan}curl -fsSL https://bun.sh/install | bash${c.reset}`);
    process.exit(1);
  }
  let bunVersion = "";
  try {
    bunVersion = run("bun --version");
  } catch {
    // ignore
  }
  success(`Bun ${bunVersion} ${c.dim}(${bunPath})${c.reset}`);

  // Git (needed if cloning)
  const gitPath = which("git");
  if (gitPath) {
    success(`Git found ${c.dim}(${gitPath})${c.reset}`);
  } else {
    warning("Git not found — install will only work from cloned repo");
  }

  return { bunPath };
}

// ---------------------------------------------------------------------------
// Step 2 — Install location
// ---------------------------------------------------------------------------
function resolveInstallDir() {
  heading(2, "Resolving install location");

  // If the script is running from inside the cloned repo, use that
  const scriptDir = path.resolve(__dirname, "..");
  const mcpIndex = path.join(scriptDir, "mcp", "index.ts");
  const daemonIndex = path.join(scriptDir, "daemon", "index.ts");

  if (fs.existsSync(mcpIndex) && fs.existsSync(daemonIndex)) {
    success(`Using existing repo: ${c.cyan}${scriptDir}${c.reset}`);
    return scriptDir;
  }

  // Otherwise clone to ~/.eyebrowse
  const defaultDir = path.join(os.homedir(), ".eyebrowse");

  if (fs.existsSync(path.join(defaultDir, "mcp", "index.ts"))) {
    success(`Already installed at: ${c.cyan}${defaultDir}${c.reset}`);
    return defaultDir;
  }

  info(`Cloning to ${c.cyan}${defaultDir}${c.reset}`);

  const gitPath = which("git");
  if (!gitPath) {
    error("Git is required to clone the repository");
    process.exit(1);
  }

  try {
    run(`git clone https://github.com/evan108108/eyebrowse.git "${defaultDir}"`);
    success("Repository cloned");
  } catch (e) {
    error(`Clone failed: ${e.message}`);
    process.exit(1);
  }

  return defaultDir;
}

// ---------------------------------------------------------------------------
// Step 3 — Install dependencies
// ---------------------------------------------------------------------------
function installDeps(installDir) {
  heading(3, "Installing dependencies");

  try {
    info("Running bun install...");
    run("bun install", { cwd: installDir, stdio: "pipe" });
    success("Dependencies installed");
  } catch (e) {
    error(`bun install failed: ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Step 4 — Configure Claude Code MCP
// ---------------------------------------------------------------------------
function configureMcp(installDir) {
  heading(4, "Configuring Claude Code MCP");

  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  let config = {};

  if (fs.existsSync(claudeJsonPath)) {
    try {
      config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8"));
      info("Found existing ~/.claude.json");
    } catch (e) {
      warning(`Could not parse ~/.claude.json — creating fresh: ${e.message}`);
      config = {};
    }
  } else {
    info("Creating ~/.claude.json");
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const mcpEntry = {
    type: "stdio",
    command: "bun",
    args: ["run", path.join(installDir, "mcp", "index.ts")],
  };

  const existing = config.mcpServers.eyebrowse;
  if (existing && existing.args && existing.args[1] === mcpEntry.args[1]) {
    success("MCP already configured (unchanged)");
  } else {
    config.mcpServers.eyebrowse = mcpEntry;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + "\n");
    success(`Added ${c.cyan}mcpServers.eyebrowse${c.reset} to ~/.claude.json`);
  }
}

// ---------------------------------------------------------------------------
// Step 5 — Chrome extension instructions
// ---------------------------------------------------------------------------
function chromeExtension(installDir) {
  heading(5, "Chrome Extension");

  const extDir = path.join(installDir, "extension");

  if (!fs.existsSync(path.join(extDir, "manifest.json"))) {
    warning("Extension directory not found — skipping");
    return;
  }

  console.log(`
  ${c.bold}Manual setup required:${c.reset}

  ${c.white}1.${c.reset} Open ${c.cyan}chrome://extensions${c.reset} in Chrome
  ${c.white}2.${c.reset} Enable ${c.bold}Developer mode${c.reset} (top-right toggle)
  ${c.white}3.${c.reset} Click ${c.bold}Load unpacked${c.reset}
  ${c.white}4.${c.reset} Select: ${c.cyan}${extDir}${c.reset}
`);
}

// ---------------------------------------------------------------------------
// Step 6 — macOS launchd (optional)
// ---------------------------------------------------------------------------
async function setupLaunchd(installDir, bunPath) {
  if (process.platform !== "darwin") return;

  heading(6, "macOS Launch Daemon (optional)");

  const answer = await ask("Install launchd plist to auto-start daemon? [y/N]");
  if (answer !== "y" && answer !== "yes") {
    info("Skipped");
    return;
  }

  const templatePath = path.join(installDir, "com.eyebrowse.daemon.plist");
  if (!fs.existsSync(templatePath)) {
    warning("Plist template not found — skipping");
    return;
  }

  const bunDir = path.dirname(bunPath);
  let plist = fs.readFileSync(templatePath, "utf-8");
  plist = plist.replace(/__BUN_PATH__/g, bunPath);
  plist = plist.replace(/__EYEBROWSE_HOME__/g, installDir);
  plist = plist.replace(/__BUN_DIR__/g, bunDir);

  const plistDest = path.join(os.homedir(), "Library", "LaunchAgents", "com.eyebrowse.daemon.plist");
  const launchAgentsDir = path.dirname(plistDest);

  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  fs.writeFileSync(plistDest, plist);
  success(`Plist written to ${c.cyan}${plistDest}${c.reset}`);

  // Unload if already loaded, ignore errors
  try {
    run(`launchctl unload "${plistDest}" 2>/dev/null`);
  } catch {
    // ignore
  }

  try {
    run(`launchctl load "${plistDest}"`);
    success("Daemon registered with launchd");
  } catch (e) {
    warning(`launchctl load failed: ${e.message}`);
    info(`Try manually: ${c.cyan}launchctl load "${plistDest}"${c.reset}`);
  }
}

// ---------------------------------------------------------------------------
// Step 7 — Verify
// ---------------------------------------------------------------------------
async function verify(installDir, bunPath) {
  const stepNum = process.platform === "darwin" ? 7 : 6;
  heading(stepNum, "Verifying installation");

  // Check if daemon is already running
  let daemonUp = false;
  try {
    // Node 18+ fetch
    const res = await fetch("http://localhost:7890/health", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      daemonUp = true;
      success("Daemon already running");
    }
  } catch {
    // not running, try to start
  }

  if (!daemonUp) {
    info("Starting daemon...");
    const daemonScript = path.join(installDir, "daemon", "index.ts");
    const child = spawn(bunPath || "bun", ["run", daemonScript], {
      detached: true,
      stdio: "ignore",
      cwd: installDir,
    });
    child.unref();

    // Wait for it to come up
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      try {
        const res = await fetch("http://localhost:7890/health", {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) {
          daemonUp = true;
          break;
        }
      } catch {
        // keep trying
      }
    }

    if (daemonUp) {
      success("Daemon started and healthy");
    } else {
      warning("Daemon did not respond — it may need manual start");
      info(`Try: ${c.cyan}bun run ${path.join(installDir, "daemon", "index.ts")}${c.reset}`);
    }
  }

  // Final summary
  console.log(`
${c.bold}${c.green}  ╭──────────────────────────────────╮
  │       Installation complete!      │
  ╰──────────────────────────────────╯${c.reset}

  ${c.bold}Install dir:${c.reset}  ${c.cyan}${installDir}${c.reset}
  ${c.bold}Daemon:${c.reset}       ${daemonUp ? `${c.green}running${c.reset} on http://localhost:7890` : `${c.yellow}not confirmed${c.reset}`}
  ${c.bold}MCP server:${c.reset}   ${c.green}configured${c.reset} in ~/.claude.json

  ${c.dim}Restart Claude Code to pick up the MCP server.${c.reset}
  ${c.dim}Load the Chrome extension if you haven't already.${c.reset}
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  banner();

  const { bunPath } = checkPrereqs();
  const installDir = resolveInstallDir();
  installDeps(installDir);
  configureMcp(installDir);
  chromeExtension(installDir);
  await setupLaunchd(installDir, bunPath);
  await verify(installDir, bunPath);
}

main().catch((e) => {
  error(`Fatal: ${e.message}`);
  process.exit(1);
});
