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
  expect(await core.getSession(record.id, env)).toMatchObject({ status: "error", desktop: record.desktop, meta: { reaperCleanupPending: true } });
  await core.releaseAgentPermit(permit);
  shortDrain.mockRestore();
  const reaped = await core.reapDeadRunningSessions(env, { desktop: {
    teardown: (id, finalize) => teardownDesktopSession(id, env, finalize),
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
