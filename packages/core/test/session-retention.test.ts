import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, destroySessionRecord, sessionDataDir, takeoverIdentityName, updateSession } from "../src/session.js";
import { sessionsDir } from "../src/paths.js";
import { parseSessionRetentionDuration, pruneSessionLogs, retainSessionLogs } from "../src/session-retention.js";
import { AgentPermitUnavailableError, acquireAgentPermit, acquireHumanLease, readHumanLease, getTakeoverStatus, withAgentPermit } from "../src/takeover.js";

const forcedIds = vi.hoisted(() => [] as string[]);
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomBytes = (size: number) => {
    const forced = forcedIds.shift();
    return forced === undefined ? actual.randomBytes(size) : Buffer.from(forced, "hex");
  };
  return { ...actual, default: { ...actual, randomBytes }, randomBytes };
});

let home: string;
let env: { PICKFORGE_HOME: string };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-retention-"));
  env = { PICKFORGE_HOME: home };
});
afterEach(() => {
  forcedIds.length = 0;
  fs.rmSync(home, { recursive: true, force: true });
});

async function stopped(type: "desktop" | "browser" | "android" = "desktop", takeover = false) {
  const record = await createSession({ type, projectDir: home, status: "running" }, env);
  const dir = sessionDataDir(record.id, env);
  if (takeover) await withAgentPermit(record.id, env, async () => {});
  else fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "xvfb.log"), "diagnostics");
  await retainSessionLogs(record, env);
  await destroySessionRecord(record.id, env);
  return { record, dir };
}

describe("explicit session log pruning", () => {
  it("prunes all three types only on explicit request", async () => {
    const sessions = await Promise.all([stopped("desktop"), stopped("browser"), stopped("android")]);
    for (const { dir } of sessions) expect(fs.existsSync(path.join(dir, "xvfb.log"))).toBe(true);
    expect((await pruneSessionLogs(0, env)).sort()).toEqual(sessions.map(({ record }) => record.id).sort());
    for (const { dir } of sessions) expect(fs.existsSync(dir)).toBe(false);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
  });

  it("uses teardown time rather than creation or file modification time", async () => {
    const old = await stopped();
    const fresh = await stopped();
    fs.writeFileSync(path.join(old.dir, "stopped.json"), JSON.stringify({ id: old.record.id, stoppedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }));
    expect(await pruneSessionLogs(parseSessionRetentionDuration("7d"), env)).toEqual([old.record.id]);
    expect(fs.existsSync(fresh.dir)).toBe(true);
  });

  it.each(["starting", "running", "error", "stopped"] as const)("never deletes a directory with a %s registry record", async (status) => {
    const { record, dir } = await stopped();
    fs.writeFileSync(path.join(sessionsDir(env), `${record.id}.json`), JSON.stringify({ ...record, status }));
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.existsSync(path.join(dir, "xvfb.log"))).toBe(true);
  });

  it("retains failed-start diagnostics through explicit destroy, then permits pruning", async () => {
    const record = await createSession({ type: "android", projectDir: home }, env);
    const failure = await updateSession(record.id, { status: "error", meta: { androidStartFailure: { kind: "boot-timeout" } } }, env);
    await retainSessionLogs(failure, env);
    const dir = sessionDataDir(record.id, env);
    fs.writeFileSync(path.join(dir, "emulator.log"), "boot failed");
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    await destroySessionRecord(record.id, env);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "stopped.json"), "utf8")).failure).toEqual(failure);
    expect(fs.readFileSync(path.join(dir, "emulator.log"), "utf8")).toBe("boot failed");
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
  });

  it("keeps unmarked legacy directories, unknown data and teardown locks", async () => {
    const unmarked = await stopped();
    fs.unlinkSync(path.join(unmarked.dir, "stopped.json"));
    const unknown = await stopped();
    fs.writeFileSync(path.join(unknown.dir, "notes.txt"), "mine");
    const locked = await stopped();
    fs.writeFileSync(path.join(sessionsDir(env), `${locked.record.id}.ensure-vnc.lock`), "{}");
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.readFileSync(path.join(unknown.dir, "notes.txt"), "utf8")).toBe("mine");
  });

  it.each(["xvfb.log", "stopped.json"])("never follows a %s symlink", async (name) => {
    const { dir } = await stopped();
    const outside = path.join(home, "outside");
    fs.writeFileSync(outside, "unrelated");
    fs.unlinkSync(path.join(dir, name));
    fs.symlinkSync(outside, path.join(dir, name));
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.readFileSync(outside, "utf8")).toBe("unrelated");
  });

  it.each(["not json", "{}", JSON.stringify({ id: "desk-000000", stoppedAt: "invalid" })])("keeps malformed retention metadata %s", async (marker) => {
    const { dir } = await stopped();
    fs.writeFileSync(path.join(dir, "stopped.json"), marker);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.existsSync(path.join(dir, "xvfb.log"))).toBe(true);
  });

  it("refuses a symlinked sessions root", async () => {
    const { dir } = await stopped();
    const outside = path.join(home, "outside");
    fs.renameSync(sessionsDir(env), outside);
    fs.symlinkSync(outside, sessionsDir(env));
    await expect(pruneSessionLogs(0, env)).rejects.toThrow(/symlink/);
    expect(fs.existsSync(path.join(outside, path.basename(dir), "xvfb.log"))).toBe(true);
  });

  it("never follows a session directory symlink", async () => {
    const { record, dir } = await stopped();
    const outside = path.join(home, "outside");
    fs.renameSync(dir, outside);
    fs.symlinkSync(outside, dir);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.existsSync(path.join(outside, "xvfb.log"))).toBe(true);
    expect(fs.lstatSync(path.join(sessionsDir(env), record.id)).isSymbolicLink()).toBe(true);
  });

  it("removes permit links without touching their targets", async () => {
    const record = await createSession({ type: "desktop", projectDir: home }, env);
    const dir = sessionDataDir(record.id, env);
    fs.mkdirSync(dir);
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "mine"), "keep");
    fs.symlinkSync(outside, path.join(dir, "permits"));
    await retainSessionLogs(record, env);
    expect(fs.existsSync(path.join(dir, "permits"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "mine"), "utf8")).toBe("keep");
  });

  it.each([false, true])("refuses delayed first input after teardown (prune=%s)", async (prune) => {
    const a = await createSession({ type: "desktop", projectDir: home, status: "running", desktop: { display: ":987" } }, env);
    const dir = sessionDataDir(a.id, env);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "xvfb.log"), "diagnostics");
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const action = vi.fn(async () => {});
    // The caller resolved A's display, then stalled before entering the gate.
    const delayed = (async () => {
      await gate;
      return withAgentPermit(a.id, env, action);
    })();
    await retainSessionLogs(a, env);
    await destroySessionRecord(a.id, env);
    if (prune) expect(await pruneSessionLogs(0, env)).toEqual([a.id]);
    const b = await createSession({ type: "desktop", projectDir: home, status: "running", desktop: { display: a.desktop!.display } }, env);
    const lease = await acquireHumanLease(b.id, env);
    resume();
    await expect(delayed).rejects.toThrow(AgentPermitUnavailableError);
    expect(action).not.toHaveBeenCalled();
    await expect(acquireHumanLease(a.id, env)).rejects.toThrow("not running");
    expect(fs.existsSync(path.join(sessionsDir(env), takeoverIdentityName(a.id)))).toBe(false);
    expect(fs.existsSync(path.join(dir, "permits"))).toBe(false);
    expect(fs.existsSync(dir)).toBe(!prune);
    expect(await getTakeoverStatus(a.id, env)).toEqual({ sessionId: a.id, active: false });
    expect(await readHumanLease(b.id, env)).toEqual(lease);
    if (!prune) expect(fs.readFileSync(path.join(dir, "xvfb.log"), "utf8")).toBe("diagnostics");
  });

  it("keeps the takeover identity so late callers for a pruned id still fail closed", async () => {
    const { record, dir } = await stopped("desktop", true);
    const marker = path.join(sessionsDir(env), takeoverIdentityName(record.id));
    const binding = fs.readFileSync(marker, "utf8");
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(marker, "utf8")).toBe(binding);
    let delivered = false;
    await expect(withAgentPermit(record.id, env, async () => { delivered = true; })).rejects.toThrow();
    await expect(readHumanLease(record.id, env)).rejects.toThrow();
    expect(delivered).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    await expect(acquireAgentPermit(record.id, env)).rejects.toThrow();
  });

  it("does not allocate an id whose takeover identity is still reserved", async () => {
    fs.mkdirSync(sessionsDir(env), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(env), takeoverIdentityName("desk-0badc0de")), "[0,0,null]");
    forcedIds.push("0badc0de", "0badf00d");
    expect((await createSession({ type: "desktop", projectDir: home }, env)).id).toBe("desk-0badf00d");
  });

  it.each(["", "0d", "-1d", "1.5h", "1", "all", "999999999999999w"])("rejects invalid duration %s", (value) => {
    expect(() => parseSessionRetentionDuration(value)).toThrow();
  });
  it.each(["1s", "2m", "3h", "4d", "5w"])("accepts duration %s", (value) => {
    expect(parseSessionRetentionDuration(value)).toBeGreaterThan(0);
  });
});

describe("orphaned human lease staging", () => {
  const uuid = "12345678-abcd-4321-abcd-123456789abc";
  const stages = [`.human-lease-${uuid}`, `..human-lease-${uuid}.tmp-123-1`, ".human.lease.json.tmp-123-2"];

  it("cleans exact staging files and links without following targets", async () => {
    const record = await createSession({ type: "desktop", projectDir: home, status: "running" }, env);
    const dir = sessionDataDir(record.id, env);
    fs.mkdirSync(dir);
    const outside = path.join(home, "outside");
    fs.writeFileSync(outside, "keep");
    for (const name of stages) fs.writeFileSync(path.join(dir, name), "orphan");
    fs.unlinkSync(path.join(dir, stages[1]!));
    fs.symlinkSync(outside, path.join(dir, stages[1]!));
    fs.mkdirSync(path.join(dir, ".human.lease.json.tmp-123-3"));
    fs.writeFileSync(path.join(dir, ".human-lease-not-a-uuid"), "keep");
    await retainSessionLogs(record, env);
    for (const name of stages) expect(fs.existsSync(path.join(dir, name))).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    expect(fs.statSync(path.join(dir, ".human.lease.json.tmp-123-3")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".human-lease-not-a-uuid"), "utf8")).toBe("keep");
  });

  it("recovers renewal stages left after retention before explicit pruning", async () => {
    const { record, dir } = await stopped();
    for (const name of stages) fs.writeFileSync(path.join(dir, name), "orphan");
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("retains logs and prunes after killing a claimant before lease linking", async () => {
    const record = await createSession({ type: "desktop", projectDir: home, status: "running" }, env);
    const ready = path.join(home, "ready");
    const worker = fileURLToPath(new URL("./workers/takeover-crash-worker.ts", import.meta.url));
    const child = spawn("bun", [worker, home, record.id, ready], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    try {
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 5_000 });
      const dir = sessionDataDir(record.id, env);
      expect(fs.readdirSync(dir).some((name) => name.startsWith(".human-lease-"))).toBe(true);
      expect(await readHumanLease(record.id, env)).toBeUndefined();
      child.kill("SIGKILL");
      await exited;
      fs.writeFileSync(path.join(dir, "xvfb.log"), "diagnostics");
      await retainSessionLogs(record, env);
      expect(fs.readdirSync(dir).sort()).toEqual(["stopped.json", "xvfb.log"]);
      await destroySessionRecord(record.id, env);
      expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  }, 10_000);
});
