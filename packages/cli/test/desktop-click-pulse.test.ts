import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireHumanLease, createSession, processIdentityMatches, readProcessIdentity, releaseHumanLease } from "@pickforge/lab-core";
import {
  startXvfb, stopXvfb, findOnPath, findNativeViewerHost, requestNativeViewerHost, type XvfbHandle,
} from "@pickforge/lab-desktop-linux";
import { runDesktopClick, runDesktopDoubleClick, runDesktopDrag } from "../src/commands/desktop.js";
import { runNativeViewerHost } from "../src/viewer/native-host.js";
import { createViewerFakes, type ViewerFakes } from "./viewer-fakes.js";
import { unusedTestDisplay } from "../../desktop-linux/test/test-resources.js";
import { nativeViewerVersion } from "../src/viewer/native.js";

const available = findOnPath("Xvfb") !== null && findOnPath("xdotool") !== null;
let root: string;
let fakes: ViewerFakes;
let display: XvfbHandle;
let sessionId: string;
let running: Promise<number> | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pulse-"));
  fakes = createViewerFakes(root);
  vi.stubEnv("PICKFORGE_HOME", root);
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
  vi.stubEnv("PATH", `${fakes.binDir}:${process.env.PATH}`);
  vi.stubEnv("DISPLAY", unusedTestDisplay());
  vi.stubEnv("WAYLAND_DISPLAY", "");
  vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  running = undefined;
  if (!available) return;
  display = await startXvfb({ display: unusedTestDisplay(), logDir: root, width: 640, height: 480 });
  sessionId = (await createSession({ type: "desktop", projectDir: root, status: "running", desktop: {
    display: display.display, xvfbPid: display.pid, xvfbStartTimeTicks: display.startTimeTicks, width: 640, height: 480, homePolicy: "private",
  } })).id;
  const binary = fakes.installViewer({ version: nativeViewerVersion });
  running = runNativeViewerHost({ session: sessionId, binary, viewerVersion: nativeViewerVersion,
    _spawnWatchdog: () => ({ kill() {} }), _takeoverOptions: { heartbeatMs: 100, ttlMs: 5_000 } });
  for (let count = 0; count < 200 && await findNativeViewerHost(sessionId) === undefined; count++) await sleep(25);
});
afterEach(async () => {
  const host = available ? await findNativeViewerHost(sessionId) : undefined;
  if (host !== undefined) await requestNativeViewerHost(host, { op: "shutdown" }).catch(() => {});
  for (const call of fakes.calls().filter((entry) => entry.tool === "viewer")) {
    const identity = readProcessIdentity(Number(call.pid));
    if (identity !== undefined && processIdentityMatches(identity)) process.kill(identity.pid, "SIGKILL");
  }
  await running?.catch(() => {});
  if (available) await stopXvfb(display.pid, display.startTimeTicks);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  fs.rmSync(root, { recursive: true, force: true });
});

const opts = () => ({ session: sessionId, projectDir: root, json: true });
const pulses = (): unknown[] => fakes.calls().filter((entry) => entry.cmd === "pulse").map(({ x, y }) => ({ x, y }));
/** Waits for the expected pulses to reach the fake viewer, then a short settle finds any extra. */
async function settledPulses(expected = 0): Promise<unknown[]> {
  for (let count = 0; count < 80 && pulses().length < expected; count++) await sleep(25);
  await sleep(100);
  return pulses();
}

describe.skipIf(!available)("desktop click pulse", () => {
  it("sends one pulse per completed click and double click, and none for a drag", async () => {
    expect(await runDesktopClick("12", "34", opts())).toBe(0);
    expect(await settledPulses(1)).toEqual([{ x: 12, y: 34 }]);
    expect(await runDesktopDoubleClick("56", "78", opts())).toBe(0);
    expect(await settledPulses(2)).toEqual([{ x: 12, y: 34 }, { x: 56, y: 78 }]);
    expect(await runDesktopDrag("1", "2", "30", "40", { ...opts(), duration: "0" })).toBe(0);
    expect(await settledPulses()).toHaveLength(2);
  }, 20_000);

  it("sends no pulse for a click refused by human control", async () => {
    const lease = await acquireHumanLease(sessionId);
    expect(await runDesktopClick("12", "34", opts())).toBe(1);
    expect(await runDesktopDoubleClick("12", "34", opts())).toBe(1);
    await releaseHumanLease(sessionId, lease.leaseId);
    expect(await settledPulses()).toEqual([]);
  }, 20_000);

  it("sends no pulse when the click fails", async () => {
    const failing = path.join(root, "failing-bin");
    fs.mkdirSync(failing);
    fs.writeFileSync(path.join(failing, "xdotool"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${failing}:${process.env.PATH}`);
    expect(await runDesktopClick("12", "34", opts())).toBe(1);
    expect(await runDesktopDoubleClick("12", "34", opts())).toBe(1);
    expect(await settledPulses()).toEqual([]);
  }, 20_000);
});
