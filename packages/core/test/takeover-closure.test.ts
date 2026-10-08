import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirHandle } from "../src/dir-handle.js";
import { sessionsDir } from "../src/paths.js";
import { SessionInputClosedError, closeSessionInput, sessionInputClosedName, withSessionGate } from "../src/session-gate.js";
import { createSession, destroySessionRecord, getSession, sessionDataDir, takeoverIdentityName, updateSession } from "../src/session.js";
import { reapDeadRunningSessions } from "../src/session-lifecycle.js";
import { pruneSessionLogs, retainSessionLogs } from "../src/session-retention.js";
import { AgentPermitUnavailableError, acquireAgentPermit, acquireHumanLease, readHumanLease, releaseHumanLease, renewHumanLease, stopSessionAgentInput, withAgentPermit } from "../src/takeover.js";

let home: string;
let env: { PICKFORGE_HOME: string };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-closure-"));
  env = { PICKFORGE_HOME: home };
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

function barrier() {
  let resume!: () => void;
  const wait = new Promise<void>((resolve) => { resume = resolve; });
  return { wait, resume };
}

async function record(status: "starting" | "running" = "running") {
  const result = await createSession({ type: "desktop", status, projectDir: home }, env);
  fs.mkdirSync(sessionDataDir(result.id, env));
  fs.writeFileSync(path.join(sessionDataDir(result.id, env), "xvfb.log"), "diagnostics");
  return result;
}

describe("irreversible takeover closure", () => {
  it.each(["desktop", "browser", "android", "desktop+android"] as const)("refuses %s startup completion after teardown drained", async (type) => {
    const session = await createSession({ type, status: "starting", projectDir: home }, env);
    const complete = barrier();
    const startup = (async () => {
      await complete.wait;
      return updateSession(session.id, { status: "running" }, env);
    })().catch((error: unknown) => error);
    try {
      await stopSessionAgentInput(session.id, env, 0);
      complete.resume();
      expect(await startup).toBeInstanceOf(SessionInputClosedError);
      expect((await getSession(session.id, env))?.status).toBe("error");
      const action = vi.fn(async () => {});
      await expect(withAgentPermit(session.id, env, action)).rejects.toThrow(AgentPermitUnavailableError);
      await expect(acquireHumanLease(session.id, env)).rejects.toThrow(SessionInputClosedError);
      expect(action).not.toHaveBeenCalled();
    } finally { complete.resume(); await startup; }
  });

  it("refuses input even if an external writer restores the raw running record", async () => {
    const session = await record();
    await stopSessionAgentInput(session.id, env, 0);
    fs.writeFileSync(path.join(sessionsDir(env), `${session.id}.json`), JSON.stringify(session));
    const action = vi.fn(async () => {});
    await expect(withAgentPermit(session.id, env, action)).rejects.toThrow(AgentPermitUnavailableError);
    await expect(acquireHumanLease(session.id, env)).rejects.toThrow(SessionInputClosedError);
    await expect(updateSession(session.id, { meta: { changed: true } }, env)).rejects.toThrow(SessionInputClosedError);
    expect(action).not.toHaveBeenCalled();
  });

  it.each(["starting", "running"] as const)("reaps a closed %s gate after a crash before the error update", async (status) => {
    const session = await record(status);
    await closeSessionInput(session.id, sessionsDir(env));
    const alive = vi.fn(async () => true);
    const reaped = await reapDeadRunningSessions(env, {
      desktop: { teardown: async (id, finalize) => { await stopSessionAgentInput(id, env, 0); await finalize(); } },
    }, alive);
    expect(reaped.map((item) => item.id)).toEqual([session.id]);
    expect(alive).not.toHaveBeenCalled();
    expect(await getSession(session.id, env)).toBeUndefined();
  });

  it("closes renewal but keeps the held lease readable and releasable", async () => {
    const session = await record();
    const lease = await acquireHumanLease(session.id, env);
    await stopSessionAgentInput(session.id, env, 0);
    await expect(renewHumanLease(session.id, lease.leaseId, env)).rejects.toThrow(SessionInputClosedError);
    expect(await readHumanLease(session.id, env)).toEqual(lease);
    expect(await releaseHumanLease(session.id, lease.leaseId, env)).toBe(true);
  });

  it("keeps its irreversible marker after pruning logs", async () => {
    const session = await record();
    await stopSessionAgentInput(session.id, env, 0);
    await retainSessionLogs(session, env);
    await destroySessionRecord(session.id, env);
    expect(await pruneSessionLogs(0, env)).toEqual([session.id]);
    expect(fs.existsSync(path.join(sessionsDir(env), sessionInputClosedName(session.id)))).toBe(true);
    await expect(acquireAgentPermit(session.id, env)).rejects.toThrow(AgentPermitUnavailableError);
    expect(fs.existsSync(sessionDataDir(session.id, env))).toBe(false);
  });
});

describe("delayed takeover initialization", () => {
  it.each([
    ["agent", false], ["agent", true], ["human", false], ["human", true],
  ] as const)("creates no coordination after a paused first %s registry read (prune=%s)", async (kind, prune) => {
    const session = await record();
    const reached = barrier();
    const resume = barrier();
    const read = fs.promises.readFile;
    let paused = false;
    vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args: Parameters<typeof read>) => {
      const data = await read(...args);
      if (!paused && String(args[0]) === path.join(sessionsDir(env), `${session.id}.json`)) {
        paused = true; reached.resume(); await resume.wait;
      }
      return data;
    });
    const acquiring = (kind === "agent" ? acquireAgentPermit(session.id, env) : acquireHumanLease(session.id, env))
      .catch((error: unknown) => error);
    try {
      await reached.wait;
      await stopSessionAgentInput(session.id, env, 0);
      await retainSessionLogs(session, env);
      await destroySessionRecord(session.id, env);
      if (prune) expect(await pruneSessionLogs(0, env)).toEqual([session.id]);
      resume.resume();
      expect(await acquiring).toBeInstanceOf(kind === "agent" ? AgentPermitUnavailableError : SessionInputClosedError);
      expect(fs.existsSync(path.join(sessionsDir(env), takeoverIdentityName(session.id)))).toBe(false);
      expect(fs.existsSync(path.join(sessionDataDir(session.id, env), "permits"))).toBe(false);
      expect(await pruneSessionLogs(0, env)).toEqual(prune ? [] : [session.id]);
      expect(fs.existsSync(sessionDataDir(session.id, env))).toBe(false);
    } finally { resume.resume(); await acquiring; }
  });

  it.each(["agent", "human"] as const)("rechecks closure under the lock before first %s initialization", async (kind) => {
    const session = await record();
    const reached = barrier();
    const resume = barrier();
    const write = DirHandle.prototype.writeFileAtomic;
    let paused = false;
    vi.spyOn(DirHandle.prototype, "writeFileAtomic").mockImplementation(async function(this: DirHandle, name, data) {
      if (!paused && name === "owner") { paused = true; reached.resume(); await resume.wait; }
      return write.call(this, name, data);
    });
    const acquiring = (kind === "agent" ? acquireAgentPermit(session.id, env) : acquireHumanLease(session.id, env))
      .catch((error: unknown) => error);
    try {
      await reached.wait;
      await stopSessionAgentInput(session.id, env, 0);
      await retainSessionLogs(session, env);
      await destroySessionRecord(session.id, env);
      resume.resume();
      expect(await acquiring).toBeInstanceOf(kind === "agent" ? AgentPermitUnavailableError : SessionInputClosedError);
      expect(fs.existsSync(path.join(sessionsDir(env), takeoverIdentityName(session.id)))).toBe(false);
      expect(await pruneSessionLogs(0, env)).toEqual([session.id]);
    } finally { resume.resume(); await acquiring; }
  });
});

describe("session gate lock ownership", () => {
  it.each([1, 3])("recovers after %s owner unlink failures before the next operation", async (failureCount) => {
    const session = await record();
    const unlink = DirHandle.prototype.unlinkChild;
    let failures = 0;
    vi.spyOn(DirHandle.prototype, "unlinkChild").mockImplementation(async function(this: DirHandle, name) {
      if (name === "owner" && failures++ < failureCount) throw Object.assign(new Error("transient unlink failure"), { code: "EIO" });
      return unlink.call(this, name);
    });
    expect(await withSessionGate(session.id, sessionsDir(env), async () => "first")).toBe("first");
    expect(await withSessionGate(session.id, sessionsDir(env), async () => "next")).toBe("next");
    expect(fs.existsSync(path.join(sessionsDir(env), `.${session.id}.gate-lock`))).toBe(false);
  }, 2_000);

  it("persists cleanup pending when gate writes remain unavailable", async () => {
    const session = await record("starting");
    vi.spyOn(DirHandle.prototype, "writeFileAtomic").mockRejectedValue(Object.assign(new Error("gate unavailable"), { code: "ENOSPC" }));
    await expect(updateSession(session.id, { status: "running" }, env)).rejects.toThrow("gate unavailable");
    await updateSession(session.id, { status: "error", meta: { reaperCleanupPending: true } }, env);
    expect(await getSession(session.id, env)).toMatchObject({ status: "error", meta: { reaperCleanupPending: true } });
  });

  it("does not remove a successor's live lock during delayed release", async () => {
    const session = await record();
    const reached = barrier();
    const release = barrier();
    const secondEntered = barrier();
    const finishSecond = barrier();
    const rmdir = fs.promises.rmdir;
    let paused = false;
    vi.spyOn(fs.promises, "rmdir").mockImplementation(async (...args) => {
      if (!paused && String(args[0]).endsWith(`${session.id}.gate-lock`)) {
        paused = true; reached.resume(); await release.wait;
      }
      return rmdir(...args);
    });
    const first = withSessionGate(session.id, sessionsDir(env), async () => {});
    await reached.wait;
    const second = withSessionGate(session.id, sessionsDir(env), async () => { secondEntered.resume(); await finishSecond.wait; });
    try {
      await secondEntered.wait;
      release.resume();
      await first;
      expect(fs.existsSync(path.join(sessionsDir(env), `.${session.id}.gate-lock`, "owner"))).toBe(true);
    } finally { release.resume(); finishSecond.resume(); await Promise.allSettled([first, second]); }
  });

  it("recovers a published lock after its owner process is killed", async () => {
    const session = await record();
    const ready = path.join(home, "ready");
    const worker = fileURLToPath(new URL("./workers/session-gate-worker.ts", import.meta.url));
    const child = spawn("bun", [worker, sessionsDir(env), session.id, ready], { stdio: "ignore" });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
    try {
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 5_000 });
      child.kill("SIGKILL"); await exited;
      await stopSessionAgentInput(session.id, env, 0);
      await expect(updateSession(session.id, { status: "running" }, env)).rejects.toThrow(SessionInputClosedError);
      expect(fs.readdirSync(sessionsDir(env)).some((name) => name.includes("gate-lock") || name.includes("gate-stage"))).toBe(false);
    } finally { child.kill("SIGKILL"); await exited; }
  });
});

describe("abandoned session gate stages", () => {
  async function killedWaiter(id: string, phase: string, index: number) {
    const ready = path.join(home, `stage-ready-${index}`);
    const worker = fileURLToPath(new URL("./workers/session-gate-worker.ts", import.meta.url));
    const child = spawn("bun", [worker, sessionsDir(env), id, ready, phase], { stdio: "ignore" });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
    try { await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 5_000 }); }
    finally { child.kill("SIGKILL"); await exited; }
  }

  it.each(["acquisition", "prune"])("reclaims killed waiting processes during %s", async (sweep) => {
    const session = await record();
    const entered = barrier();
    const release = barrier();
    const holder = withSessionGate(session.id, sessionsDir(env), async () => { entered.resume(); await release.wait; });
    const stages = () => fs.readdirSync(sessionsDir(env)).filter((name) => name.includes("gate-stage"));
    try {
      await entered.wait;
      for (let index = 0; index < 3; index += 1) await killedWaiter(session.id, "waiting", index);
      // Each new waiter also sweeps its dead predecessors.
      expect(stages()).toHaveLength(1);
      if (sweep === "prune") { expect(await pruneSessionLogs(0, env)).toEqual([]); expect(stages()).toEqual([]); }
    } finally { release.resume(); await holder; }
    await stopSessionAgentInput(session.id, env, 0);
    expect(stages()).toEqual([]);
    await retainSessionLogs(session, env);
    await destroySessionRecord(session.id, env);
    expect(await pruneSessionLogs(0, env)).toEqual([session.id]);
  });

  it("reclaims an old stage killed before its owner write and preserves unknown entries and symlinks", async () => {
    const session = await record();
    await killedWaiter(session.id, "before-owner", 0);
    const root = sessionsDir(env);
    const name = fs.readdirSync(root).find((entry) => entry.includes("gate-stage"))!;
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.existsSync(path.join(root, name))).toBe(true);
    const old = new Date(Date.now() - 61_000);
    fs.writeFileSync(path.join(root, name, ".owner.tmp-4194311-1"), "partial");
    fs.utimesSync(path.join(root, name), old, old);
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "private");
    const link = `.${session.id}.gate-stage-00000000-0000-0000-0000-000000000000`;
    fs.symlinkSync(outside, path.join(root, link));
    const unknown = `.${session.id}.gate-stage-00000000-0000-0000-0000-000000000001`;
    fs.mkdirSync(path.join(root, unknown));
    fs.writeFileSync(path.join(root, unknown, "owner"), JSON.stringify({ ownerPid: 4194311 }));
    fs.writeFileSync(path.join(root, unknown, "keep"), "private");
    await pruneSessionLogs(0, env);
    expect(fs.existsSync(path.join(root, name))).toBe(false);
    expect(fs.lstatSync(path.join(root, link)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("private");
    expect(fs.readFileSync(path.join(root, unknown, "keep"), "utf8")).toBe("private");
  });
});
