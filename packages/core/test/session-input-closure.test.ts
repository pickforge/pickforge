import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AgentPermitUnavailableError,
  acquireAgentPermit, acquireHumanLease, createSession, destroySessionRecord,
  getSession, getTakeoverStatus, pruneSessionLogs, readHumanLease,
  releaseAgentPermit, releaseHumanLease, retainSessionLogs, sessionDataDir, sessionInputClosedName,
  stopSessionAgentInput, updateSession, withAgentPermit, reapDeadRunningSessions,
} from "../src/index.js";
import { DirHandle } from "../src/dir-handle.js";

let home: string;
let env: { PICKFORGE_HOME: string };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-input-gate-"));
  env = { PICKFORGE_HOME: home };
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const running = () => createSession({ type: "desktop", status: "running", projectDir: home, desktop: { display: ":2991" } }, env);
const marker = (id: string) => path.join(home, "sessions", sessionInputClosedName(id));

it.each([false, true])("refuses delayed input across teardown, prune=%s", async (prune) => {
  const record = await running();
  const read = fs.promises.readFile;
  const resolved = barrier();
  const resume = barrier();
  const action = vi.fn(async (_display: string) => {});
  let stalled = false;
  vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
    const raw = await read(...args);
    if (!stalled && String(args[0]).endsWith(`${record.id}.json`)) {
      stalled = true;
      resolved.resolve();
      await resume.promise;
    }
    return raw;
  });
  // The input path reads its display before it enters withAgentPermit.
  const input = (async () => {
    const snapshot = await getSession(record.id, env);
    await withAgentPermit(record.id, env, () => action(snapshot!.desktop!.display));
  })();
  const refused = expect(input).rejects.toThrow(AgentPermitUnavailableError);
  await resolved.promise;
  await stopSessionAgentInput(record.id, env);
  await retainSessionLogs(record, env);
  await destroySessionRecord(record.id, env);
  if (prune) expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
  const replacement = await running();
  const lease = await acquireHumanLease(replacement.id, env);
  expect(lease.sessionId).toBe(replacement.id);
  resume.resolve();
  await refused;
  expect(action).not.toHaveBeenCalled();
  expect(fs.existsSync(marker(record.id))).toBe(true);
  expect(await readHumanLease(record.id, env)).toBeUndefined();
  expect(await getTakeoverStatus(record.id, env)).toEqual({ sessionId: record.id, active: false });
});

it("waits for a permit whose re-check completed before closure", async () => {
  const record = await running();
  const entered = barrier();
  const resume = barrier();
  const input = withAgentPermit(record.id, env, async () => {
    entered.resolve();
    await resume.promise;
  });
  await entered.promise;
  const listed = watchPermitListing();
  const stopping = stopSessionAgentInput(record.id, env);
  await listed;
  expect(fs.readdirSync(path.join(sessionDataDir(record.id, env), "permits"))).toHaveLength(1);
  resume.resolve();
  await input;
  await stopping;
});

function watchPermitListing() {
  const listed = barrier();
  const read = DirHandle.prototype.readEntryNames;
  vi.spyOn(DirHandle.prototype, "readEntryNames").mockImplementation(async function (this: DirHandle) {
    const names = await read.call(this);
    if (this.realDir.endsWith("/permits")) listed.resolve();
    return names;
  });
  return listed.promise;
}

it.each(["closure", "status"])("rolls back a published permit when %s wins its re-check", async (change) => {
  const record = await running();
  const published = barrier();
  const resume = barrier();
  const link = DirHandle.prototype.linkChild;
  vi.spyOn(DirHandle.prototype, "linkChild").mockImplementation(async function (this: DirHandle, from, to) {
    await link.call(this, from, to);
    if (from.startsWith(".agent-permit-")) {
      published.resolve();
      await resume.promise;
    }
  });
  const action = vi.fn(async () => {});
  const input = withAgentPermit(record.id, env, action);
  const refused = expect(input).rejects.toThrow(AgentPermitUnavailableError);
  await published.promise;
  let stopping: Promise<void> | undefined;
  if (change === "closure") {
    const listed = watchPermitListing();
    stopping = stopSessionAgentInput(record.id, env);
    await listed;
  } else {
    await updateSession(record.id, { status: "error" }, env);
  }
  resume.resolve();
  await refused;
  await stopping;
  expect(action).not.toHaveBeenCalled();
  expect(fs.readdirSync(path.join(sessionDataDir(record.id, env), "permits"))).toEqual([]);
});

it.each([false, true])("rolls back a lease when closure crosses publication, linked=%s", async (linked) => {
  const record = await running();
  const reached = barrier();
  const resume = barrier();
  const link = DirHandle.prototype.linkChild;
  vi.spyOn(DirHandle.prototype, "linkChild").mockImplementation(async function (this: DirHandle, from, to) {
    if (to !== "human.lease.json") return link.call(this, from, to);
    if (linked) await link.call(this, from, to);
    reached.resolve();
    await resume.promise;
    if (!linked) await link.call(this, from, to);
  });
  const acquiring = acquireHumanLease(record.id, env);
  const refused = expect(acquiring).rejects.toThrow("input is closed");
  await reached.promise;
  await stopSessionAgentInput(record.id, env);
  resume.resolve();
  await refused;
  expect(await readHumanLease(record.id, env)).toBeUndefined();
});

it("rolls back a human lease when input closes during its permit drain", async () => {
  const record = await running();
  const permit = await acquireAgentPermit(record.id, env);
  const linked = barrier();
  const acquiring = acquireHumanLease(record.id, env, { _afterCreate: () => linked.resolve() });
  const refused = expect(acquiring).rejects.toThrow("input is closed");
  await linked.promise;
  const listed = watchPermitListing();
  const stopping = stopSessionAgentInput(record.id, env);
  await listed;
  await releaseAgentPermit(permit);
  await stopping;
  await refused;
  expect(await readHumanLease(record.id, env)).toBeUndefined();
});

it("never writes a delayed permit into a pruned and recreated directory", async () => {
  const record = await running();
  await releaseAgentPermit(await acquireAgentPermit(record.id, env));
  const reached = barrier();
  const resume = barrier();
  const write = DirHandle.prototype.writeFileAtomic;
  vi.spyOn(DirHandle.prototype, "writeFileAtomic").mockImplementation(async function (this: DirHandle, name, content) {
    if (name.startsWith(".agent-permit-")) {
      reached.resolve();
      await resume.promise;
    }
    return write.call(this, name, content);
  });
  const action = vi.fn(async () => {});
  const input = withAgentPermit(record.id, env, action);
  const refused = expect(input).rejects.toThrow(AgentPermitUnavailableError);
  await reached.promise;
  await stopSessionAgentInput(record.id, env);
  await retainSessionLogs(record, env);
  await destroySessionRecord(record.id, env);
  expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
  const permits = path.join(sessionDataDir(record.id, env), "permits");
  fs.mkdirSync(permits, { recursive: true });
  fs.writeFileSync(path.join(permits, "replacement.json"), "replacement");
  resume.resolve();
  await refused;
  expect(action).not.toHaveBeenCalled();
  expect(fs.readdirSync(permits)).toEqual(["replacement.json"]);
  expect(fs.readFileSync(path.join(permits, "replacement.json"), "utf8")).toBe("replacement");
  expect(fs.existsSync(marker(record.id))).toBe(true);
  await expect(stopSessionAgentInput(record.id, env)).rejects.toThrow("identity changed");
});

it("refuses teardown if the permits directory is replaced while draining", async () => {
  const record = await running();
  const permit = await acquireAgentPermit(record.id, env);
  const listed = watchPermitListing();
  const stopping = stopSessionAgentInput(record.id, env);
  const refused = expect(stopping).rejects.toThrow("directory was replaced");
  await listed;
  const permits = path.join(sessionDataDir(record.id, env), "permits");
  fs.renameSync(permits, `${permits}.old`);
  fs.mkdirSync(permits);
  fs.writeFileSync(path.join(permits, "replacement.json"), "replacement");
  await releaseAgentPermit(permit);
  await refused;
  expect(fs.readFileSync(path.join(permits, "replacement.json"), "utf8")).toBe("replacement");
  expect(await getSession(record.id, env)).toEqual(record);
  expect(fs.existsSync(marker(record.id))).toBe(true);
});

it("keeps cleanup pending on drain timeout and permits a retry", async () => {
  const record = await running();
  const permit = await acquireAgentPermit(record.id, env);
  await expect(stopSessionAgentInput(record.id, env, 0)).rejects.toMatchObject({
    name: "SessionInputDrainTimeoutError", pendingPermitIds: [permit.permitId],
    message: expect.stringContaining(permit.permitId),
  });
  expect(await getSession(record.id, env)).toMatchObject({ status: "running", desktop: record.desktop });
  expect(fs.existsSync(marker(record.id))).toBe(true);
  await expect(acquireAgentPermit(record.id, env)).rejects.toThrow(AgentPermitUnavailableError);
  await expect(acquireHumanLease(record.id, env)).rejects.toThrow("input is closed");
  await releaseAgentPermit(permit);
  await stopSessionAgentInput(record.id, env, 0);
  await retainSessionLogs(record, env);
  // A finalizer retry still works after retention removed the permit directory.
  await stopSessionAgentInput(record.id, env, 0);
});

it.each(["starting", "error", "stopped"] as const)("refuses ordinary input and human leases for %s records", async (status) => {
  const record = await running();
  await updateSession(record.id, { status }, env);
  await expect(acquireAgentPermit(record.id, env)).rejects.toThrow(AgentPermitUnavailableError);
  await expect(acquireHumanLease(record.id, env)).rejects.toThrow("not running");
});

it("refuses an unknown id without rebuilding coordination", async () => {
  const id = "desk-00000000";
  await expect(withAgentPermit(id, env, vi.fn())).rejects.toThrow(AgentPermitUnavailableError);
  await expect(acquireHumanLease(id, env)).rejects.toThrow("not running");
  expect(fs.existsSync(sessionDataDir(id, env))).toBe(false);
});

it("isolates the same id in two state roots", async () => {
  const record = await running();
  const other = { PICKFORGE_HOME: path.join(home, "other") };
  fs.mkdirSync(path.join(other.PICKFORGE_HOME, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(other.PICKFORGE_HOME, "sessions", `${record.id}.json`), JSON.stringify(record));
  await stopSessionAgentInput(record.id, env);
  await withAgentPermit(record.id, other, async () => {});
  expect(fs.existsSync(path.join(other.PICKFORGE_HOME, "sessions", sessionInputClosedName(record.id)))).toBe(false);
});

it.each([false, true])("cancellation marks cleanup pending only after input closes, closed=%s", async (closed) => {
  const record = await running();
  if (closed) await stopSessionAgentInput(record.id, env);
  const controller = new AbortController();
  controller.abort();
  await expect(stopSessionAgentInput(record.id, env, 0, controller.signal)).rejects.toThrow();
  if (closed) {
    expect(await getSession(record.id, env)).toMatchObject({ status: "error", meta: { reaperCleanupPending: true } });
  } else {
    expect(await getSession(record.id, env)).toMatchObject({ status: "running" });
    expect(fs.existsSync(marker(record.id))).toBe(false);
  }
});

it("ignores staged permits during a human drain and tracks the action after linking", async () => {
  const record = await running();
  const staged = barrier();
  const publish = barrier();
  const entered = barrier();
  const finish = barrier();
  const link = DirHandle.prototype.linkChild;
  vi.spyOn(DirHandle.prototype, "linkChild").mockImplementation(async function (this: DirHandle, from, to) {
    if (from.startsWith(".agent-permit-")) {
      staged.resolve();
      await publish.promise;
    }
    await link.call(this, from, to);
  });
  const permits = path.join(sessionDataDir(record.id, env), "permits");
  const input = withAgentPermit(record.id, env, async () => {
    const names = fs.readdirSync(permits);
    expect(names).toEqual([`${contents.permitId}.json`]);
    expect(JSON.parse(fs.readFileSync(path.join(permits, names[0]!), "utf8"))).toEqual(contents);
    entered.resolve();
    await finish.promise;
  });
  await staged.promise;
  const [name] = fs.readdirSync(permits);
  expect(name).toMatch(/^\.agent-permit-/);
  const raw = fs.readFileSync(path.join(permits, name!), "utf8");
  const contents = JSON.parse(raw) as { permitId: string; sessionId: string; ownerPid: number };
  expect(contents).toMatchObject({ sessionId: record.id, ownerPid: process.pid });
  const lease = await acquireHumanLease(record.id, env, { drainTimeoutMs: 0 });
  expect(fs.readFileSync(path.join(permits, name!), "utf8")).toBe(raw);
  expect(fs.readdirSync(permits)).toEqual([name]);
  await releaseHumanLease(record.id, lease.leaseId, env);
  publish.resolve();
  await entered.promise;
  const listed = watchPermitListing();
  const stopping = stopSessionAgentInput(record.id, env);
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await listed;
  expect(stopped).toBe(false);
  expect(fs.readdirSync(permits)).toEqual([`${contents.permitId}.json`]);
  finish.resolve();
  await input;
  await stopping;
  expect(stopped).toBe(true);
  expect(fs.readdirSync(permits)).toEqual([]);
});

it("refuses a staged permit when teardown closes input before linking", async () => {
  const record = await running();
  const staged = barrier();
  const publish = barrier();
  const link = DirHandle.prototype.linkChild;
  vi.spyOn(DirHandle.prototype, "linkChild").mockImplementation(async function (this: DirHandle, from, to) {
    if (from.startsWith(".agent-permit-")) {
      staged.resolve();
      await publish.promise;
    }
    await link.call(this, from, to);
  });
  const action = vi.fn(async () => {});
  const input = withAgentPermit(record.id, env, action);
  const refused = expect(input).rejects.toThrow(AgentPermitUnavailableError);
  await staged.promise;
  await stopSessionAgentInput(record.id, env, 0);
  expect(fs.readdirSync(path.join(sessionDataDir(record.id, env), "permits"))).toHaveLength(1);
  publish.resolve();
  await refused;
  expect(action).not.toHaveBeenCalled();
  expect(fs.readdirSync(path.join(sessionDataDir(record.id, env), "permits"))).toEqual([]);
});

it("keeps interrupted cleanup eligible through closure without rewriting ownership", async () => {
  const record = await running();
  const permit = await acquireAgentPermit(record.id, env);
  const reached = barrier();
  const resume = barrier();
  const read = DirHandle.prototype.readEntryNames;
  vi.spyOn(DirHandle.prototype, "readEntryNames").mockImplementation(async function (this: DirHandle) {
    if (this.realDir.endsWith("/permits")) {
      reached.resolve();
      await resume.promise;
    }
    return read.call(this);
  });
  const stopping = stopSessionAgentInput(record.id, env);
  await reached.promise;
  expect(fs.existsSync(marker(record.id))).toBe(true);
  expect(await getSession(record.id, env)).toEqual(record);
  expect(fs.existsSync(permit.path)).toBe(true);
  await releaseAgentPermit(permit);
  resume.resolve();
  await stopping;
});

// A killed destroy leaves only this marker: no catch-path record write runs.
it.each(["starting", "running"] as const)("reaps an interrupted %s session from its closure marker", async (status) => {
  const record = await createSession({ type: "desktop", status, projectDir: home }, env);
  fs.writeFileSync(marker(record.id), "");
  const teardown = vi.fn(async (_id, finalize) => {
    expect(await getSession(record.id, env)).toEqual(record);
    await finalize();
  });
  const alive = vi.fn(() => true);
  expect((await reapDeadRunningSessions(env, { desktop: { teardown } }, alive)).map(({ id }) => id)).toEqual([record.id]);
  expect(alive).not.toHaveBeenCalled();
  expect(await getSession(record.id, env)).toBeUndefined();
});
