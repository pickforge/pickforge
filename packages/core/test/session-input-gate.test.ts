import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AgentPermitUnavailableError, SessionInputDrainTimeoutError,
  acquireAgentPermit, acquireHumanLease, createSession, destroySessionRecord,
  getSession, getTakeoverStatus, pruneSessionLogs, readHumanLease,
  releaseAgentPermit, retainSessionLogs, sessionDataDir, sessionInputClosedName,
  stopSessionAgentInput, updateSession, withAgentPermit,
} from "../src/index.js";
import { withSessionGate } from "../src/session-gate.js";

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

it("serializes validation and permit publication against closure", async () => {
  const record = await running();
  const read = fs.promises.readFile;
  const validated = barrier();
  const resume = barrier();
  let stalled = false;
  vi.spyOn(fs.promises, "readFile").mockImplementation(async (...args) => {
    const raw = await read(...args);
    if (!stalled && String(args[0]).endsWith(`${record.id}.json`)) {
      stalled = true;
      validated.resolve();
      await resume.promise;
    }
    return raw;
  });
  const acquiring = acquireAgentPermit(record.id, env);
  await validated.promise;
  // A peer cannot close input while validation holds the kernel gate.
  await expect(withSessionGate(record.id, env, async () => {}, 0)).rejects.toThrow("Timed out waiting");
  const open = fs.promises.open;
  const closed = barrier();
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(sessionInputClosedName(record.id))) closed.resolve();
    return file;
  });
  const stopping = stopSessionAgentInput(record.id, env);
  resume.resolve();
  const permit = await acquiring;
  await closed.promise;
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  expect(stopped).toBe(false);
  await releaseAgentPermit(permit);
  await stopping;
  expect(stopped).toBe(true);
});

it("keeps cleanup pending on drain timeout and permits a retry", async () => {
  const record = await running();
  const permit = await acquireAgentPermit(record.id, env);
  await expect(stopSessionAgentInput(record.id, env, 0)).rejects.toThrow(SessionInputDrainTimeoutError);
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
  await withSessionGate(record.id, env, async () => {
    await withSessionGate(record.id, other, async () => {}, 0);
    await expect(withSessionGate(record.id, env, async () => {}, 0)).rejects.toThrow("Timed out waiting");
    await withAgentPermit(record.id, other, async () => {});
  });
});

it("releases a Bun holder's gate on SIGKILL for a Node caller", async () => {
  const record = await running();
  const worker = fileURLToPath(new URL("./workers/session-gate-worker.ts", import.meta.url));
  const child = spawn("bun", [worker, home, record.id], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    const [chunk] = await once(child.stdout, "data");
    expect(String(chunk).trim()).toBe("held");
    await expect(withSessionGate(record.id, env, async () => {}, 0)).rejects.toThrow("Timed out waiting");
    child.kill("SIGKILL");
    expect(await exited).toEqual([null, "SIGKILL"]);
    await withAgentPermit(record.id, env, async () => {});
    await stopSessionAgentInput(record.id, env, 0);
    expect(fs.readdirSync(path.join(home, "sessions")).some((name) => name.includes("lock"))).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

it("releases the gate when its action throws", async () => {
  const record = await running();
  const failure = new Error("critical section failed");
  await expect(withSessionGate(record.id, env, async () => { throw failure; })).rejects.toBe(failure);
  await withSessionGate(record.id, env, async () => {}, 0);
});
