import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, updateSession, processIdentityMatches, readProcessIdentity, acquireHumanLease, readHumanLease, releaseHumanLease } from "@pickforge/lab-core";
import {
  startXvfb, stopXvfb, findOnPath, findNativeViewerHost, requestNativeViewerHost,
  withSessionVncLock, followNativeViewerRequest, pulseNativeViewer, withViewerDir, writeViewerPrivateFile, sessionViewerDir,
  lstatViewerSocket, viewerSocketIdentity,
  type NativeViewerHostIdentity, type XvfbHandle,
} from "@pickforge/lab-desktop-linux";
import { runNativeViewerHost, type NativeHostOptions } from "../src/viewer/native-host.js";
import { createViewerFakes, monitor, type ViewerFakes, type FakeViewerBehavior } from "./viewer-fakes.js";
import { unusedTestDisplay } from "../../desktop-linux/test/test-resources.js";
import { nativeViewerVersion } from "../src/viewer/native.js";
import { stackDir, STACK_PEEK, type StackMember } from "../src/viewer/stack.js";
import { buildMoveLua, THUMBNAIL_MARGIN } from "../src/viewer/hyprland.js";

const available = findOnPath("Xvfb") !== null;
let root: string;
let fakes: ViewerFakes;
let display: XvfbHandle;
let sessionId: string;
let running: Promise<number> | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-host-"));
  fakes = createViewerFakes(root);
  vi.stubEnv("PICKFORGE_HOME", root);
  vi.stubEnv("PATH", `${fakes.binDir}:${process.env.PATH}`);
  vi.stubEnv("DISPLAY", unusedTestDisplay());
  vi.stubEnv("WAYLAND_DISPLAY", "");
  vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "");
  running = undefined;
  if (!available) return;
  display = await startXvfb({ display: unusedTestDisplay(), logDir: root, width: 640, height: 480 });
  sessionId = (await createSession({ type: "desktop", projectDir: root, status: "running", desktop: {
    display: display.display, xvfbPid: display.pid, xvfbStartTimeTicks: display.startTimeTicks, width: 640, height: 480, homePolicy: "private",
  } })).id;
});
afterEach(async () => {
  // Only the owned fake child is stopped. This in-process host is the test worker.
  for (const call of fakes.calls().filter((entry) => entry.tool === "viewer")) {
    const identity = readProcessIdentity(Number(call.pid));
    if (identity !== undefined && processIdentityMatches(identity)) process.kill(identity.pid, "SIGKILL");
  }
  await running?.catch(() => {});
  if (available) await stopXvfb(display.pid, display.startTimeTicks);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
async function start(options: Partial<NativeHostOptions> = {}, behavior: FakeViewerBehavior = {}): Promise<NativeViewerHostIdentity> {
  const binary = fakes.installViewer({ version: nativeViewerVersion, ...behavior });
  running = runNativeViewerHost({ session: sessionId, binary, viewerVersion: nativeViewerVersion,
    _spawnWatchdog: () => ({ kill() {} }), _takeoverOptions: { heartbeatMs: 100, ttlMs: 5_000 }, ...options });
  for (let count = 0; count < 200; count++) {
    const host = await findNativeViewerHost(sessionId);
    if (host !== undefined) return host;
    await sleep(25);
  }
  throw new Error("Source host did not become ready");
}
async function until(check: () => boolean, timeoutMs = 2_500): Promise<void> {
  for (let count = 0; count < timeoutMs / 25 && !check(); count++) await sleep(25);
  expect(check()).toBe(true);
}

describe.skipIf(!available)("native host source behavior", () => {
  it("handles socket modes, session end, unknown events, and a clean close", async () => {
    const host = await start();
    await requestNativeViewerHost(host, { op: "expand" });
    await requestNativeViewerHost(host, { op: "collapse" });
    fakes.cueViewer({ event: "futureEvent", ignored: true });
    fakes.cueViewer({ event: "mode", mode: "fullscreen" });
    await expect.poll(async () => {
      const response = await requestNativeViewerHost(host, { op: "status" });
      return response.ok ? response.mode : undefined;
    }).toBe("fullscreen");
    await updateSession(sessionId, { status: "stopped" });
    await until(() => fakes.calls().some((entry) => entry.cmd === "sessionEnded"));
    expect(await requestNativeViewerHost(host, { op: "status" })).toMatchObject({ mode: "fullscreen", sessionEnded: true });
    fakes.cueViewer({ event: "sessionEnded", reason: "xvfb-gone" });
    fakes.cueViewer({ event: "closed" });
    expect(await running).toBe(0);
  }, 15_000);

  it("sends stopping before a plain shutdown without reporting session end", async () => {
    const host = await start();
    await requestNativeViewerHost(host, { op: "shutdown" });
    expect(await running).toBe(0);
    expect(fakes.calls().filter((entry) => entry.cmd !== undefined).map(({ cmd, code }) => ({ cmd, code }))).toEqual([
      { cmd: "status", code: "stopping" }, { cmd: "shutdown", code: undefined },
    ]);
  });

  it("handles host placement and the mode round trip through the Lua adapter", async () => {
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" }, monitors: [monitor()] });
    vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "test_native");
    vi.stubEnv("XDG_RUNTIME_DIR", path.join(root, "runtime"));
    const host = await start();
    fakes.cueViewer({ event: "expandRequested" });
    await until(() => fakes.calls().some((entry) => entry.cmd === "setMode" && entry.mode === "expanded"));
    fakes.cueViewer({ event: "collapseRequested" });
    await until(() => fakes.calls().some((entry) => entry.cmd === "setMode" && entry.mode === "thumbnail"));
    await requestNativeViewerHost(host, { op: "shutdown" });
    expect(await running).toBe(0);
  }, 15_000);

  it("cancels its record poll when shutdown happens under the teardown lock", async () => {
    const host = await start();
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { acquired = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const lock = withSessionVncLock(sessionId, process.env, async () => { acquired(); await released; });
    try {
      await held;
      const sentinels = (): number => fs.readdirSync(path.join(root, "sessions")).filter((name) => name.includes(".ensure-vnc.lock.")).length;
      await until(() => sentinels() === 2);
      await requestNativeViewerHost(host, { op: "shutdown" });
      expect(await running).toBe(0);
      await until(() => sentinels() === 1);
    } finally { release(); await lock; }
  }, 15_000);

  it("fails startup for a viewer readiness identity mismatch", async () => {
    const binary = fakes.installViewer({ readyPid: 1, version: nativeViewerVersion });
    running = runNativeViewerHost({ session: sessionId, binary, viewerVersion: nativeViewerVersion });
    await expect(running).rejects.toThrow("readiness identity");
  });
});

describe.skipIf(!available)("native host session title", () => {
  it("passes the title at launch and sends setTitle when the record changes", async () => {
    await updateSession(sessionId, { title: "Checkout flow test" });
    const host = await start();
    const args = fakes.calls().find((entry) => entry.tool === "viewer")!.args as string[];
    expect(args.slice(args.indexOf("--title"), args.indexOf("--title") + 2)).toEqual(["--title", "Checkout flow test"]);
    const titles = (): unknown[] => fakes.calls().filter((entry) => entry.cmd === "setTitle").map((entry) => entry.title);
    await sleep(600);
    expect(titles()).toEqual([]);
    await updateSession(sessionId, { title: "Pickforge GitHub issues" });
    await until(() => titles().length === 1);
    await updateSession(sessionId, { title: undefined });
    await until(() => titles().length === 2);
    expect(titles()).toEqual(["Pickforge GitHub issues", ""]);
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  });

  it("omits the title flag for a session without a title", async () => {
    const host = await start();
    expect(fakes.calls().find((entry) => entry.tool === "viewer")!.args).not.toContain("--title");
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  });
});

describe.skipIf(!available)("native host viewer stack", () => {
  const instance = "test_native";
  let runtime: string;
  beforeEach(() => {
    runtime = path.join(root, "runtime");
    fs.mkdirSync(runtime, { mode: 0o700 });
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" }, monitors: [monitor()] });
    vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", instance);
    vi.stubEnv("XDG_RUNTIME_DIR", runtime);
  });
  const memberFile = (launchId: string): string => path.join(stackDir({ xdgRuntimeDir: runtime, instance }), `${launchId}.json`);
  const readMember = (launchId: string): StackMember | undefined =>
    fs.existsSync(memberFile(launchId)) ? JSON.parse(fs.readFileSync(memberFile(launchId), "utf8")) as StackMember : undefined;
  const evals = (): string[] => fakes.calls().filter((entry) => entry.tool === "hyprctl" && (entry.args as string[])[2] === "eval")
    .map((entry) => (entry.args as string[])[3]!);
  const moved = (y: number, x: number): boolean => evals().includes(buildMoveLua("0xabc001", { x, y }));

  it("joins after mapping, fans out on hover, folds after leave, and leaves the stack while expanded", async () => {
    const host = await start();
    await until(() => readMember(host.launchId) !== undefined);
    const own = readMember(host.launchId)!;
    expect(own).toMatchObject({ launchId: host.launchId, sessionId, hostPid: host.pid, monitor: 0, mode: "thumbnail", hover: false, width: 384, height: 288 });
    expect(fs.statSync(memberFile(host.launchId)).mode & 0o777).toBe(0o600);
    const x = 1920 - 384 - THUMBNAIL_MARGIN;
    const top0 = 1080 - 288 - THUMBNAIL_MARGIN;
    // A newer live member stacked after this host: this host becomes the back card.
    const other = "f".repeat(32);
    const identity = readProcessIdentity(process.pid)!;
    fs.writeFileSync(memberFile(other), JSON.stringify({ ...own, launchId: other, sessionId: "desk-ffffff", hostPid: identity.pid,
      hostStartTicks: identity.startTicks, stackedAt: new Date(Date.parse(own.stackedAt) + 1_000).toISOString() }), { mode: 0o600 });
    await until(() => moved(top0 - STACK_PEEK, x));
    fakes.cueViewer({ event: "hover", inside: true });
    await until(() => readMember(host.launchId)?.hover === true);
    await until(() => moved(top0 - 288, x));
    fakes.cueViewer({ event: "hover", inside: false });
    await sleep(100);
    expect(readMember(host.launchId)?.hover).toBe(true);
    await until(() => readMember(host.launchId)?.hover === false);
    await until(() => evals().filter((lua) => lua === buildMoveLua("0xabc001", { x, y: top0 - STACK_PEEK })).length === 2);
    fakes.cueViewer({ event: "expandRequested" });
    await until(() => fakes.calls().some((entry) => entry.cmd === "setMode" && entry.mode === "expanded"));
    expect(readMember(host.launchId)?.mode).toBe("away");
    fakes.cueViewer({ event: "collapseRequested" });
    await until(() => fakes.calls().some((entry) => entry.cmd === "setMode" && entry.mode === "thumbnail"));
    await until(() => readMember(host.launchId)?.mode === "thumbnail");
    expect(Date.parse(readMember(host.launchId)!.stackedAt)).toBeGreaterThan(Date.parse(readMember(other)!.stackedAt));
    // A repeated collapse neither places nor raises the window, and keeps the slot.
    const stackedAt = readMember(host.launchId)!.stackedAt;
    const placements = evals().length;
    expect((await requestNativeViewerHost(host, { op: "collapse" })).ok).toBe(true);
    await sleep(200);
    expect(evals()).toHaveLength(placements);
    expect(readMember(host.launchId)!.stackedAt).toBe(stackedAt);
    // Every dispatch went to this host's own window.
    expect(evals().filter((lua) => lua.includes("address:")).every((lua) => lua.includes("address:0xabc001") && !lua.includes(other))).toBe(true);
    expect(controlCommands()).toEqual([]);
    expect(await readHumanLease(sessionId)).toBeUndefined();
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
    expect(readMember(host.launchId)).toBeUndefined();
  }, 20_000);

  it("queues a request timeout collapse behind a click expand, so an expanded card never stays in the stack", async () => {
    const host = await start();
    await until(() => readMember(host.launchId) !== undefined);
    const response = await requestNativeViewerHost(host, { op: "requestTakeover", message: "Help", timeoutMs: 100 });
    expect(response.ok).toBe(true);
    // Slow placements: the timeout collapse is still placing when the click arrives.
    fakes.setState({ status: { configProvider: "lua" }, monitors: [monitor()], evalDelayMs: 300 });
    await sleep(150);
    fakes.cueViewer({ event: "expandRequested" });
    const modes = (): unknown[] => fakes.calls().filter((entry) => entry.cmd === "setMode").map((entry) => entry.mode);
    await until(() => modes().length >= 3, 10_000);
    await sleep(500);
    expect(modes()).toEqual(["expanded", "thumbnail", "expanded"]);
    expect(readMember(host.launchId)?.mode).toBe("away");
    fakes.setState({ status: { configProvider: "lua" }, monitors: [monitor()] });
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  }, 20_000);

  it("keeps the viewer expanded when a newer request waits behind a timed-out one", async () => {
    const host = await start();
    await until(() => readMember(host.launchId) !== undefined);
    const first = await requestNativeViewerHost(host, { op: "requestTakeover", message: "First", timeoutMs: 250 });
    expect(first.ok).toBe(true);
    // A slow placement holds the queue; the second request waits behind it,
    // and the first one times out before the second one registers.
    fakes.setState({ status: { configProvider: "lua" }, monitors: [monitor()], evalDelayMs: 150 });
    fakes.cueViewer({ event: "expandRequested" });
    await sleep(50);
    // The reply can miss the client's 2 s limit on a loaded host; the viewer commands are the evidence.
    void requestNativeViewerHost(host, { op: "requestTakeover", message: "Second", timeoutMs: 10_000 }).catch(() => {});
    await until(() => fakes.calls().some((entry) => entry.cmd === "attention" && entry.message === "Second"), 10_000);
    await sleep(1_500);
    const modes = fakes.calls().filter((entry) => entry.cmd === "setMode").map((entry) => entry.mode);
    expect(modes.at(-1)).toBe("expanded");
    expect(fakes.calls().filter((entry) => entry.cmd === "attention").at(-1)).toMatchObject({ message: "Second" });
    expect(readMember(host.launchId)?.mode).toBe("away");
    fakes.setState({ status: { configProvider: "lua" }, monitors: [monitor()] });
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  }, 20_000);

  it("marks the card away in fullscreen and ignores hover there", async () => {
    const host = await start();
    await until(() => readMember(host.launchId) !== undefined);
    fakes.cueViewer({ event: "mode", mode: "fullscreen" });
    await until(() => readMember(host.launchId)?.mode === "away");
    fakes.cueViewer({ event: "hover", inside: true });
    await sleep(200);
    expect(readMember(host.launchId)?.hover).toBe(false);
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  }, 15_000);
});

async function take(): Promise<string> {
  fakes.cueViewer({ event: "takeRequested" });
  await until(() => fakes.calls().some((entry) => entry.cmd === "control" && entry.state === "granted"));
  return (await readHumanLease(sessionId))!.leaseId;
}

function controlCommands(): Array<Record<string, unknown>> {
  return fakes.calls().filter((entry) => entry.cmd === "control");
}

describe.skipIf(!available)("native host human control", () => {
  it("grants and renews the same lease, then returns through normal cleanup", async () => {
    const host = await start();
    const leaseId = await take();
    await until(() => controlCommands().filter((entry) => entry.state === "granted").length >= 3);
    expect(controlCommands().filter((entry) => entry.state === "granted")).toEqual(
      expect.arrayContaining([expect.objectContaining({ leaseId, grantMs: 200 })]));
    expect(new Set(controlCommands().map((entry) => entry.leaseId))).toEqual(new Set([leaseId]));
    fakes.cueViewer({ event: "returnRequested", reason: "button" });
    await expect.poll(() => readHumanLease(sessionId), { timeout: 4_000 }).toBeUndefined();
    expect(controlCommands().at(-1)).toMatchObject({ state: "revoked", leaseId, reason: "returned" });
    const count = controlCommands().length;
    await sleep(250);
    expect(controlCommands()).toHaveLength(count);
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  });

  it("takes the lease at explicit CLI startup after readiness", async () => {
    const host = await start({ control: true });
    await until(() => controlCommands().some((entry) => entry.state === "granted"));
    expect(await readHumanLease(sessionId)).toMatchObject({ inputTransport: "viewer", viewerPid: host.viewerPid, viewerStartTicks: host.viewerStartTicks });
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
    expect(await readHumanLease(sessionId)).toBeUndefined();
  });

  it("holds the startup lease before readiness without granting early input", async () => {
    const binary = fakes.installViewer({ version: nativeViewerVersion, noReady: true });
    running = runNativeViewerHost({ session: sessionId, binary, viewerVersion: nativeViewerVersion, control: true,
      _spawnWatchdog: () => ({ kill() {} }), _takeoverOptions: { heartbeatMs: 100, ttlMs: 5_000 } });
    await expect.poll(() => readHumanLease(sessionId), { timeout: 2_000 }).toMatchObject({ inputTransport: "viewer" });
    expect(controlCommands()).toEqual([]);
    await until(() => fakes.calls().some((entry) => entry.tool === "viewer"));
    fakes.cueViewer({ event: "ready", version: nativeViewerVersion,
      pid: fakes.calls().find((entry) => entry.tool === "viewer")!.pid, backend: "x11", scale: 1 });
    await until(() => controlCommands().some((entry) => entry.state === "granted"));
    const host = (await findNativeViewerHost(sessionId))!;
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
    expect(await readHumanLease(sessionId)).toBeUndefined();
  });

  it("ends control while teardown holds the session lock", async () => {
    const host = await start();
    await take();
    await withSessionVncLock(sessionId, process.env, async () => {
      await requestNativeViewerHost(host, { op: "shutdown" });
      await running;
      expect(await readHumanLease(sessionId)).toBeUndefined();
    });
  });

  it("answers unavailable without changing another human lease", async () => {
    const host = await start();
    const lease = await acquireHumanLease(sessionId);
    fakes.cueViewer({ event: "takeRequested" });
    await until(() => controlCommands().length > 0);
    expect(controlCommands()).toEqual([expect.objectContaining({ state: "revoked", leaseId: "", reason: "unavailable" })]);
    expect((await readHumanLease(sessionId))?.leaseId).toBe(lease.leaseId);
    await releaseHumanLease(sessionId, lease.leaseId);
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  });

  it("exits non-zero and reports a failed startup take", async () => {
    const lease = await acquireHumanLease(sessionId);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const binary = fakes.installViewer({ version: nativeViewerVersion });
      running = runNativeViewerHost({ session: sessionId, binary, viewerVersion: nativeViewerVersion, control: true });
      expect(await running).toBe(1);
      expect(stderr).toHaveBeenCalledWith("Native viewer could not take control");
      expect((await readHumanLease(sessionId))?.leaseId).toBe(lease.leaseId);
    } finally { stderr.mockRestore(); await releaseHumanLease(sessionId, lease.leaseId); }
  });

  it.each([false, true])("revokes a lost lease with noControlAck=%s", async (noControlAck) => {
    const host = await start({}, { noControlAck });
    const leaseId = await take();
    const started = Date.now();
    await releaseHumanLease(sessionId, leaseId);
    await until(() => controlCommands().some((entry) => entry.reason === "lease-lost"));
    expect(Date.now() - started).toBeLessThan(500);
    if (noControlAck) {
      await running;
      expect(Date.now() - started).toBeLessThan(1_600);
      expect(processIdentityMatches({ pid: host.viewerPid, startTicks: host.viewerStartTicks })).toBe(false);
    } else {
      await sleep(1_100);
      expect(processIdentityMatches({ pid: host.viewerPid, startTicks: host.viewerStartTicks })).toBe(true);
      await requestNativeViewerHost(host, { op: "shutdown" });
      await running;
    }
    expect(controlCommands().at(-1)).toMatchObject({ state: "revoked", leaseId, reason: "lease-lost" });
  });

  it.each(["close", "exit", "session", "shutdown"])("releases control on %s", async (path) => {
    const host = await start();
    await take();
    if (path === "close") {
      fakes.cueViewer({ event: "returnRequested", reason: "closed" });
      fakes.cueViewer({ event: "closed" });
    } else if (path === "exit") process.kill(host.viewerPid, "SIGKILL");
    else if (path === "session") await updateSession(sessionId, { status: "stopped" });
    else await requestNativeViewerHost(host, { op: "shutdown" });
    await expect.poll(() => readHumanLease(sessionId), { timeout: 4_000 }).toBeUndefined();
    if (path === "session") await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
    const reason = path === "close" ? "returned" : path === "session" ? "session-ended" : "stopping";
    if (path !== "exit") expect(controlCommands().at(-1)).toMatchObject({ state: "revoked", reason });
  }, 10_000);
});

async function rawRequest(host: NativeViewerHostIdentity, request: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = net.connect(host.socket);
    let body = "";
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => { body += chunk.toString(); });
    socket.once("end", () => resolve(JSON.parse(body)));
  });
}

describe.skipIf(!available)("native host request socket", () => {
  it("rejects every grant/input operation and malformed attention without acquiring a lease", async () => {
    const host = await start();
    for (const op of ["takeControl", "control", "takeRequested", "grant", "key", "pointer", "input"]) {
      expect(await rawRequest(host, { op })).toEqual({ ok: false, error: "unknown-operation" });
    }
    for (const message of ["x".repeat(501), "line\nbreak", "null\0byte", "delete\x7f", "c1\u0085"]) {
      expect(await rawRequest(host, { op: "requestTakeover", message, timeoutMs: 100 })).toEqual({ ok: false, error: "invalid-request" });
    }
    for (const timeoutMs of [-1, 1.5, 3_600_001, "100"]) {
      expect(await rawRequest(host, { op: "requestTakeover", message: "Help", timeoutMs })).toEqual({ ok: false, error: "invalid-request" });
    }
    expect(await rawRequest(host, { op: "status", grant: true })).toEqual({ ok: false, error: "invalid-request" });
    await requestNativeViewerHost(host, { op: "expand" });
    await requestNativeViewerHost(host, { op: "collapse" });
    expect(await readHumanLease(sessionId)).toBeUndefined();
    expect(controlCommands()).toEqual([]);
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  });

  it("expands without focus, sends attention, and uses literal notify-send argv", async () => {
    const notification = path.join(root, "notification.json");
    fs.writeFileSync(path.join(fakes.binDir, "notify-send"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(notification)}, JSON.stringify(process.argv.slice(2)));`, { mode: 0o755 });
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" }, monitors: [monitor()] });
    vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "test_native");
    vi.stubEnv("XDG_RUNTIME_DIR", path.join(root, "runtime"));
    const host = await start();
    const message = "Please help $(touch /never) `echo literal` <b>now</b>";
    const response = await requestNativeViewerHost(host, { op: "requestTakeover", message, timeoutMs: 2_000 });
    expect(response.ok && response.requestId).toBeTruthy();
    await until(() => fs.existsSync(notification));
    expect(JSON.parse(fs.readFileSync(notification, "utf8"))).toEqual([
      "--app-name=Pickforge", "--urgency=normal", "Pickforge needs your help", message.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    ]);
    expect(fakes.calls()).toContainEqual(expect.objectContaining({ cmd: "attention", message }));
    expect(fakes.calls().filter((entry) => entry.tool === "hyprctl").every((entry) => !JSON.stringify(entry.args).includes("focuswindow"))).toBe(true);
    expect(await readHumanLease(sessionId)).toBeUndefined();
    if (!response.ok) throw new Error("Request failed");
    await requestNativeViewerHost(host, { op: "cancelRequest", requestId: response.requestId! });
    expect(fakes.calls().some((entry) => entry.cmd === "control")).toBe(false);
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  });

  it("works when notify-send is absent", async () => {
    fs.rmSync(path.join(fakes.binDir, "notify-send"));
    vi.stubEnv("PATH", fakes.binDir);
    const host = await start();
    const response = await requestNativeViewerHost(host, { op: "requestTakeover", message: "Help", timeoutMs: 5_000 });
    expect(response.ok).toBe(true);
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  });

  it.each(["returned", "timeout", "cancelled", "viewer_closed"] as const)("subscribes to %s and replays completion", async (outcome) => {
    const host = await start();
    const response = await requestNativeViewerHost(host, { op: "requestTakeover", message: "Help", timeoutMs: outcome === "timeout" ? 80 : 5_000 });
    if (!response.ok || response.requestId === undefined) throw new Error("Request failed");
    const controller = new AbortController();
    const pending = followNativeViewerRequest(host, response.requestId, { signal: controller.signal, timeoutMs: 5_000 });
    if (outcome === "returned") {
      await take();
      fakes.cueViewer({ event: "returnRequested", reason: "button" });
    } else if (outcome === "cancelled") controller.abort();
    else if (outcome === "viewer_closed") fakes.cueViewer({ event: "closed" });
    expect(await pending).toBe(outcome);
    if (outcome === "viewer_closed") { await running; return; }
    expect(await followNativeViewerRequest(host, response.requestId, { signal: new AbortController().signal, timeoutMs: 100 })).toBe(outcome);
    expect(await readHumanLease(sessionId)).toBeUndefined();
    if (outcome !== "returned") await until(() => fakes.calls().some((entry) => entry.cmd === "setMode" && entry.mode === "thumbnail"));
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  });

  it("cancels attention without collapsing or ending control after take", async () => {
    const host = await start();
    const response = await requestNativeViewerHost(host, { op: "requestTakeover", message: "Help", timeoutMs: 5_000 });
    if (!response.ok || response.requestId === undefined) throw new Error("Request failed");
    const leaseId = await take();
    await requestNativeViewerHost(host, { op: "cancelRequest", requestId: response.requestId });
    expect((await readHumanLease(sessionId))?.leaseId).toBe(leaseId);
    expect(fakes.calls().some((entry) => entry.cmd === "setMode" && entry.mode === "thumbnail")).toBe(false);
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  });
});

describe.skipIf(!available)("native host click pulse", () => {
  const pulses = (): unknown[] => fakes.calls().filter((entry) => entry.cmd === "pulse").map(({ cmd, x, y }) => ({ cmd, x, y }));

  it("forwards a pulse for the verified Xvfb and refuses any other", async () => {
    const host = await start();
    const target = { display: display.display, pid: display.pid, startTicks: display.startTimeTicks };
    await pulseNativeViewer(sessionId, target, { x: 12, y: 34 });
    await until(() => pulses().length === 1);
    expect(pulses()).toEqual([{ cmd: "pulse", x: 12, y: 34 }]);
    const pulse = { op: "pulse", x: 1, y: 2, xvfbPid: display.pid, xvfbStartTicks: display.startTimeTicks };
    expect(await rawRequest(host, { ...pulse, xvfbStartTicks: display.startTimeTicks + 1 })).toEqual({ ok: false, error: "operation-failed" });
    expect(await rawRequest(host, { ...pulse, xvfbPid: process.pid })).toEqual({ ok: false, error: "operation-failed" });
    for (const bad of [{ x: -1 }, { y: 1.5 }, { x: 32_768 }, { y: "2" }, { xvfbPid: 0 }, { button: 1 }]) {
      expect(await rawRequest(host, { ...pulse, ...bad })).toEqual({ ok: false, error: "invalid-request" });
    }
    await sleep(50);
    expect(pulses()).toHaveLength(1);
    expect(await readHumanLease(sessionId)).toBeUndefined();
    expect(controlCommands()).toEqual([]);
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  });

  it("writes the pulse without waiting for a host that never reads", async () => {
    const stuck: net.Socket[] = [];
    const server = net.createServer({ pauseOnConnect: true }, (socket) => { stuck.push(socket); });
    await withViewerDir(sessionId, process.env, true, async (directory) => {
      server.listen(directory.resolve("host.sock"));
      await once(server, "listening");
      fs.chmodSync(directory.resolve("host.sock"), 0o600);
      const stats = (await lstatViewerSocket(directory.resolve("host.sock")))!;
      const identity = readProcessIdentity(process.pid)!;
      await writeViewerPrivateFile(directory, "host.json", JSON.stringify({
        version: nativeViewerVersion, sessionId, launchId: "a".repeat(32), ...identity,
        viewerPid: identity.pid, viewerStartTicks: identity.startTicks,
        socket: path.join(sessionViewerDir(sessionId, process.env), "host.sock"), ...viewerSocketIdentity(stats),
      }));
    });
    try {
      const started = performance.now();
      await pulseNativeViewer(sessionId, { display: display.display, pid: display.pid, startTicks: display.startTimeTicks }, { x: 5, y: 6 });
      expect(performance.now() - started).toBeLessThan(250);
      await until(() => stuck.length === 1);
      const data = once(stuck[0]!, "data");
      stuck[0]!.resume();
      const [chunk] = await data as [Buffer];
      expect(JSON.parse(chunk.toString("utf8"))).toMatchObject({ op: "pulse", x: 5, y: 6, xvfbPid: display.pid });
    } finally {
      for (const socket of stuck) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns quickly without a viewer", async () => {
    const started = Date.now();
    await pulseNativeViewer(sessionId, { display: display.display, pid: display.pid, startTicks: display.startTimeTicks }, { x: 1, y: 1 });
    expect(Date.now() - started).toBeLessThan(300);
  });
});

describe.skipIf(!available)("native host under a long session home", () => {
  it("serves a request, a subscription and a pulse when the socket path passes the limit", async () => {
    // The host binds through a descriptor path; clients must connect the same way (#413).
    const shortSocket = path.join(sessionViewerDir(sessionId), "host.sock");
    const home = path.join(root, "h".repeat(Math.max(1, 115 - Buffer.byteLength(shortSocket))));
    fs.mkdirSync(home, { mode: 0o700 });
    vi.stubEnv("PICKFORGE_HOME", home);
    sessionId = (await createSession({ type: "desktop", projectDir: root, status: "running", desktop: {
      display: display.display, xvfbPid: display.pid, xvfbStartTimeTicks: display.startTimeTicks, width: 640, height: 480, homePolicy: "private",
    } })).id;
    const host = await start();
    expect(Buffer.byteLength(host.socket)).toBeGreaterThan(107);
    const response = await requestNativeViewerHost(host, { op: "requestTakeover", message: "Help", timeoutMs: 5_000 });
    if (!response.ok || response.requestId === undefined) throw new Error("Request failed");
    const controller = new AbortController();
    let ready = false;
    const pending = followNativeViewerRequest(host, response.requestId, { signal: controller.signal, timeoutMs: 5_000, onReady: () => { ready = true; } });
    await until(() => ready);
    controller.abort();
    expect(await pending).toBe("cancelled");
    await pulseNativeViewer(sessionId, { display: display.display, pid: display.pid, startTicks: display.startTimeTicks }, { x: 7, y: 8 });
    await until(() => fakes.calls().some((entry) => entry.cmd === "pulse" && entry.x === 7 && entry.y === 8));
    await requestNativeViewerHost(host, { op: "shutdown" });
    await running;
  });
});
