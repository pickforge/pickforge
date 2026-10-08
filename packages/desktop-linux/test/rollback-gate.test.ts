import * as core from "@pickforge/lab-core";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirHandle } from "../../core/src/dir-handle.js";

const children: ChildProcess[] = [];
function processHandle() {
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  children.push(child);
  const pid = child.pid!;
  return { pid, startTimeTicks: core.readProcessStartTicks(pid)! };
}

vi.mock("../src/display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/display.js")>();
  return { ...actual, startXvfb: vi.fn(async (opts: Parameters<typeof actual.startXvfb>[0]) => {
    const handle = { ...processHandle(), display: ":242", logPath: "/tmp/fake-xvfb.log", width: 1280, height: 800 };
    await opts.onSpawn?.({ ...handle, cleanupConfirmed: false });
    return handle;
  }) };
});
vi.mock("../src/vnc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vnc.js")>();
  return { ...actual, detectVncBinary: () => "/usr/bin/x11vnc", startVnc: vi.fn(async () => ({
    ...processHandle(), port: 5942, logPath: "/tmp/fake-vnc.log",
  })) };
});
import { createDesktopSession } from "../src/session.js";

let home: string;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.pid === undefined) continue;
    const startTicks = core.readProcessStartTicks(child.pid);
    if (startTicks !== undefined) await core.stopProcessGroupVerified({ pid: child.pid, startTicks });
  }
  if (home !== undefined) fs.rmSync(home, { recursive: true, force: true });
});

describe("desktop rollback gate failures", () => {
  it("stops spawned Xvfb and VNC after gate failure, preserving the startup error and retry record", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-rollback-gate-"));
    const env = { PICKFORGE_HOME: home };
    const startup = new Error("running record startup failure");
    const gate = Object.assign(new Error("gate owner disk full"), { code: "ENOSPC" });
    let failed = false;
    const update = core.updateSession;
    vi.spyOn(core, "updateSession").mockImplementation(async (id, patch, registry) => {
      if (patch.status === "running") { failed = true; throw startup; }
      return update(id, patch, registry);
    });
    const write = DirHandle.prototype.writeFileAtomic;
    vi.spyOn(DirHandle.prototype, "writeFileAtomic").mockImplementation(async function(this: DirHandle, name, data) {
      if (failed && name === "owner") throw gate;
      return write.call(this, name, data);
    });
    const result = await createDesktopSession({ projectDir: home, registryEnv: env, vnc: true }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result).toMatchObject({ cause: startup, errors: [startup, gate], message: expect.stringContaining(startup.message) });
    expect(children).toHaveLength(2);
    for (const child of children) expect(core.isPidAlive(child.pid!)).toBe(false);
    const records = await core.listSessions(env);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "error", meta: { reaperCleanupPending: true } });
  });

  it("keeps spawned processes alive on a permit drain timeout", async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-rollback-timeout-"));
    const startup = new Error("startup failure before completion");
    const timeout = new core.AgentPermitDrainTimeoutError(["held"]);
    const update = core.updateSession;
    vi.spyOn(core, "updateSession").mockImplementation(async (id, patch, registry) => {
      if (patch.status === "running") throw startup;
      return update(id, patch, registry);
    });
    vi.spyOn(core, "stopSessionAgentInput").mockRejectedValue(timeout);
    const result = await createDesktopSession({ projectDir: home, registryEnv: { PICKFORGE_HOME: home }, vnc: true }).catch((error: unknown) => error);
    expect(result).toMatchObject({ cause: startup, errors: [startup, timeout] });
    expect(children).toHaveLength(2);
    for (const child of children) expect(core.isPidAlive(child.pid!)).toBe(true);
  });
});
