import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, readHumanLease } from "@pickforge/lab-core";
import { findNativeViewerHost, findOnPath, startXvfb, stopXvfb, type XvfbHandle } from "@pickforge/lab-desktop-linux";
import { runNativeViewerHost } from "../../packages/cli/src/viewer/native-host.js";
import { createViewerFakes } from "../../packages/cli/test/viewer-fakes.js";
import { unusedTestDisplay } from "../../packages/desktop-linux/test/test-resources.js";
import { nativeViewerVersion } from "../../packages/cli/src/viewer/native.js";

const acquire = vi.hoisted(() => vi.fn(async () => { throw new Error("Socket reached lease acquisition"); }));
vi.mock("@pickforge/lab-desktop-linux", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pickforge/lab-desktop-linux")>(), startHumanTakeover: acquire,
}));
let root: string | undefined;
let display: XvfbHandle | undefined;
let running: Promise<number> | undefined;
let socketPath: string | undefined;

function request(value: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath!);
    socket.on("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      if (!pending.includes("\n")) return;
      resolve(JSON.parse(pending.split("\n")[0]!));
      socket.destroy();
    });
  });
}

afterEach(async () => {
  if (socketPath !== undefined) await request({ op: "shutdown" }).catch(() => {});
  await running;
  if (display !== undefined) await stopXvfb(display.pid, display.startTimeTicks);
  vi.unstubAllEnvs();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(findOnPath("Xvfb") === null)("native socket lease boundary", () => {
  it("never calls lease acquisition for any supported socket operation or input-shaped operation", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-control-security-"));
    const fakes = createViewerFakes(root);
    vi.stubEnv("PICKFORGE_HOME", root);
    vi.stubEnv("PATH", `${fakes.binDir}:${process.env.PATH}`);
    vi.stubEnv("DISPLAY", unusedTestDisplay());
    vi.stubEnv("WAYLAND_DISPLAY", "");
    vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "");
    display = await startXvfb({ display: unusedTestDisplay(), logDir: root });
    const session = await createSession({ type: "desktop", projectDir: root, status: "running", desktop: {
      display: display.display, xvfbPid: display.pid, xvfbStartTimeTicks: display.startTimeTicks, homePolicy: "private",
    } });
    running = runNativeViewerHost({ session: session.id, binary: fakes.installViewer({ version: nativeViewerVersion }), viewerVersion: nativeViewerVersion });
    for (let attempt = 0; attempt < 200; attempt++) {
      const host = await findNativeViewerHost(session.id);
      if (host !== undefined) { socketPath = host.socket; break; }
      await sleep(25);
    }
    expect(socketPath).toBeDefined();
    for (const op of ["status", "expand", "collapse", "subscribe"]) expect((await request({ op })).ok).toBe(true);
    const response = await request({ op: "requestTakeover", message: "Help", timeoutMs: 500 });
    expect(response.ok).toBe(true);
    expect((await request({ op: "cancelRequest", requestId: response.requestId })).ok).toBe(true);
    for (const op of ["grant", "control", "takeControl", "takeRequested", "key", "pointer", "input"]) {
      expect(await request({ op })).toMatchObject({ ok: false, error: "unknown-operation" });
    }
    await request({ op: "shutdown" });
    await running;
    socketPath = undefined;
    expect(acquire).not.toHaveBeenCalled();
    expect(await readHumanLease(session.id)).toBeUndefined();
  }, 15_000);
});
