#!/usr/bin/env node
// Run only in an authorized Astra low execution lane. Never opens a host viewer.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const destinationKeys = new Set([
  "url", "host", "hostname", "host_and_port", "address", "addresses",
  "address_list", "ip_endpoint", "ip_endpoints", "remote_address",
  "peer_address", "endpoint",
]);

function destination(value) {
  if (/^(about|data|file|chrome):/.test(value)) return null;
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    const host = url.hostname.toLowerCase();
    if (["localhost", "[::1]"].includes(host) || /^127\./.test(host) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]+\]$/.test(host)) return null;
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    return url.host;
  } catch {
    return undefined;
  }
}

function collect(value, selected, found) {
  if (typeof value === "string" && selected) {
    const host = destination(value);
    if (host) found.destinations.add(host);
    if (host === undefined) found.unparsed++;
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, selected, found);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collect(item, destinationKeys.has(key), found);
    }
  }
}

async function report(netLog) {
  const log = JSON.parse(await readFile(netLog, "utf8"));
  if (!Array.isArray(log.events) || log.events.length === 0) {
    throw new Error("Net log contains no events; capture is not valid");
  }
  const found = { destinations: new Set(), unparsed: 0 };
  for (const event of log.events) collect(event.params, false, found);
  console.log("Non-loopback destinations observed in Chrome NetLog (requests/DNS/connect attempts, not proof of delivery):");
  console.log([...found.destinations].sort().join("\n") || "(none observed)");
  console.log(`Unparseable destination fields: ${found.unparsed}`);
  console.log("A quiet 90-second sample is not proof of no egress. Raw log stays private.");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function chromeBinary() {
  if (process.env.CHROME_BIN) return path.resolve(process.env.CHROME_BIN);
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"]) {
    try {
      const { stdout } = await exec("which", [name]);
      return stdout.trim();
    } catch { /* Try the next installed browser. */ }
  }
  throw new Error("Chrome not found; set CHROME_BIN to its absolute executable path");
}

async function closeBrowser(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(5000),
  });
  const { webSocketDebuggerUrl } = await response.json();
  const endpoint = new URL(webSocketDebuggerUrl);
  if (endpoint.hostname !== "127.0.0.1" || endpoint.port !== String(port)) {
    throw new Error("Refusing a non-session CDP endpoint");
  }
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out closing Chrome to flush NetLog"));
    }, 10000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })));
    socket.addEventListener("close", () => { clearTimeout(timer); resolve(); });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP close failed")); });
  });
}

async function waitForNetLog(file) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const log = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(log.events) && log.events.length > 0) return;
    } catch { /* Streaming NetLog is incomplete until Chrome writes its footer. */ }
    await delay(1000);
  }
  throw new Error("Chrome did not finish flushing NetLog within 30 seconds");
}

async function capture() {
  if (typeof WebSocket === "undefined") throw new Error("Capture requires Node.js 22 or newer");
  process.umask(0o077);
  const root = path.join(homedir(), ".pickforge", "lab", "chrome-egress-checks");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(path.join(root, "check-"));
  const projectDir = path.join(dir, "project");
  await mkdir(projectDir);
  const chrome = await chromeBinary();
  const lab = process.env.LAB_BIN || "pickforge-lab";
  const netLog = path.join(dir, "netlog.json");
  const wrapper = path.join(dir, "chrome-wrapper");
  await writeFile(wrapper, `#!/bin/sh\nexec ${shellQuote(chrome)} "$@" ${shellQuote(`--log-net-log=${netLog}`)} --net-log-capture-mode=Default\n`, { mode: 0o700 });
  // Fresh lab state/project; no inherited viewer setting, display, proxy or telemetry.
  const env = {
    HOME: homedir(), PATH: process.env.PATH, LANG: "C.UTF-8",
    PICKFORGE_HOME: path.join(dir, "state"), PICKFORGE_TELEMETRY: "0",
    PICKFORGE_CHROME_BIN: wrapper,
  };
  const run = (args) => exec(lab, [...args, "--project-dir", projectDir, "--json"], {
    env, cwd: projectDir, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  console.log(`Private evidence: ${dir}`);
  try {
    const created = await run(["session", "create", "--type", "browser", "--no-viewer"]);
    await writeFile(path.join(dir, "session.json"), created.stdout);
    // Use only the session returned from this fresh lab home.
    const status = JSON.parse(created.stdout);
    const sessions = status.sessions;
    if (!Array.isArray(sessions) || sessions.length !== 1 || !Number.isInteger(sessions[0].cdpPort)) {
      throw new Error("Unexpected session create response; see private session.json");
    }
    const session = sessions[0];
    console.log(`Headed browser on private Xvfb ${session.display}; observing about:blank for 90 seconds`);
    await delay(90000, undefined, { signal: controller.signal });
    await closeBrowser(session.cdpPort);
    // Browser.close disconnects before the process has finished flushing the file.
    await waitForNetLog(netLog);
  } finally {
    try {
      await run(["session", "destroy", "--all"]);
    } catch (error) {
      console.error(`Session cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  await report(netLog);
}

try {
  if (process.argv[2] === "--parse-net-log" && process.argv[3]) {
    await report(process.argv[3]);
  } else if (process.argv.length === 2) {
    await capture();
  } else {
    throw new Error("Usage: chrome-egress-check.mjs [--parse-net-log FILE]; LAB_BIN and CHROME_BIN select installed executables");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
