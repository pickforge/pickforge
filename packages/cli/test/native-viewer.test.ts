import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, updateSession, processIdentityMatches, withSessionVncLock } from "@pickforge/lab-core";
import {
  startXvfb, stopXvfb, findOnPath, startNativeViewerHost, findNativeViewerHost,
  stopNativeViewerHost, requestNativeViewerHost, sessionViewerDir, readViewerLaunchRecord,
  stopSessionViewer, destroyDesktopSession, prepareViewerLaunch, removeViewerLaunch, withViewerDir, writeViewerPrivateFile, validNativeViewerHost,
  type XvfbHandle, type NativeViewerHostIdentity,
} from "@pickforge/lab-desktop-linux";
import { ensureCliBuilt } from "./build-once.js";
import { createViewerFakes, monitor, type ViewerFakes } from "./viewer-fakes.js";
import { unusedTestDisplay } from "../../desktop-linux/test/test-resources.js";
import { detectNativeViewer, nativeViewerVersion } from "../src/viewer/native.js";
import { readViewerLines } from "../src/viewer/native-host.js";

const cliEntry = fileURLToPath(new URL("../dist/pickforge-lab.js", import.meta.url));
const available = findOnPath("Xvfb") !== null;
let root: string;
let fakes: ViewerFakes;
let env: NodeJS.ProcessEnv;
let sessionId: string;
let display: XvfbHandle;
let host: NativeViewerHostIdentity | undefined;

beforeAll(ensureCliBuilt, 300_000);
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-native-"));
  fakes = createViewerFakes(root);
  env = { ...process.env, PICKFORGE_HOME: root, PATH: `${fakes.binDir}:${process.env.PATH}` };
  delete env.WAYLAND_DISPLAY;
  delete env.HYPRLAND_INSTANCE_SIGNATURE;
  host = undefined;
  if (!available) return;
  display = await startXvfb({ display: unusedTestDisplay(), logDir: root, width: 640, height: 480, env });
  // Only the fake uses this nonexistent explicit host display; it never opens a window.
  env.DISPLAY = unusedTestDisplay();
  sessionId = (await createSession({ type: "desktop", status: "running", projectDir: root,
    desktop: { display: display.display, xvfbPid: display.pid, xvfbStartTimeTicks: display.startTimeTicks, width: 640, height: 480 } }, env)).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (available) {
    await stopSessionViewer(sessionId, undefined, env);
    await stopXvfb(display.pid, display.startTimeTicks);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function start(behavior: Parameters<ViewerFakes["installViewer"]>[0] = {}): Promise<NativeViewerHostIdentity> {
  const binary = fakes.installViewer({ version: nativeViewerVersion, ...behavior });
  host = await startNativeViewerHost({ sessionId, cliEntry, binary, version: nativeViewerVersion, env, readyMs: 4_000 });
  return host;
}

async function eventually(check: () => boolean): Promise<void> {
  for (let count = 0; count < 160; count++) {
    if (check()) return;
    await sleep(25);
  }
  expect(check()).toBe(true);
}

function rawRequest(value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(host!.socket);
    socket.setTimeout(3_000, () => socket.destroy(new Error("socket timeout")));
    let result = "";
    socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => { result += chunk.toString(); });
    socket.once("end", () => resolve(JSON.parse(result)));
    socket.once("error", reject);
  });
}

describe.skipIf(!available)("native viewer host", () => {
  it("launches detached, verifies readiness, passes the caller env and exact capture flags, and reuses the host", async () => {
    const found = await start();
    expect(await findNativeViewerHost(sessionId, env)).toEqual(found);
    expect(await startNativeViewerHost({ sessionId, cliEntry, binary: fakes.installViewer(), version: nativeViewerVersion, env })).toEqual(found);
    const call = fakes.calls().find((entry) => entry.tool === "viewer")!;
    expect(call.display).toBe(env.DISPLAY);
    expect(call.wayland).toBeUndefined();
    expect(call.args).toEqual(["--display", display.display, "--xvfb-pid", String(display.pid),
      "--xvfb-start-ticks", String(display.startTimeTicks), "--width", "640", "--height", "480",
      "--class", `pickforge-viewer-${found.launchId}`, "--thumbnail-width", "384", "--placement", "self"]);
    expect(fs.statSync(sessionViewerDir(sessionId, env)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(found.socket).mode & 0o777).toBe(0o600);
    const record = await readViewerLaunchRecord(sessionId, found.launchId, env);
    expect(record).toMatchObject({ kind: "native", hostPid: found.pid, viewerPid: found.viewerPid, viewerStartTicks: found.viewerStartTicks });
    await requestNativeViewerHost(found, { op: "expand" });
    await requestNativeViewerHost(found, { op: "collapse" });
    await eventually(() => fakes.calls().filter((entry) => entry.cmd === "setMode").length === 2);
    expect(fakes.calls().filter((entry) => entry.cmd === "setMode").map(({ cmd, mode, width, height }) => ({ cmd, mode, width, height }))).toEqual([
      { cmd: "setMode", mode: "expanded", width: undefined, height: undefined },
      { cmd: "setMode", mode: "thumbnail", width: undefined, height: undefined },
    ]);
    await requestNativeViewerHost(found, { op: "shutdown" });
    await eventually(() => !processIdentityMatches({ pid: found.viewerPid, startTicks: found.viewerStartTicks }));
  }, 20_000);

  it("replaces a live host from a different CLI version", async () => {
    const binary = fakes.installViewer({ version: "0.0.0" });
    const previous = await startNativeViewerHost({ sessionId, cliEntry, binary, version: "0.0.0", env });
    const next = await start();
    expect(next.pid).not.toBe(previous.pid);
    expect(next.version).toBe(nativeViewerVersion);
    expect(processIdentityMatches({ pid: previous.pid, startTicks: previous.startTicks })).toBe(false);
  }, 20_000);

  it("rejects unknown, prototype, input, grant and takeover socket operations", async () => {
    await start();
    for (const op of ["unknown", "__proto__", "constructor", "takeControl", "control", "key", "pointer", "requestTakeover", "subscribe"]) {
      expect(await rawRequest({ op })).toEqual({ ok: false, error: "unknown-operation" });
    }
    expect(await rawRequest({ op: "status", cmd: "control" })).toEqual({ ok: false, error: "invalid-request" });
    expect(await rawRequest({ op: 7 })).toEqual({ ok: false, error: "invalid-request" });
    expect(fakes.calls().some((entry) => entry.cmd === "control")).toBe(false);
  }, 20_000);

  it("installs the native Hyprland rule and rounds requested modes through compositor placement", async () => {
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" }, monitors: [monitor({ width: 600, height: 500 })] });
    env.HYPRLAND_INSTANCE_SIGNATURE = "native_test";
    env.XDG_RUNTIME_DIR = path.join(root, "runtime");
    await start();
    const install = fakes.calls().find((entry) => entry.tool === "hyprctl" && String(entry.args).includes("no_initial_focus"));
    expect(String(install?.args)).toContain(`^pickforge-viewer-${host!.launchId}$`);
    expect(String(install?.args)).toContain("float=true, pin=true, no_initial_focus=true");
    expect(String(fakes.calls().find((entry) => entry.tool === "viewer")?.args)).toContain("placement,host");
    fakes.cueViewer({ event: "expandRequested" });
    await eventually(() => fakes.calls().some((entry) => entry.cmd === "setMode" && entry.mode === "expanded"));
    expect(fakes.calls().find((entry) => entry.cmd === "setMode")).toMatchObject({ width: 540, height: 432 });
    fakes.cueViewer({ event: "collapseRequested" });
    await eventually(() => fakes.calls().some((entry) => entry.cmd === "setMode" && entry.mode === "thumbnail"));
    const chunks = fakes.calls().filter((entry) => entry.tool === "hyprctl").map((entry) => String(entry.args));
    expect(chunks.some((chunk) => chunk.includes("enabled=false"))).toBe(true);
    expect(chunks.filter((chunk) => chunk.includes("window.resize")).length).toBe(2);
    expect(chunks.some((chunk) => chunk.includes("focuswindow"))).toBe(false);
  }, 20_000);

  it("propagates session end while leaving the last-frame viewer open", async () => {
    await start();
    await updateSession(sessionId, { status: "stopped" }, env);
    await eventually(() => fakes.calls().some((entry) => entry.cmd === "sessionEnded"));
    expect(await requestNativeViewerHost(host!, { op: "status" })).toMatchObject({ sessionEnded: true });
  }, 20_000);

  it("destroys host and SIGTERM-ignoring viewer by recorded identity", async () => {
    await start({ ignoreSignals: true, ignoreShutdown: true });
    await destroyDesktopSession(sessionId, env);
    expect(processIdentityMatches({ pid: host!.pid, startTicks: host!.startTicks })).toBe(false);
    expect(processIdentityMatches({ pid: host!.viewerPid, startTicks: host!.viewerStartTicks })).toBe(false);
    expect(fakes.calls().some((entry) => entry.cmd === "status" && entry.code === "stopping")).toBe(true);
  }, 20_000);

  it("refuses stale readiness and socket identities, then stops by the saved launch record", async () => {
    await start();
    expect(validNativeViewerHost(null, sessionId, env)).toBe(false);
    expect(validNativeViewerHost({ ...host, socket: "/tmp/foreign.sock" }, sessionId, env)).toBe(false);
    await expect(requestNativeViewerHost({ ...host!, startTicks: host!.startTicks + 1 }, { op: "status" })).rejects.toThrow("identity");
    await expect(requestNativeViewerHost({ ...host!, socketIno: 1 }, { op: "status" })).rejects.toThrow("socket");
    await withViewerDir(sessionId, env, false, (directory) => writeViewerPrivateFile(directory, "host.json", JSON.stringify({ ...host, viewerStartTicks: host!.viewerStartTicks + 1 })));
    expect(await findNativeViewerHost(sessionId, env)).toBeUndefined();
    await expect(stopNativeViewerHost(sessionId, env)).rejects.toThrow("identity differs");
  }, 20_000);

  it.each(["prune", "missing-record"])("recovers dead readiness after %s without blocking the next native launch", async (cleanup) => {
    const previous = await start();
    await stopNativeViewerHost(sessionId, env);
    expect(processIdentityMatches({ pid: previous.pid, startTicks: previous.startTicks })).toBe(false);
    if (cleanup === "prune") {
      await prepareViewerLaunch(sessionId, env);
      expect(fs.existsSync(path.join(sessionViewerDir(sessionId, env), "host.json"))).toBe(false);
      expect(fs.existsSync(previous.socket)).toBe(false);
    } else {
      // Reproduce readiness left after the browser fallback pruned the launch.
      await withViewerDir(sessionId, env, false, (directory) => directory.unlinkChild("host.json"));
      await removeViewerLaunch(sessionId, previous.launchId, env);
      await withViewerDir(sessionId, env, false, (directory) => writeViewerPrivateFile(directory, "host.json", JSON.stringify(previous)));
      await stopNativeViewerHost(sessionId, env);
      expect(fs.existsSync(path.join(sessionViewerDir(sessionId, env), "host.json"))).toBe(false);
      expect(fs.existsSync(previous.socket)).toBe(false);
    }
    const next = await start();
    expect(next.launchId).not.toBe(previous.launchId);
  }, 20_000);

  it("waits for the session lock before removing dead readiness", async () => {
    const previous = await start();
    await stopNativeViewerHost(sessionId, env);
    const readiness = path.join(sessionViewerDir(sessionId, env), "host.json");
    await withViewerDir(sessionId, env, false, (directory) => writeViewerPrivateFile(directory, "host.json", JSON.stringify(previous)));
    let stopped: Promise<void> | undefined;
    // A concurrent start holds this lock while it publishes new readiness.
    await withSessionVncLock(sessionId, env, async () => {
      stopped = stopNativeViewerHost(sessionId, env);
      await sleep(300);
      expect(fs.existsSync(readiness)).toBe(true);
    });
    await stopped;
    expect(fs.existsSync(readiness)).toBe(false);
  }, 20_000);

  it.each([{ readyPid: 1 }, { readyVersion: "0.0.0" }, { noReady: true }])("cleans failed readiness %j", async (behavior) => {
    await expect(start(behavior)).rejects.toThrow(/startup|readiness/);
    for (const call of fakes.calls().filter((entry) => entry.tool === "viewer")) {
      expect(fs.existsSync(`/proc/${call.pid}`)).toBe(false);
    }
  }, 20_000);

  it("refuses an unowned display before spawning the host", async () => {
    await updateSession(sessionId, { desktop: { display: display.display, xvfbPid: process.pid, xvfbStartTimeTicks: 1 } }, env);
    await expect(start()).rejects.toThrow("verified");
    expect(fakes.calls()).toEqual([]);
  });
});

it("detects only a graphical, version-matched native viewer", async () => {
  env.DISPLAY = ":45678";
  env.PATH = fakes.binDir;
  expect(await detectNativeViewer(env)).toBeNull();
  const binary = fakes.installViewer({ version: nativeViewerVersion });
  expect(await detectNativeViewer(env)).toBe(binary);
  expect(await detectNativeViewer({ ...env, DISPLAY: undefined })).toBeNull();
  fakes.installViewer({ version: "0.0.0" });
  expect(await detectNativeViewer(env)).toBeNull();
});

it("bounds stdio frames and ignores unknown event fields", () => {
  const messages: unknown[] = [];
  let failures = 0;
  const stream = new Readable({ read() {} });
  readViewerLines(stream, (message) => messages.push(message), () => failures++);
  stream.emit("data", Buffer.from('{"event":"future","extra":1}\n'));
  stream.emit("data", Buffer.alloc(65_537, 120));
  expect(messages).toEqual([{ event: "future", extra: 1 }]);
  expect(failures).toBe(1);
});
