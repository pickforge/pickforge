import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({ drainTimeoutMs: 2_000 }));
vi.mock("@pickforge/lab-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pickforge/lab-core")>();
  return {
    ...actual,
    stopSessionAgentInput: (id: string, env: import("@pickforge/lab-core").EnvLike) =>
      actual.stopSessionAgentInput(id, env, controls.drainTimeoutMs),
    stopProcessGroupVerified: vi.fn(async () => ({ outcome: "terminated", signaled: true })),
  };
});

import {
  AgentPermitDrainTimeoutError, AgentPermitUnavailableError,
  REAPER_CLEANUP_PENDING_META_KEY, acquireAgentPermit, acquireHumanLease,
  createSession, destroySessionRecord, destroyLocalSessions, getSession,
  pruneSessionLogs, reapDeadRunningSessions, releaseAgentPermit,
  sessionDataDir, stopProcessGroupVerified, teardownLocalSession, withAgentPermit,
  updateSession, type SessionType,
} from "@pickforge/lab-core";
import { teardownDesktopSession, destroyDesktopSession } from "../src/session.js";
import { teardownBrowserSession, destroyBrowserSession } from "../../browser/src/session.js";
import { teardownAndroidSession } from "../../android/src/session.js";

let home: string;
let env: { PICKFORGE_HOME: string };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-drain-"));
  env = { PICKFORGE_HOME: home };
  controls.drainTimeoutMs = 2_000;
  vi.mocked(stopProcessGroupVerified).mockClear();
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

function barrier() {
  let resume!: () => void;
  const wait = new Promise<void>((resolve) => { resume = resolve; });
  return { wait, resume };
}

async function makeRecord(type: SessionType = "desktop") {
  const record = await createSession({
    type, projectDir: home, status: "running",
    desktop: { display: ":219", xvfbPid: 777_777, xvfbStartTimeTicks: 1 },
  }, env);
  fs.mkdirSync(sessionDataDir(record.id, env));
  fs.writeFileSync(path.join(sessionDataDir(record.id, env), "xvfb.log"), "diagnostics");
  return record;
}

const teardownRuntime = () => ({
  desktop: { teardown: (id: string, finalize: () => Promise<void>) => teardownDesktopSession(id, env, finalize) },
  browser: { teardown: (id: string, finalize: () => Promise<void>) => teardownBrowserSession(id, env, finalize) },
  android: { teardown: (id: string, finalize: () => Promise<void>) => teardownAndroidSession(id, env, {}, finalize) },
});

function pauseFinalRegistryRead(id: string) {
  const reached = barrier();
  const resume = barrier();
  const read = fs.promises.readFile;
  let reads = 0;
  vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args: Parameters<typeof read>) => {
    const data = await read(...args);
    if (String(args[0]) === path.join(home, "sessions", `${id}.json`) && ++reads === 3) {
      expect(JSON.parse(String(data)).status).toBe("running");
      reached.resume();
      await resume.wait;
    }
    return data;
  });
  return { reached: reached.wait, resume: resume.resume };
}

describe("display teardown permit races", () => {
  it.each([
    ["desktop", false], ["desktop", true],
    ["desktop+android", false], ["desktop+android", true],
    ["browser", false], ["browser", true],
  ] as const)("refuses an action paused at the last registry read across %s teardown (prune=%s)", async (type, prune) => {
    const record = await makeRecord(type);
    const gate = pauseFinalRegistryRead(record.id);
    const action = vi.fn(async () => {});
    const input = withAgentPermit(record.id, env, action).catch((error: unknown) => error);
    await gate.reached;
    const destroy = teardownLocalSession(record, teardownRuntime(), () => destroySessionRecord(record.id, env));
    try {
      await vi.waitFor(async () => expect((await getSession(record.id, env))?.status).toBe("error"));
      expect(stopProcessGroupVerified).not.toHaveBeenCalled();
      await expect(withAgentPermit(record.id, env, async () => { throw new Error("must not run"); }))
        .rejects.toThrow(AgentPermitUnavailableError);
      gate.resume();
      expect(await input).toBeInstanceOf(AgentPermitUnavailableError);
      expect(action).not.toHaveBeenCalled();
      await destroy;
      expect(stopProcessGroupVerified).toHaveBeenCalled();
      if (prune) expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
      const replacement = await makeRecord();
      const lease = await acquireHumanLease(replacement.id, env);
      expect(lease.sessionId).toBe(replacement.id);
      expect(action).not.toHaveBeenCalled();
      await expect(withAgentPermit(record.id, env, action)).rejects.toThrow(AgentPermitUnavailableError);
      expect(action).not.toHaveBeenCalled();
    } finally {
      gate.resume();
      await Promise.allSettled([input, destroy]);
    }
  });

  it.each(["desktop", "browser", "desktop+android"] as const)("waits for an action already running before closing %s", async (type) => {
    const record = await makeRecord(type);
    const entered = barrier();
    const finish = barrier();
    const input = withAgentPermit(record.id, env, async () => {
      entered.resume(); await finish.wait;
      expect(stopProcessGroupVerified).not.toHaveBeenCalled();
    });
    await entered.wait;
    const destroy = teardownLocalSession(record, teardownRuntime(), () => destroySessionRecord(record.id, env));
    try {
      await vi.waitFor(async () => expect((await getSession(record.id, env))?.status).toBe("error"));
      expect(stopProcessGroupVerified).not.toHaveBeenCalled();
      await expect(updateSession(record.id, { status: "running" }, env)).rejects.toThrow("permanently closed");
      finish.resume(); await input; await destroy;
      expect(stopProcessGroupVerified).toHaveBeenCalled();
    } finally { finish.resume(); await Promise.allSettled([input, destroy]); }
  });

  it("refuses a permit published after teardown blocked new input", async () => {
    const record = await makeRecord();
    const reached = barrier();
    const resume = barrier();
    const write = fs.promises.writeFile;
    let paused = false;
    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (...args) => {
      if (!paused && String(args[0]).startsWith("/proc/self/fd/") && String(args[0]).endsWith(".json")) {
        paused = true; reached.resume(); await resume.wait;
      }
      return write(...args);
    });
    const action = vi.fn(async () => {});
    const input = withAgentPermit(record.id, env, action).catch((error: unknown) => error);
    try {
      await reached.wait;
      await destroyDesktopSession(record.id, env);
      await acquireHumanLease((await makeRecord()).id, env);
      resume.resume();
      expect(await input).toBeInstanceOf(AgentPermitUnavailableError);
      expect(action).not.toHaveBeenCalled();
    } finally { resume.resume(); await input; }
  });

  it.each(["desktop", "browser"] as const)("keeps the %s display on timeout and lets the reaper retry", async (type) => {
    controls.drainTimeoutMs = 0;
    const record = await makeRecord(type);
    const permit = await acquireAgentPermit(record.id, env);
    await expect(teardownLocalSession(record, teardownRuntime(), () => destroySessionRecord(record.id, env)))
      .rejects.toThrow(AgentPermitDrainTimeoutError);
    expect(stopProcessGroupVerified).not.toHaveBeenCalled();
    expect(fs.existsSync(permit.path)).toBe(true);
    expect(fs.existsSync(path.join(sessionDataDir(record.id, env), "stopped.json"))).toBe(false);
    expect((await getSession(record.id, env))?.meta?.[REAPER_CLEANUP_PENDING_META_KEY]).toBe(true);
    await releaseAgentPermit(permit);
    const reaped = await reapDeadRunningSessions(env, teardownRuntime());
    expect(reaped.map((item) => item.id)).toEqual([record.id]);
    expect(await getSession(record.id, env)).toBeUndefined();
    expect(stopProcessGroupVerified).toHaveBeenCalled();
  });

  it("retries a failed finalizer after log retention removed coordination", async () => {
    const record = await makeRecord();
    await withAgentPermit(record.id, env, async () => {});
    const finalize = vi.fn(async () => { throw new Error("registry removal failed"); });
    await expect(teardownDesktopSession(record.id, env, finalize)).rejects.toThrow("registry removal failed");
    expect(fs.existsSync(path.join(sessionDataDir(record.id, env), "permits"))).toBe(false);
    const reaped = await reapDeadRunningSessions(env, teardownRuntime());
    expect(reaped.map((item) => item.id)).toEqual([record.id]);
    expect(await getSession(record.id, env)).toBeUndefined();
  });

  it("retries retention that failed after deleting the permits directory", async () => {
    const record = await makeRecord();
    await withAgentPermit(record.id, env, async () => {});
    const rm = fs.promises.rm;
    let failed = false;
    vi.spyOn(fs.promises, "rm").mockImplementation(async (...args) => {
      if (!failed && String(args[0]).endsWith("/human.lease.json")) {
        failed = true;
        throw new Error("lease cleanup failed");
      }
      return rm(...args);
    });
    await expect(destroyDesktopSession(record.id, env)).rejects.toThrow("lease cleanup failed");
    expect(fs.existsSync(path.join(sessionDataDir(record.id, env), "permits"))).toBe(false);
    const reaped = await reapDeadRunningSessions(env, teardownRuntime());
    expect(reaped.map((item) => item.id)).toEqual([record.id]);
    expect(await getSession(record.id, env)).toBeUndefined();
  });

  it("refuses a replaced directory with a copied retention marker while a permit is live", async () => {
    const record = await makeRecord();
    const permit = await acquireAgentPermit(record.id, env);
    const dir = sessionDataDir(record.id, env);
    fs.renameSync(dir, `${dir}-original`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "stopped.json"), JSON.stringify({ id: record.id, stoppedAt: new Date().toISOString() }));
    await updateSession(record.id, { status: "error", meta: { [REAPER_CLEANUP_PENDING_META_KEY]: true } }, env);
    try {
      await expect(destroyDesktopSession(record.id, env)).rejects.toThrow("coordination identity changed");
      expect(stopProcessGroupVerified).not.toHaveBeenCalled();
    } finally { await releaseAgentPermit(permit); }
  });

  it("destroy --all reports a drain timeout and still destroys other sessions", async () => {
    controls.drainTimeoutMs = 0;
    const blocked = await makeRecord();
    const free = await makeRecord("browser");
    const permit = await acquireAgentPermit(blocked.id, env);
    try {
      const result = await destroyLocalSessions([blocked, free], {
        desktop: { destroy: (id) => destroyDesktopSession(id, env) },
        browser: { destroy: (id) => destroyBrowserSession(id, env) },
        android: { destroy: async () => {} },
      });
      expect(result.destroyed).toEqual([free.id]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(blocked.id);
      expect(await getSession(blocked.id, env)).toBeDefined();
      expect(await getSession(free.id, env)).toBeUndefined();
    } finally { await releaseAgentPermit(permit); }
  });
});
