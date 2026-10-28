import fs from "node:fs";
import path from "node:path";

/**
 * Fake `hyprctl` and browser executables for the viewer tests. Both append
 * one JSON line per call to a shared log, so a test can check the order of
 * rule install, browser spawn, client polls and rule disable.
 */

export interface FakeHyprlandState {
  status?: unknown;
  monitors?: unknown;
  /** Substring of a Lua chunk that makes `eval` fail like Hyprland does. */
  evalFailOn?: string;
}

export interface FakeBrowserBehavior {
  /** Register a Hyprland client for this process after this many ms. */
  mapAfterMs?: number;
  /** Exit with this code after `exitAfterMs`; otherwise run until signaled. */
  exitCode?: number;
  exitAfterMs?: number;
  /** Kill itself with this signal after `exitAfterMs`. */
  exitSignal?: NodeJS.Signals;
  floating?: boolean;
  /** Hyprland monitor id the client maps on. */
  monitor?: number;
  /** Ignore SIGINT and SIGTERM, like a browser that is slow to quit. */
  ignoreSignals?: boolean;
  /** Start a helper in the same process group that outlives this process. */
  forkChild?: boolean;
}

export interface FakeViewerBehavior {
  version?: string;
  readyPid?: number;
  readyVersion?: string;
  noReady?: boolean;
  ignoreSignals?: boolean;
  ignoreShutdown?: boolean;
  exitAfterMs?: number;
}

export interface ViewerFakes {
  binDir: string;
  callsLog: string;
  clientsFile: string;
  stateFile: string;
  calls(): Array<Record<string, unknown>>;
  setState(state: FakeHyprlandState): void;
  setBrowser(behavior: FakeBrowserBehavior): void;
  installViewer(behavior?: FakeViewerBehavior): string;
  cueViewer(event: Record<string, unknown>): void;
  installHyprctl(): string;
  installBrowser(name: string): string;
}

const HYPRCTL_SOURCE = `
const fs = require("node:fs");
const [callsLog, stateFile, clientsFile] = __PATHS__;
const args = process.argv.slice(2);
fs.appendFileSync(callsLog, JSON.stringify({ tool: "hyprctl", args, xdg: process.env.XDG_RUNTIME_DIR, sig: process.env.HYPRLAND_INSTANCE_SIGNATURE }) + "\\n");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const rest = args[0] === "--instance" ? args.slice(2) : args;
if (rest[0] === "-j") {
  const what = rest[1];
  if (what === "clients") {
    process.stdout.write(fs.existsSync(clientsFile) ? fs.readFileSync(clientsFile, "utf8") : "[]");
  } else {
    process.stdout.write(JSON.stringify(state[what] ?? {}));
  }
  process.exit(0);
}
if (rest[0] === "eval") {
  if (state.evalFailOn !== undefined && rest[1].includes(state.evalFailOn)) {
    process.stdout.write("error: refused\\n");
    process.exit(7);
  }
  process.stdout.write("ok\\n");
  process.exit(0);
}
process.exit(2);
`;

const BROWSER_SOURCE = `
const fs = require("node:fs");
const [callsLog, stateFile, clientsFile, behaviorFile] = __PATHS__;
const args = process.argv.slice(2);
const behavior = JSON.parse(fs.readFileSync(behaviorFile, "utf8"));
if (behavior.ignoreSignals) {
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
}
// Logged after the signal setup, so a test can wait for this line first.
fs.appendFileSync(callsLog, JSON.stringify({ tool: "browser", name: require("node:path").basename(process.argv[1]), args, pid: process.pid }) + "\\n");
if (behavior.forkChild) {
  const helper = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  helper.unref();
  fs.appendFileSync(callsLog, JSON.stringify({ tool: "browser-child", pid: helper.pid }) + "\\n");
}
const app = args.find((arg) => arg.startsWith("--app="));
if (behavior.mapAfterMs !== undefined && app !== undefined) {
  setTimeout(() => {
    const url = new URL(app.slice("--app=".length));
    const cls = "chrome-" + url.hostname + "_" + url.pathname.replace(/\\//g, "_") + "-Default";
    const clients = fs.existsSync(clientsFile) ? JSON.parse(fs.readFileSync(clientsFile, "utf8")) : [];
    clients.push({ address: "0x" + (0xabc000 + clients.length).toString(16), class: cls, pid: process.pid, floating: behavior.floating !== false, monitor: behavior.monitor ?? 0 });
    fs.writeFileSync(clientsFile, JSON.stringify(clients));
  }, behavior.mapAfterMs);
}
if (behavior.exitAfterMs !== undefined) {
  setTimeout(() => {
    if (behavior.exitSignal) process.kill(process.pid, behavior.exitSignal);
    else process.exit(behavior.exitCode ?? 0);
  }, behavior.exitAfterMs);
} else {
  setInterval(() => {}, 1000);
}
`;

const VIEWER_SOURCE = `
const fs = require("node:fs");
const [callsLog, stateFile, clientsFile, behaviorFile, viewerFile, cuesFile] = __PATHS__;
const args = process.argv.slice(2);
const behavior = JSON.parse(fs.readFileSync(viewerFile, "utf8"));
const version = behavior.version ?? "0.6.0";
if (args.includes("--version")) { console.log("pickforge-viewer " + version); process.exit(0); }
if (behavior.ignoreSignals) process.on("SIGTERM", () => {});
fs.appendFileSync(callsLog, JSON.stringify({ tool: "viewer", args, pid: process.pid, display: process.env.DISPLAY, wayland: process.env.WAYLAND_DISPLAY }) + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const cls = args[args.indexOf("--class") + 1];
fs.writeFileSync(clientsFile, JSON.stringify([{ address: "0xabc001", class: cls, pid: process.pid, floating: true, monitor: 0 }]));
if (!behavior.noReady) emit({ event: "ready", version: behavior.readyVersion ?? version, pid: behavior.readyPid ?? process.pid, backend: "x11", scale: 1 });
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  fs.appendFileSync(callsLog, JSON.stringify({ tool: "viewer-command", ...command }) + "\\n");
  if (command.cmd === "setMode") emit({ event: "mode", mode: command.mode });
  if (command.cmd === "shutdown" && !behavior.ignoreShutdown) process.exit(0);
}).on("close", () => { if (!behavior.ignoreShutdown) process.exit(0); });
let seen = 0;
setInterval(() => {
  const cues = fs.readFileSync(cuesFile, "utf8").split("\\n").filter(Boolean);
  while (seen < cues.length) emit(JSON.parse(cues[seen++]));
}, 25);
if (behavior.exitAfterMs !== undefined) setTimeout(() => process.exit(0), behavior.exitAfterMs);
`;

export function createViewerFakes(root: string): ViewerFakes {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const callsLog = path.join(root, "calls.jsonl");
  const stateFile = path.join(root, "hypr-state.json");
  const clientsFile = path.join(root, "hypr-clients.json");
  const behaviorFile = path.join(root, "browser.json");
  const viewerFile = path.join(root, "viewer.json");
  const cuesFile = path.join(root, "viewer-cues.jsonl");
  fs.writeFileSync(viewerFile, "{}");
  fs.writeFileSync(cuesFile, "");
  const paths = JSON.stringify([callsLog, stateFile, clientsFile, behaviorFile, viewerFile, cuesFile]);
  fs.writeFileSync(callsLog, "");
  fs.writeFileSync(stateFile, "{}");
  fs.writeFileSync(behaviorFile, "{}");
  const install = (name: string, source: string): string => {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!${process.execPath}\n${source.replace("__PATHS__", paths)}`);
    fs.chmodSync(file, 0o755);
    return file;
  };
  return {
    binDir,
    callsLog,
    clientsFile,
    stateFile,
    calls: () =>
      fs
        .readFileSync(callsLog, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    setState: (state) => fs.writeFileSync(stateFile, JSON.stringify(state)),
    setBrowser: (behavior) => fs.writeFileSync(behaviorFile, JSON.stringify(behavior)),
    installViewer: (behavior = {}) => {
      fs.writeFileSync(viewerFile, JSON.stringify(behavior));
      return install("pickforge-viewer", VIEWER_SOURCE);
    },
    cueViewer: (event) => fs.appendFileSync(cuesFile, `${JSON.stringify(event)}\n`),
    installHyprctl: () => install("hyprctl", HYPRCTL_SOURCE),
    installBrowser: (name) => install(name, BROWSER_SOURCE),
  };
}

export function monitor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 0,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    scale: 1,
    transform: 0,
    reserved: [0, 0, 0, 0],
    focused: true,
    ...overrides,
  };
}
