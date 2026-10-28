import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, updateSession, processIdentityMatches, readProcessIdentity } from "@pickforge/lab-core";
import {
  startXvfb, stopXvfb, findOnPath, findNativeViewerHost, requestNativeViewerHost,
  withSessionVncLock, type NativeViewerHostIdentity, type XvfbHandle,
} from "@pickforge/lab-desktop-linux";
import { runNativeViewerHost } from "../src/viewer/native-host.js";
import { createViewerFakes, monitor, type ViewerFakes } from "./viewer-fakes.js";
import { unusedTestDisplay } from "../../desktop-linux/test/test-resources.js";
import { nativeViewerVersion } from "../src/viewer/native.js";

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
    display: display.display, xvfbPid: display.pid, xvfbStartTimeTicks: display.startTimeTicks, width: 640, height: 480,
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
async function start(): Promise<NativeViewerHostIdentity> {
  const binary = fakes.installViewer({ version: nativeViewerVersion });
  running = runNativeViewerHost({ session: sessionId, binary, viewerVersion: nativeViewerVersion });
  for (let count = 0; count < 200; count++) {
    const host = await findNativeViewerHost(sessionId);
    if (host !== undefined) return host;
    await sleep(25);
  }
  throw new Error("Source host did not become ready");
}
async function until(check: () => boolean): Promise<void> {
  for (let count = 0; count < 100 && !check(); count++) await sleep(25);
  expect(check()).toBe(true);
}

describe.skipIf(!available)("native host source behavior", () => {
  it("handles socket modes, session end, unknown events, and a clean close", async () => {
    const host = await start();
    await requestNativeViewerHost(host, { op: "expand" });
    await requestNativeViewerHost(host, { op: "collapse" });
    fakes.cueViewer({ event: "futureEvent", ignored: true });
    fakes.cueViewer({ event: "mode", mode: "fullscreen" });
    await updateSession(sessionId, { status: "stopped" });
    await until(() => fakes.calls().some((entry) => entry.cmd === "sessionEnded"));
    expect(await requestNativeViewerHost(host, { op: "status" })).toMatchObject({ mode: "fullscreen", sessionEnded: true });
    fakes.cueViewer({ event: "sessionEnded", reason: "xvfb-gone" });
    fakes.cueViewer({ event: "closed" });
    expect(await running).toBe(0);
  }, 15_000);

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
