import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSession, readActions, readHumanLease, recordTakeoverEvidence, resolveActivePointer, resolveRunStorage,
} from "@pickforge/lab-core";
import { findNativeViewerHost, findOnPath, startXvfb, stopXvfb, type XvfbHandle } from "@pickforge/lab-desktop-linux";
import { runNativeViewerHost } from "../../packages/cli/src/viewer/native-host.js";
import { StackMembership, stackDir, type StackMember } from "../../packages/cli/src/viewer/stack.js";
import { createViewerFakes, monitor, type ViewerFakes } from "../../packages/cli/test/viewer-fakes.js";
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
  running = undefined;
  if (display !== undefined) await stopXvfb(display.pid, display.startTimeTicks);
  display = undefined;
  vi.unstubAllEnvs();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

async function startHost(hyprland: boolean): Promise<{ fakes: ViewerFakes; sessionId: string; launchId: string; runtime: string }> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-control-security-"));
  const fakes = createViewerFakes(root);
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime, { mode: 0o700 });
  vi.stubEnv("PICKFORGE_HOME", root);
  vi.stubEnv("PATH", `${fakes.binDir}:${process.env.PATH}`);
  vi.stubEnv("DISPLAY", unusedTestDisplay());
  vi.stubEnv("WAYLAND_DISPLAY", "");
  vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", hyprland ? "test_security" : "");
  vi.stubEnv("XDG_RUNTIME_DIR", runtime);
  if (hyprland) {
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" }, monitors: [monitor()] });
  }
  display = await startXvfb({ display: unusedTestDisplay(), logDir: root });
  const session = await createSession({ type: "desktop", projectDir: root, status: "running", desktop: {
    display: display.display, xvfbPid: display.pid, xvfbStartTimeTicks: display.startTimeTicks, homePolicy: "private",
  } });
  running = runNativeViewerHost({ session: session.id, binary: fakes.installViewer({ version: nativeViewerVersion }), viewerVersion: nativeViewerVersion });
  let launchId = "";
  for (let attempt = 0; attempt < 200; attempt++) {
    const host = await findNativeViewerHost(session.id);
    if (host !== undefined) { socketPath = host.socket; launchId = host.launchId; break; }
    await sleep(25);
  }
  expect(socketPath).toBeDefined();
  return { fakes, sessionId: session.id, launchId, runtime };
}

describe.skipIf(findOnPath("Xvfb") === null)("native socket lease boundary", () => {
  it("never calls lease acquisition for any supported socket operation or input-shaped operation", async () => {
    const { sessionId } = await startHost(false);
    for (const op of ["status", "expand", "collapse", "subscribe"]) expect((await request({ op })).ok).toBe(true);
    const response = await request({ op: "requestTakeover", message: "Help", timeoutMs: 500 });
    expect(response.ok).toBe(true);
    expect((await request({ op: "cancelRequest", requestId: response.requestId })).ok).toBe(true);
    // Pasted text stays in the viewer, so no socket operation carries it.
    // Hover, titles and the stack have no socket operation either.
    for (const op of ["grant", "control", "takeControl", "takeRequested", "key", "pointer", "input",
      "paste", "pasteText", "clipboard", "type", "typeText", "text", "hover", "setTitle", "stack", "fan"]) {
      expect(await request({ op })).toMatchObject({ ok: false, error: "unknown-operation" });
    }
    await request({ op: "shutdown" });
    await running;
    socketPath = undefined;
    expect(acquire).not.toHaveBeenCalled();
    expect(await readHumanLease(sessionId)).toBeUndefined();
  }, 15_000);

  it("never starts a takeover or sends control for a hover cue", async () => {
    const { fakes, sessionId, launchId, runtime } = await startHost(true);
    const member = path.join(stackDir({ xdgRuntimeDir: runtime, instance: "test_security" }), `${launchId}.json`);
    const hover = (): unknown => fs.existsSync(member) ? (JSON.parse(fs.readFileSync(member, "utf8")) as StackMember).hover : undefined;
    await expect.poll(hover).toBe(false);
    fakes.cueViewer({ event: "hover", inside: true });
    await expect.poll(hover).toBe(true);
    fakes.cueViewer({ event: "hover", inside: false });
    await expect.poll(hover).toBe(false);
    expect(fakes.calls().filter((entry) => entry.cmd === "control" || entry.cmd === "attention")).toEqual([]);
    expect(acquire).not.toHaveBeenCalled();
    expect(await readHumanLease(sessionId)).toBeUndefined();
  }, 15_000);
});

describe("viewer stack member files", () => {
  it("hold only allowlisted keys", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-stack-security-"));
    const ctx = { xdgRuntimeDir: root, instance: "test_security" };
    const stack = new StackMembership(ctx);
    const launchId = "a".repeat(32);
    await stack.join({ launchId, sessionId: "desk-abc123", hostPid: process.pid, hostStartTicks: 1, monitor: 0, mode: "thumbnail",
      stackedAt: new Date().toISOString(), hover: false, width: 384, height: 288,
      title: "secret", leaseId: "lease", message: "help", text: "pasted" } as StackMember);
    await stack.update({ hover: true, leaseId: "lease" } as Partial<StackMember>);
    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(stackDir(ctx), `${launchId}.json`), "utf8")));
    expect(keys).toEqual(["launchId", "sessionId", "hostPid", "hostStartTicks", "monitor", "mode", "stackedAt", "hover", "width", "height"]);
  });
});

describe("takeover evidence", () => {
  it("records only allowlisted keys, so pasted text has no field to enter", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-paste-evidence-"));
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    const env = { PICKFORGE_HOME: path.join(root, "home"), PICKFORGE_STORAGE_MODE: "project-local" };
    await recordTakeoverEvidence(project, "desk-paste0", "takeover_start", { env });
    await recordTakeoverEvidence(project, "desk-paste0", "takeover_return", { env, artifacts: ["screenshots/a.png"] });
    const pointer = await resolveActivePointer(project, "desk-paste0", env);
    if (pointer.status !== "active") throw new Error(`no active run: ${pointer.status}`);
    const { runsDir } = await resolveRunStorage(project, env);
    const records = await readActions(path.join(runsDir, pointer.pointer.runId));
    expect(records.map((record) => (record as { tool?: string }).tool)).toEqual(["takeover_start", "takeover_return"]);
    const allowed = ["actionId", "source", "tool", "sessionId", "startedAt", "status", "artifacts"];
    for (const record of records) {
      expect(Object.keys(record).filter((key) => !allowed.includes(key))).toEqual([]);
    }
  });
});
