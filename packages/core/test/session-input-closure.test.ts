import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AgentPermitUnavailableError,
  acquireAgentPermit, acquireHumanLease, createSession, destroySessionRecord,
  getSession, getTakeoverStatus, pruneSessionLogs, readHumanLease,
  releaseAgentPermit, retainSessionLogs, sessionDataDir, sessionInputClosedName,
  stopSessionAgentInput, updateSession, withAgentPermit,
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
  const write = fs.promises.writeFile;
  vi.spyOn(fs.promises, "writeFile").mockImplementation(async (...args) => {
    await write(...args);
    if (String(args[1]).includes('"permitId"')) {
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
  const write = fs.promises.writeFile;
  vi.spyOn(fs.promises, "writeFile").mockImplementation(async (...args) => {
    if (String(args[1]).includes('"permitId"')) {
      reached.resolve();
      await resume.promise;
    }
    return write(...args);
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
  expect(await getSession(record.id, env)).toMatchObject({ status: "error", meta: { reaperCleanupPending: true } });
});

it("keeps cleanup pending on drain timeout and permits a retry", async () => {
  const record = await running();
  const permit = await acquireAgentPermit(record.id, env);
  await expect(stopSessionAgentInput(record.id, env, 0)).rejects.toMatchObject({
    name: "SessionInputDrainTimeoutError", pendingPermitIds: [permit.permitId],
    message: expect.stringContaining(permit.permitId),
  });
  expect(await getSession(record.id, env)).toMatchObject({ status: "error", desktop: record.desktop, meta: { reaperCleanupPending: true } });
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
