import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as core from "@pickforge/lab-core";

vi.mock("@pickforge/lab-core", async (original) => {
  const actual = await original<typeof core>();
  return { ...actual, stopProcessGroupVerified: vi.fn(async () => ({ outcome: "already-dead", signaled: false })) };
});
vi.mock("../src/display.js", async (original) => {
  const actual = await original<typeof import("../src/display.js")>();
  return { ...actual, startXvfb: vi.fn() };
});
import { startXvfb, XvfbStartError } from "../src/display.js";
import { DirHandle } from "@pickforge/lab-core";
import { createDesktopSession, destroyDesktopSession, teardownDesktopSession } from "../src/session.js";

let home: string;
let env: { PICKFORGE_HOME: string };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-desktop-input-gate-"));
  env = { PICKFORGE_HOME: home };
  vi.mocked(core.stopProcessGroupVerified).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});
const xvfb = { display: ":2992", pid: 4_194_313, startTimeTicks: 321, logPath: "/fake/xvfb.log", width: 1280, height: 800 };
function watchClosure() {
  let closed!: () => void;
  const promise = new Promise<void>((resolve) => { closed = resolve; });
  const open = fs.promises.open;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".input-closed")) closed();
    return file;
  });
  return promise;
}
const running = () => core.createSession({ type: "desktop", status: "running", projectDir: home,
  desktop: { display: xvfb.display, xvfbPid: xvfb.pid, xvfbStartTimeTicks: xvfb.startTimeTicks } }, env);

it("destroy waits for input before releasing the display", async () => {
  const record = await running();
  const permit = await core.acquireAgentPermit(record.id, env);
  const closed = watchClosure();
  const destroying = destroyDesktopSession(record.id, env);
  await closed;
  expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
  await core.releaseAgentPermit(permit);
  await destroying;
  expect(core.stopProcessGroupVerified).toHaveBeenCalledWith({ pid: xvfb.pid, startTicks: xvfb.startTimeTicks });
  expect(await core.getSession(record.id, env)).toBeUndefined();
});

it("a timeout keeps the display and lets the reaper retry", async () => {
  const record = await running();
  const permit = await core.acquireAgentPermit(record.id, env);
  const stop = core.stopSessionAgentInput;
  const shortDrain = vi.spyOn(core, "stopSessionAgentInput").mockImplementation((id, registry) => stop(id, registry, 0));
  await expect(destroyDesktopSession(record.id, env)).rejects.toThrow(core.SessionInputDrainTimeoutError);
  expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
  expect(await core.getSession(record.id, env)).toMatchObject({ status: "running", desktop: record.desktop });
  await core.releaseAgentPermit(permit);
  shortDrain.mockRestore();
  const reaped = await core.reapDeadRunningSessions(env, { desktop: {
    teardown: (id, finalize, options) => teardownDesktopSession(id, env, finalize, options),
  } }, () => true);
  expect(reaped.map(({ id }) => id)).toEqual([record.id]);
  expect(await core.getSession(record.id, env)).toBeUndefined();
});

it.each([false, true])("startup rollback preserves the display until input drains, timeout=%s", async (timeout) => {
  let permit!: core.AgentPermit;
  vi.mocked(startXvfb).mockImplementationOnce(async (opts) => {
    await opts.onSpawn?.({ ...xvfb, cleanupConfirmed: false });
    const [record] = await core.listSessions(env);
    await core.updateSession(record!.id, { status: "running" }, env);
    permit = await core.acquireAgentPermit(record!.id, env);
    return xvfb;
  });
  // Fail after Xvfb returns, when create publishes the running record.
  let publicationFailed = false;
  const rename = fs.promises.rename;
  vi.spyOn(fs.promises, "rename").mockImplementation(async (...args) => {
    if (!publicationFailed && permit !== undefined && String(args[1]).endsWith(`${permit.sessionId}.json`)) {
      publicationFailed = true;
      throw new Error("startup publish failed");
    }
    return rename(...args);
  });
  if (timeout) {
    const stop = core.stopSessionAgentInput;
    vi.spyOn(core, "stopSessionAgentInput").mockImplementation((id, registry) => stop(id, registry, 0));
  }
  const closed = watchClosure();
  const creating = createDesktopSession({ projectDir: home, registryEnv: env });
  const failed = expect(creating).rejects.toThrow("startup publish failed");
  await closed;
  expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
  if (timeout) {
    await failed;
    expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
    expect(await core.getSession(permit.sessionId, env)).toMatchObject({ status: "error", meta: { reaperCleanupPending: true }, desktop: { xvfbPid: xvfb.pid } });
  }
  await core.releaseAgentPermit(permit);
  if (!timeout) {
    await failed;
    expect(core.stopProcessGroupVerified).toHaveBeenCalled();
  }
});

it("rollback releases its own inherited-home startup permit before draining", async () => {
  vi.mocked(startXvfb).mockImplementationOnce(async (opts) => {
    await opts.onSpawn?.({ ...xvfb, cleanupConfirmed: true });
    const [record] = await core.listSessions(env);
    expect(fs.readdirSync(path.join(core.sessionDataDir(record!.id, env), "permits"))).toHaveLength(1);
    throw new XvfbStartError("timeout", "startup failed", { ...xvfb, cleanupConfirmed: true });
  });
  const stop = core.stopSessionAgentInput;
  vi.spyOn(core, "stopSessionAgentInput").mockImplementation((id, registry) => stop(id, registry, 0));
  await expect(createDesktopSession({ projectDir: home, registryEnv: env, inheritHome: true })).rejects.toThrow("startup failed");
  const [record] = await core.listSessions(env);
  expect(record?.meta?.reaperCleanupPending).toBeUndefined();
  expect(fs.readdirSync(path.join(core.sessionDataDir(record!.id, env), "permits"))).toEqual([]);
  expect(fs.existsSync(path.join(home, "sessions", core.sessionInputClosedName(record!.id)))).toBe(true);
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("explicit destroy gives an eight-second action the full action budget", async () => {
  const record = await running();
  const permit = await core.acquireAgentPermit(record.id, env);
  const drain = vi.spyOn(core, "stopSessionAgentInput");
  const secondScan = barrier();
  const open = fs.promises.open;
  let scans = 0;
  let now = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(`${permit.permitId}.json`)) {
      now = 8_000;
      if (++scans === 2) secondScan.resolve();
    }
    return file;
  });
  const destroying = destroyDesktopSession(record.id, env);
  await Promise.race([secondScan.promise, destroying]);
  expect(scans).toBeGreaterThanOrEqual(2);
  expect(drain).toHaveBeenCalledWith(record.id, env, core.SESSION_DESTROY_DRAIN_TIMEOUT_MS, undefined);
  expect(core.SESSION_DESTROY_DRAIN_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  vi.mocked(core.stopProcessGroupVerified).mockImplementationOnce(async () => {
    clock.mockRestore();
    return { outcome: "already-dead", signaled: false };
  });
  expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
  await core.releaseAgentPermit(permit);
  await destroying;
});

it("bulk cancellation after closure preserves the display and marks a reaper retry", async () => {
  const record = await running();
  const permit = await core.acquireAgentPermit(record.id, env);
  const controller = new AbortController();
  const closed = watchClosure();
  const drain = vi.spyOn(core, "stopSessionAgentInput");
  const destroying = core.destroyLocalSessions([record], {
    desktop: { destroy: (id, options) => destroyDesktopSession(id, env, options) },
    browser: { destroy: vi.fn() }, android: { destroy: vi.fn() },
  }, { env, signal: controller.signal });
  await closed;
  controller.abort();
  const result = await destroying;
  expect(result.destroyed).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(drain).toHaveBeenCalledTimes(1);
  expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
  expect(fs.existsSync(permit.path)).toBe(true);
  expect(await core.getSession(record.id, env)).toMatchObject({ status: "running" });
  expect(await core.isSessionInputClosed(record.id, env)).toBe(true);
  await core.releaseAgentPermit(permit);
  expect((await core.reapDeadRunningSessions(env, { desktop: {
    teardown: (id, finalize, options) => teardownDesktopSession(id, env, finalize, options),
  } }, () => true)).map(({ id }) => id)).toEqual([record.id]);
});

it("finalizer failure after closure leaves a retained session eligible for retry", async () => {
  const record = await running();
  await expect(teardownDesktopSession(record.id, env, async () => { throw new Error("finalizer failed"); })).rejects.toThrow("finalizer failed");
  expect(await core.getSession(record.id, env)).toMatchObject({ status: "error", meta: { reaperCleanupPending: true } });
  expect(fs.existsSync(path.join(core.sessionDataDir(record.id, env), "stopped.json"))).toBe(true);
  await destroyDesktopSession(record.id, env);
  expect(await core.getSession(record.id, env)).toBeUndefined();
});

it("combined reaper retries drain before either leg can retain shared files", async () => {
  const record = await core.createSession({ type: "desktop+android", status: "running", projectDir: home,
    desktop: { display: xvfb.display, xvfbPid: xvfb.pid, xvfbStartTimeTicks: xvfb.startTimeTicks },
    android: { avdName: "fake" },
  }, env);
  const permit = await core.acquireAgentPermit(record.id, env);
  const android = vi.fn(async (_id: string, finalize: core.LocalSessionTeardownFinalizer) => { await core.retainSessionLogs(record, env); await finalize(); });
  const runtime = { desktop: { teardown: (id: string, finalize: core.LocalSessionTeardownFinalizer) =>
    teardownDesktopSession(id, env, finalize, { inputDrainTimeoutMs: 0 }) }, android: { teardown: android } };
  for (let retry = 0; retry < 2; retry++) {
    expect(await core.reapDeadRunningSessions(env, runtime, () => false)).toEqual([]);
    expect(android).not.toHaveBeenCalled();
    expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
    expect(fs.existsSync(permit.path)).toBe(true);
    expect(fs.existsSync(path.join(core.sessionDataDir(record.id, env), "stopped.json"))).toBe(false);
  }
  await core.releaseAgentPermit(permit);
  expect((await core.reapDeadRunningSessions(env, runtime, () => false)).map(({ id }) => id)).toEqual([record.id]);
  expect(android).toHaveBeenCalledTimes(1);
  expect(core.stopProcessGroupVerified).toHaveBeenCalled();
});

it("re-reads Xvfb ownership published while an inherited startup permit drains", async () => {
  const spawned = barrier();
  const resume = barrier();
  vi.mocked(startXvfb).mockImplementationOnce(async (opts) => {
    spawned.resolve();
    await resume.promise;
    await opts.onSpawn?.({ ...xvfb, cleanupConfirmed: false });
    return xvfb;
  });
  const read = DirHandle.prototype.readEntryNames;
  const listed = barrier();
  vi.spyOn(DirHandle.prototype, "readEntryNames").mockImplementation(async function (this: DirHandle) {
    const names = await read.call(this);
    if (this.realDir.endsWith("/permits")) listed.resolve();
    return names;
  });
  const creating = createDesktopSession({ projectDir: home, registryEnv: env, inheritHome: true, vnc: true });
  const failed = expect(creating).rejects.toThrow("input is closed");
  await spawned.promise;
  const [record] = await core.listSessions(env);
  expect(record?.desktop?.xvfbPid).toBeUndefined();
  const destroying = destroyDesktopSession(record!.id, env);
  await listed.promise;
  expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
  resume.resolve();
  await failed;
  await destroying;
  expect(core.stopProcessGroupVerified).toHaveBeenCalledWith({ pid: xvfb.pid, startTicks: xvfb.startTimeTicks });
  expect(await core.getSession(record!.id, env)).toBeUndefined();
});

it.each(["running", "error"] as const)("destroy records a failure only for an error record, status=%s", async (status) => {
  const record = await running();
  if (status === "error") await core.updateSession(record.id, { status, meta: { reaperCleanupPending: true } }, env);
  await destroyDesktopSession(record.id, env);
  const marker = JSON.parse(fs.readFileSync(path.join(core.sessionDataDir(record.id, env), "stopped.json"), "utf8"));
  if (status === "running") expect(marker).toEqual({ id: record.id, stoppedAt: expect.any(String) });
  else expect(marker.failure).toMatchObject({ id: record.id, status: "error" });
});

it("a reaper bounds its lock wait during live explicit destroy without rewriting the record", async () => {
  const record = await running();
  const permit = await core.acquireAgentPermit(record.id, env);
  const listed = barrier();
  const read = DirHandle.prototype.readEntryNames;
  vi.spyOn(DirHandle.prototype, "readEntryNames").mockImplementation(async function (this: DirHandle) {
    const names = await read.call(this);
    if (this.realDir.endsWith("/permits")) listed.resolve();
    return names;
  });
  const destroying = destroyDesktopSession(record.id, env);
  await listed.promise;
  const waiting = barrier();
  const readOwner = fs.promises.readFile;
  vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
    const raw = await readOwner(...args);
    if (String(args[0]).endsWith(".ensure-vnc.lock")) waiting.resolve();
    return raw;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const reaping = core.reapDeadRunningSessions(env, { desktop: {
      teardown: (id, finalize, options) => teardownDesktopSession(id, env, finalize, options),
    } }, () => true);
    await waiting.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await reaping).toEqual([]);
    expect(await core.getSession(record.id, env)).toEqual(record);
    expect(await core.isSessionInputClosed(record.id, env)).toBe(true);
    expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    await core.releaseAgentPermit(permit);
    await destroying;
  }
});
