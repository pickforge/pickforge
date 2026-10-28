#!/usr/bin/env node
// Build first. Open a native watch on one lab session and a browser watch on
// another. This script never opens a viewer on the caller's desktop.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { getSession, runCommand, processIdentityMatches } from "../../packages/core/dist/index.js";
import {
  findNativeViewerHost, readViewerLaunchRecord, withViewerDir,
  verifyOwnedDisplayTarget, findOnPath,
} from "../../packages/desktop-linux/dist/index.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node scripts/lab/viewer-bench.mjs --native-session <id> --novnc-session <id> [--seconds 60]");
  console.log("Open both watchers first. Use two explicit lab sessions, with exactly one Chromium fallback viewer.");
  console.log("The benchmark measures idle, scrolling, and text animation. It creates xterms only on the verified lab displays.");
  process.exit(0);
}
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} is required`);
  return args[index + 1];
}
const nativeId = option("--native-session");
const browserId = option("--novnc-session");
if (nativeId === browserId) throw new Error("Use two different explicit lab sessions");
const seconds = args.includes("--seconds") ? Number(option("--seconds")) : 60;
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) throw new Error("--seconds must be 1..600 (default 60)");
for (const tool of ["xterm", "xdotool"]) if (findOnPath(tool) === null) throw new Error(`${tool} is required`);
const records = await Promise.all([nativeId, browserId].map(async (id) => {
  const record = await getSession(id);
  if (record?.status !== "running" || !record.desktop ||
      !await verifyOwnedDisplayTarget(id, record.desktop.display, process.env)) throw new Error(`Unverified lab session: ${id}`);
  return record;
}));
const native = await findNativeViewerHost(nativeId);
if (!native) throw new Error("Open a native watch on --native-session first");
function isLiveChromiumLaunch(record) {
  if (!record || record.kind === "native") return false;
  if (record.browser.kind !== "chromium" || !record.pid || !record.startTicks) return false;
  return processIdentityMatches({ pid: record.pid, startTicks: record.startTicks });
}
const browser = await withViewerDir(browserId, process.env, false, async (directory) => {
  const launches = await directory.openChild("launches");
  try {
    const matches = [];
    for (const name of await launches.readEntryNames()) {
      const record = await readViewerLaunchRecord(browserId, name);
      if (isLiveChromiumLaunch(record)) matches.push(record);
    }
    if (matches.length !== 1) throw new Error("Open exactly one Chromium noVNC watch on --novnc-session first");
    return matches[0];
  } finally { await launches.close(); }
});
const desktop = records[1].desktop;
if (!desktop.vncPid || !desktop.viewerBridgePid) throw new Error("noVNC bridge and x11vnc must already be running");
for (const [pid, startTicks] of [[desktop.vncPid, desktop.vncStartTimeTicks], [desktop.viewerBridgePid, desktop.viewerBridgeStartTimeTicks]]) {
  if (!startTicks || !processIdentityMatches({ pid, startTicks })) throw new Error("Unverified noVNC process identity");
}
function proc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
    if (fields[0] === "Z") return undefined;
    return { pid, ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]), start: fields[19] };
  } catch { return undefined; }
}
const roots = {
  native: [native.pid, native.viewerPid],
  novnc: [browser.pid, desktop.viewerBridgePid, desktop.vncPid],
};
const identities = Object.values(roots).flat().map((pid) => proc(pid));
if (identities.some((identity) => !identity)) throw new Error("Viewer process exited before sampling");
const hzResult = await runCommand("getconf", ["CLK_TCK"]);
const hz = Number(hzResult.stdout.trim());
if (!hzResult.ok || !hz) throw new Error("Cannot read Linux clock tick frequency");
function sample() {
  const table = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map((name) => proc(Number(name))).filter(Boolean);
  const snapshot = {};
  for (const [kind, pids] of Object.entries(roots)) {
    const selected = new Set(pids);
    for (let changed = true; changed;) {
      changed = false;
      for (const entry of table) if (selected.has(entry.ppid) && !selected.has(entry.pid)) { selected.add(entry.pid); changed = true; }
    }
    snapshot[kind] = new Map(table.filter((entry) => selected.has(entry.pid)).map((entry) => [`${entry.pid}:${entry.start}`, entry.ticks]));
  }
  for (const identity of identities) {
    if (proc(identity.pid)?.start !== identity.start) throw new Error("Viewer process identity changed during benchmark");
  }
  return snapshot;
}
const terminals = [];
async function terminal(record, phase) {
  const animation = phase === "animation";
  const source = animation
    ? 'let n=0; setInterval(()=>{process.stdout.write("\\x1b[H\\x1b[2J" + ("frame " + n++ + " text animation ").repeat(300));}, 50)'
    : 'for(let n=0;n<2000;n++) console.log("scroll row " + n); setInterval(()=>{},1000)';
  const env = { ...process.env, DISPLAY: record.desktop.display, XAUTHORITY: "/dev/null", WAYLAND_DISPLAY: "" };
  const child = spawn("xterm", ["-display", record.desktop.display, "-geometry", "80x24+0+0", "-e", process.execPath, "-e", source], { env, stdio: "ignore" });
  terminals.push(child);
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  for (let attempt = 0; attempt < 40; attempt++) {
    const found = await runCommand("xdotool", ["search", "--pid", String(child.pid)], { env });
    const window = found.stdout.trim().split("\n")[0];
    if (found.ok && /^\d+$/.test(window)) return { child, env, window };
    await sleep(50);
  }
  throw new Error("Benchmark terminal did not map on its explicit lab display");
}
async function scrollWindows(windows) {
  for (const window of windows) {
    const result = await runCommand("xdotool", ["mousemove", "--window", window.window, "100", "100", "click", "--repeat", "3", "--delay", "10", "4"], { env: window.env });
    if (!result.ok) throw new Error("Scroll workload failed");
  }
}
function addTicks(total, previous, current) {
  for (const kind of Object.keys(total)) {
    for (const [key, ticks] of current[kind]) total[kind] += Math.max(0, ticks - (previous[kind].get(key) ?? 0));
  }
}
const results = [];
try {
  for (const phase of ["idle", "scroll", "animation"]) {
    for (const record of records) {
      if (!await verifyOwnedDisplayTarget(record.id, record.desktop.display, process.env)) throw new Error("Lab display identity changed");
    }
    const windows = phase === "idle" ? [] : await Promise.all(records.map((record) => terminal(record, phase)));
    await sleep(500);
    let previous = sample();
    const total = { native: 0, novnc: 0 };
    const started = performance.now();
    while (performance.now() - started < seconds * 1000) {
      if (phase === "scroll") await scrollWindows(windows);
      await sleep(100);
      const current = sample();
      addTicks(total, previous, current);
      previous = current;
    }
    const elapsedSeconds = (performance.now() - started) / 1000;
    const result = { phase, elapsedSeconds, clockTicksPerSecond: hz,
      native: { cpuSeconds: total.native / hz, cpuPercent: total.native / hz / elapsedSeconds * 100 },
      novnc: { cpuSeconds: total.novnc / hz, cpuPercent: total.novnc / hz / elapsedSeconds * 100 } };
    results.push(result);
    console.error(JSON.stringify(result));
    for (const window of windows) { window.child.kill("SIGTERM"); await new Promise((resolve) => window.child.once("exit", resolve)); }
  }
  console.log(JSON.stringify({ nativeSession: nativeId, novncSession: browserId, roots, results }, null, 2));
} finally {
  for (const child of terminals) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
