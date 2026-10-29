import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, destroySessionRecord, sessionDataDir, sessionInputClosedName, takeoverIdentityName, updateSession, type SessionRecord } from "../src/session.js";
import { DirHandle } from "../src/dir-handle.js";
import { sessionsDir } from "../src/paths.js";
import { parseSessionRetentionDuration, pruneSessionLogs, retainSessionLogs, SESSION_MARKER_HORIZON_MS } from "../src/session-retention.js";
import {
  AgentPermitUnavailableError, acquireAgentPermit, acquireHumanLease, isSessionInputClosed,
  readHumanLease, stopSessionAgentInput, withAgentPermit,
} from "../src/takeover.js";

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
  vi.restoreAllMocks();
  forcedIds.length = 0;
  fs.rmSync(home, { recursive: true, force: true });
});

async function stopped(type: "desktop" | "browser" | "android" = "desktop", takeover = false) {
  const record = await createSession({ type, status: "running", projectDir: home }, env);
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

  it("removes orphan lease staging files so the session can be pruned", async () => {
    const record = await createSession({ type: "desktop", projectDir: home }, env);
    const dir = sessionDataDir(record.id, env);
    fs.mkdirSync(dir);
    const uuid = "0f8e2b1c-3d4a-4b5c-8d6e-7f8091a2b3c4";
    fs.writeFileSync(path.join(dir, `.human-lease-${uuid}`), "{}\n");
    fs.writeFileSync(path.join(dir, `..human-lease-${uuid}.tmp-123-4`), "{");
    fs.writeFileSync(path.join(dir, ".human.lease.json.tmp-123-5"), "{");
    const outside = path.join(home, "outside");
    fs.writeFileSync(outside, "unrelated");
    fs.symlinkSync(outside, path.join(dir, `.human-lease-${uuid.replace("0f", "2f")}`));
    // Names no code produces are not staging files.
    fs.writeFileSync(path.join(dir, `..human-lease-${uuid}`), "x");
    fs.mkdirSync(path.join(dir, `.human-lease-${uuid.replace("0f", "1f")}`));
    fs.writeFileSync(path.join(dir, ".human-lease-notes"), "mine");
    await retainSessionLogs(record, env);
    await destroySessionRecord(record.id, env);
    expect(fs.readdirSync(dir).sort()).toEqual([
      `..human-lease-${uuid}`, ".human-lease-1f8e2b1c-3d4a-4b5c-8d6e-7f8091a2b3c4", ".human-lease-notes", "stopped.json",
    ]);
    expect(fs.readFileSync(outside, "utf8")).toBe("unrelated");
    // Unknown entries still block pruning.
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    fs.rmdirSync(path.join(dir, ".human-lease-1f8e2b1c-3d4a-4b5c-8d6e-7f8091a2b3c4"));
    fs.unlinkSync(path.join(dir, ".human-lease-notes"));
    fs.unlinkSync(path.join(dir, `..human-lease-${uuid}`));
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
  });

  it("removes an orphan stopped.json temp so a later retain permits pruning", async () => {
    const { record, dir } = await stopped();
    // A teardown killed between the temp write and the rename leaves this behind.
    // No Linux pid reaches 2147483647, so its writer is dead.
    fs.writeFileSync(path.join(dir, ".stopped.json.tmp-2147483647-4"), "{");
    const live = `.stopped.json.tmp-${process.pid}-999999`;
    fs.writeFileSync(path.join(dir, live), "{");
    fs.writeFileSync(path.join(dir, ".stopped.json.tmp-notes"), "mine");
    fs.mkdirSync(path.join(dir, ".stopped.json.tmp-2147483647-5"));
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    await retainSessionLogs(record, env);
    expect(fs.readdirSync(dir).sort()).toEqual([
      ".stopped.json.tmp-2147483647-5", live, ".stopped.json.tmp-notes", "stopped.json", "xvfb.log",
    ].sort());
    // Unknown entries and a temp from a live writer still block pruning.
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.readFileSync(path.join(dir, ".stopped.json.tmp-notes"), "utf8")).toBe("mine");
    fs.unlinkSync(path.join(dir, ".stopped.json.tmp-notes"));
    fs.rmdirSync(path.join(dir, ".stopped.json.tmp-2147483647-5"));
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    fs.unlinkSync(path.join(dir, live));
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("keeps the marker temp of an overlapping retain for the same session", async () => {
    const { record, dir } = await stopped();
    let notifyPaused!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { notifyPaused = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const rename = fs.promises.rename.bind(fs.promises);
    let captured = false;
    const spy = vi.spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
      if (!captured && String(target).endsWith(`${path.sep}stopped.json`)) {
        captured = true;
        notifyPaused();
        await gate;
      }
      await rename(source, target);
    });
    try {
      const first = retainSessionLogs(record, env);
      await paused;
      const second = retainSessionLogs(record, env);
      await expect(second).resolves.toBeUndefined();
      resume();
      await expect(first).resolves.toBeUndefined();
    } finally {
      resume();
      spy.mockRestore();
    }
    expect(fs.readdirSync(dir).sort()).toEqual(["stopped.json", "xvfb.log"]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "stopped.json"), "utf8")).id).toBe(record.id);
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
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

  it("does not allocate an id whose input closure survives pruning", async () => {
    fs.mkdirSync(sessionsDir(env), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(env), ".desk-0badc0de.input-closed"), "");
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

describe("session marker horizon", () => {
  const markers = (id: string) =>
    [takeoverIdentityName(id), sessionInputClosedName(id)].map((name) => path.join(sessionsDir(env), name));
  const past = () => new Date(Date.now() - SESSION_MARKER_HORIZON_MS - 60_000);
  const backdate = (files: string[], when = past()) => { for (const file of files) fs.utimesSync(file, when, when); };
  const exist = (files: string[]) => files.map((file) => fs.existsSync(file));
  const setStoppedAt = (id: string, when: Date) =>
    fs.writeFileSync(path.join(sessionDataDir(id, env), "stopped.json"), JSON.stringify({ id, stoppedAt: when.toISOString() }));

  async function closed() {
    const record = await createSession({ type: "desktop", status: "running", projectDir: home }, env);
    await withAgentPermit(record.id, env, async () => {});
    await stopSessionAgentInput(record.id, env, 0);
    await retainSessionLogs(record, env);
    await destroySessionRecord(record.id, env);
    return record;
  }

  function orphanMarkers(id: string) {
    fs.mkdirSync(sessionsDir(env), { recursive: true });
    const files = markers(id);
    fs.writeFileSync(files[0]!, "[0,0,null]");
    fs.writeFileSync(files[1]!, "");
    backdate(files);
    return files;
  }

  async function lateInput(id: string) {
    let delivered = false;
    await expect(withAgentPermit(id, env, async () => { delivered = true; })).rejects.toThrow(AgentPermitUnavailableError);
    await expect(acquireHumanLease(id, env)).rejects.toThrow();
    expect(delivered).toBe(false);
  }

  it("keeps both markers inside the horizon, so late callers fail closed and the id stays reserved", async () => {
    const record = await closed();
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    expect(exist(markers(record.id))).toEqual([true, true]);
    await lateInput(record.id);
    expect(fs.existsSync(sessionDataDir(record.id, env))).toBe(false);
    forcedIds.push(record.id.slice("desk-".length), "0badf00d");
    expect((await createSession({ type: "desktop", projectDir: home }, env)).id).toBe("desk-0badf00d");
  });

  it("measures the horizon from teardown when markers are older", async () => {
    const record = await closed();
    backdate(markers(record.id));
    const teardown = new Date(Date.now() - 3_600_000);
    setStoppedAt(record.id, teardown);
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    for (const file of markers(record.id)) expect(Math.abs(fs.statSync(file).mtimeMs - teardown.getTime())).toBeLessThan(1_000);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist(markers(record.id))).toEqual([true, true]);
    await lateInput(record.id);
  });

  it("removes both markers past the horizon and frees the id", async () => {
    const record = await closed();
    setStoppedAt(record.id, past());
    backdate(markers(record.id));
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
    // A late caller still fails closed on the missing record and recreates nothing.
    await lateInput(record.id);
    expect(await readHumanLease(record.id, env)).toBeUndefined();
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
    forcedIds.push(record.id.slice("desk-".length));
    expect((await createSession({ type: "desktop", projectDir: home }, env)).id).toBe(record.id);
  });

  it("removes old markers whose directory is already gone and keeps other files", async () => {
    const old = orphanMarkers("desk-0badc0de");
    const fresh = orphanMarkers("brow-0badf00d");
    backdate(fresh, new Date());
    const others = [".desk-0badc0de.notes", ".desk-0badc0de.input-closed.tmp", "notes.txt"].map((name) => path.join(sessionsDir(env), name));
    for (const file of others) fs.writeFileSync(file, "keep");
    backdate(others);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist(old)).toEqual([false, false]);
    expect(exist(fresh)).toEqual([true, true]);
    expect(exist(others)).toEqual([true, true, true]);
  });

  it.each(["starting", "running", "error"] as const)("keeps old markers while a %s record exists", async (status) => {
    const record = await createSession({ type: "desktop", status: "running", projectDir: home }, env);
    await withAgentPermit(record.id, env, async () => {});
    await stopSessionAgentInput(record.id, env, 0);
    await updateSession(record.id, { status }, env);
    backdate(markers(record.id));
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist(markers(record.id))).toEqual([true, true]);
    // The reaper revives an interrupted teardown through the closure marker.
    expect(await isSessionInputClosed(record.id, env)).toBe(true);
  });

  it("keeps old markers while the session lock or a data directory exists", async () => {
    const files = orphanMarkers("desk-0badc0de");
    const lock = path.join(sessionsDir(env), "desk-0badc0de.ensure-vnc.lock");
    fs.writeFileSync(lock, "{}");
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist(files)).toEqual([true, true]);
    fs.rmSync(lock);
    const data = path.join(sessionsDir(env), "desk-0badc0de");
    fs.mkdirSync(path.join(data, "permits"), { recursive: true });
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist(files)).toEqual([true, true]);
    fs.rmSync(data, { recursive: true });
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist(files)).toEqual([false, false]);
  });

  it("keeps markers when one of them is not a regular file", async () => {
    const files = orphanMarkers("desk-0badc0de");
    fs.rmSync(files[1]!);
    fs.mkdirSync(files[1]!);
    backdate(files);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist(files)).toEqual([true, true]);
  });

  it("does not rebuild storage for a caller that resumes after its markers are pruned", async () => {
    const record = await createSession({ type: "desktop", status: "running", projectDir: home }, env);
    await withAgentPermit(record.id, env, async () => {});
    const closure = markers(record.id)[1]!;
    const lstat = fs.promises.lstat;
    let paused!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => { paused = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let armed = true;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (file: fs.PathLike, options?: fs.StatOptions) => {
      // The late caller read the running record and stops before its closure check.
      if (armed && file === closure) { armed = false; paused(); await gate; }
      return lstat(file, options);
    }) as typeof fs.promises.lstat);
    let delivered = false;
    const late = withAgentPermit(record.id, env, async () => { delivered = true; });
    await reached;
    await stopSessionAgentInput(record.id, env, 0);
    await retainSessionLogs(record, env);
    await destroySessionRecord(record.id, env);
    setStoppedAt(record.id, past());
    backdate(markers(record.id));
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
    resume();
    await expect(late).rejects.toThrow(AgentPermitUnavailableError);
    expect(delivered).toBe(false);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
  });

  it("accepts a marker that a concurrent prune removed first, and refuses a replaced one", async () => {
    const files = orphanMarkers("desk-0badc0de");
    const unlink = DirHandle.prototype.unlinkOwnedFile;
    const spy = vi.spyOn(DirHandle.prototype, "unlinkOwnedFile").mockImplementation(async function (this: DirHandle, name, stat) {
      fs.rmSync(path.join(sessionsDir(env), name));
      return unlink.call(this, name, stat);
    });
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist(files)).toEqual([false, false]);
    const replaced = orphanMarkers("desk-0badc0de");
    spy.mockImplementation(async function (this: DirHandle, name, stat) {
      // Created before the swap, so ext4 cannot hand back the old inode.
      const file = path.join(sessionsDir(env), name);
      fs.writeFileSync(`${file}.new`, "");
      fs.renameSync(`${file}.new`, file);
      return unlink.call(this, name, stat);
    });
    await expect(pruneSessionLogs(0, env)).rejects.toThrow("replaced");
    expect(exist(replaced)).toEqual([true, true]);
  });

  it("stays closed and reserved when prune stops between the two markers", async () => {
    const files = orphanMarkers("desk-0badc0de");
    const unlink = DirHandle.prototype.unlinkOwnedFile;
    let calls = 0;
    vi.spyOn(DirHandle.prototype, "unlinkOwnedFile").mockImplementation(async function (this: DirHandle, name, stat) {
      calls += 1;
      if (calls === 2) throw new Error("crash");
      return unlink.call(this, name, stat);
    });
    await expect(pruneSessionLogs(0, env)).rejects.toThrow("crash");
    expect(exist(files)).toEqual([false, true]);
    await lateInput("desk-0badc0de");
    expect(await readHumanLease("desk-0badc0de", env)).toBeUndefined();
    forcedIds.push("0badc0de", "0badf00d");
    expect((await createSession({ type: "desktop", projectDir: home }, env)).id).toBe("desk-0badf00d");
    vi.restoreAllMocks();
    await pruneSessionLogs(0, env);
    expect(exist(files)).toEqual([false, false]);
  });

  it("finishes a prune that stopped between the stopped.json unlink and rmdir", async () => {
    const record = await closed();
    const dir = sessionDataDir(record.id, env);
    setStoppedAt(record.id, past());
    backdate(markers(record.id));
    vi.spyOn(fs.promises, "rmdir").mockRejectedValueOnce(new Error("crash"));
    await expect(pruneSessionLogs(0, env)).rejects.toThrow("crash");
    expect(fs.readdirSync(dir)).toEqual([]);
    // Young: the directory and its markers stay, and late input still fails closed.
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist([dir, ...markers(record.id)])).toEqual([true, true, true]);
    await lateInput(record.id);
    backdate([dir]);
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
    forcedIds.push(record.id.slice("desk-".length));
    expect((await createSession({ type: "desktop", projectDir: home }, env)).id).toBe(record.id);
  });

  it.each([
    ["a file", (dir: string) => fs.writeFileSync(path.join(dir, "notes.txt"), "mine")],
    ["a hidden file", (dir: string) => fs.writeFileSync(path.join(dir, ".stopped.json.tmp-1-1"), "")],
    ["an unknown directory", (dir: string) => fs.mkdirSync(path.join(dir, "logs"))],
  ])("keeps an old session directory without stopped.json that holds %s", async (_, add) => {
    const files = orphanMarkers("desk-0badc0de");
    const dir = path.join(sessionsDir(env), "desk-0badc0de");
    fs.mkdirSync(dir);
    add(dir);
    backdate([dir]);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect(exist(files)).toEqual([true, true]);
  });

  it.each([
    ["a starting record", async (id: string) => fs.writeFileSync(path.join(sessionsDir(env), `${id}.json`), JSON.stringify({ id, status: "starting" }))],
    ["a running record", async (id: string) => fs.writeFileSync(path.join(sessionsDir(env), `${id}.json`), JSON.stringify({ id, status: "running" }))],
    ["the session lock", async (id: string) => fs.writeFileSync(path.join(sessionsDir(env), `${id}.ensure-vnc.lock`), "{}")],
  ])("keeps an old empty session directory with %s", async (_, add) => {
    const files = orphanMarkers("desk-0badc0de");
    const dir = path.join(sessionsDir(env), "desk-0badc0de");
    fs.mkdirSync(dir);
    backdate([dir]);
    await add("desk-0badc0de");
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist([dir, ...files])).toEqual([true, true, true]);
  });

  it("keeps an empty session directory that gains an entry before rmdir", async () => {
    const dir = path.join(sessionsDir(env), "desk-0badc0de");
    fs.mkdirSync(dir, { recursive: true });
    backdate([dir]);
    const rmdir = fs.promises.rmdir;
    vi.spyOn(fs.promises, "rmdir").mockImplementation(async (target, options) => {
      fs.writeFileSync(path.join(dir, "xvfb.log"), "late");
      return rmdir(target, options);
    });
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "xvfb.log"), "utf8")).toBe("late");
  });

  // A first permit caller re-reads the record, then stalls before it creates the
  // session directory, through teardown.
  async function callerStalledThroughTeardown(record: SessionRecord) {
    const ensure = DirHandle.prototype.ensureChildDir;
    let paused!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => { paused = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let armed = true;
    vi.spyOn(DirHandle.prototype, "ensureChildDir").mockImplementation(async function (this: DirHandle, name, mode) {
      if (armed && name === record.id) { armed = false; paused(); await gate; }
      return ensure.call(this, name, mode);
    });
    let delivered = false;
    const late = withAgentPermit(record.id, env, async () => { delivered = true; });
    await reached;
    await stopSessionAgentInput(record.id, env, 0);
    await retainSessionLogs(record, env);
    await destroySessionRecord(record.id, env);
    const dir = sessionDataDir(record.id, env);
    const permits = path.join(dir, "permits");
    return { id: record.id, dir, permits, late, resume, delivered: () => delivered };
  }

  // The same caller, still stalled after prune.
  async function stalledFirstCaller() {
    const record = await createSession({ type: "desktop", status: "running", projectDir: home }, env);
    const caller = await callerStalledThroughTeardown(record);
    setStoppedAt(record.id, past());
    backdate([markers(record.id)[1]!]);
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
    return caller;
  }

  // It resumes before prune and builds permits/ inside the retained directory.
  async function retainedWithPermits() {
    const record = await createSession({ type: "desktop", status: "running", projectDir: home }, env);
    fs.mkdirSync(sessionDataDir(record.id, env), { recursive: true });
    fs.writeFileSync(path.join(sessionDataDir(record.id, env), "xvfb.log"), "diagnostics");
    const caller = await callerStalledThroughTeardown(record);
    caller.resume();
    await expect(caller.late).rejects.toThrow(AgentPermitUnavailableError);
    expect(caller.delivered()).toBe(false);
    expect(fs.readdirSync(caller.dir).sort()).toEqual(["permits", "stopped.json", "xvfb.log"]);
    expect(fs.readdirSync(caller.permits)).toEqual([]);
    expect(exist(markers(caller.id))).toEqual([true, true]);
    setStoppedAt(caller.id, past());
    return caller;
  }

  it("removes permits/ that a caller stalled only through teardown left in a retained directory", async () => {
    const { id, dir, permits } = await retainedWithPermits();
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.existsSync(permits)).toBe(true);
    backdate([permits, ...markers(id)]);
    expect(await pruneSessionLogs(0, env)).toEqual([id]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
    await lateInput(id);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
  });

  it("removes stale permit files with gone owners from permits/ in a retained directory", async () => {
    const { id, dir, permits } = await retainedWithPermits();
    const dead = deadPid();
    const files = [
      [`${crypto.randomUUID()}.json`, permitRecord(id, dead)],
      [`.agent-permit-${crypto.randomUUID()}`, permitRecord(id, dead)],
      [`..agent-permit-${crypto.randomUUID()}.tmp-${dead}-1`, ""],
    ].map(([name, content]) => { const file = path.join(permits, name!); fs.writeFileSync(file, content!); return file; });
    backdate([...files, permits]);
    expect(await pruneSessionLogs(0, env)).toEqual([id]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it.each([
    ["a young permit with a gone owner", (id: string) => [`${crypto.randomUUID()}.json`, permitRecord(id, deadPid())], false],
    ["an old permit whose owner is alive", (id: string) => [`${crypto.randomUUID()}.json`, permitRecord(id, process.pid)], true],
    ["an old permit temp whose writer is alive", () => [`..agent-permit-${crypto.randomUUID()}.tmp-${process.pid}-1`, ""], true],
    ["an unknown file", () => ["notes.txt", "mine"], true],
  ])("keeps a retained directory whose permits/ holds %s", async (_, entry, old) => {
    const { id, dir, permits } = await retainedWithPermits();
    const [name, content] = entry(id) as [string, string];
    const file = path.join(permits, name);
    fs.writeFileSync(file, content);
    backdate(old ? [file, permits] : [permits]);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(fs.readdirSync(dir).sort()).toEqual(["permits", "stopped.json", "xvfb.log"]);
  });

  it("keeps a retained directory whose permits is a symlink", async () => {
    const { dir, permits } = await retainedWithPermits();
    const target = fs.mkdtempSync(path.join(home, "target-"));
    fs.rmdirSync(permits);
    fs.symlinkSync(target, permits);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(["permits", "stopped.json", "xvfb.log"]);
  });

  async function strandedDirectory() {
    const caller = await stalledFirstCaller();
    caller.resume();
    await expect(caller.late).rejects.toThrow(AgentPermitUnavailableError);
    expect(caller.delivered()).toBe(false);
    expect(fs.readdirSync(caller.dir)).toEqual(["permits"]);
    expect(fs.readdirSync(caller.permits)).toEqual([]);
    expect(exist(markers(caller.id))).toEqual([true, false]);
    return caller;
  }

  const deadPid = () => spawnSync("true").pid!;
  const permitRecord = (id: string, ownerPid: number) => JSON.stringify({ permitId: crypto.randomUUID(), sessionId: id, ownerPid, createdAt: new Date().toISOString() });
  const leaseRecord = (id: string, ownerPid: number) => JSON.stringify({
    leaseId: crypto.randomUUID(), sessionId: id, ownerPid, createdAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(), ttlMs: 30_000, heartbeatMs: 5_000,
  });

  it("removes a directory left by a stalled first caller, then its identity", async () => {
    const { id, dir, permits } = await strandedDirectory();
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist([dir, ...markers(id)])).toEqual([true, true, false]);
    backdate([permits, dir, markers(id)[0]!]);
    expect(await pruneSessionLogs(0, env)).toEqual([id]);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
    await lateInput(id);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
    forcedIds.push(id.slice("desk-".length));
    expect((await createSession({ type: "desktop", projectDir: home }, env)).id).toBe(id);
  });

  it("fails closed for a stalled caller that resumes after its directory is removed", async () => {
    const caller = await stalledFirstCaller();
    const write = DirHandle.prototype.writeFileAtomic;
    let paused!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => { paused = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(DirHandle.prototype, "writeFileAtomic").mockImplementation(async function (this: DirHandle, name, content) {
      // The caller holds its new directories and stops before it writes the permit.
      if (name.startsWith(".agent-permit-")) { paused(); await gate; }
      return write.call(this, name, content);
    });
    caller.resume();
    await reached;
    backdate([caller.permits, caller.dir, markers(caller.id)[0]!]);
    expect(await pruneSessionLogs(0, env)).toEqual([caller.id]);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
    resume();
    await expect(caller.late).rejects.toThrow(AgentPermitUnavailableError);
    expect(caller.delivered()).toBe(false);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
  });

  it.each([
    ["the session directory", "notes.txt"],
    ["the permits directory", "permits/notes.txt"],
    ["the session directory", "human.lease.json.bak"],
  ])("keeps a stranded directory with an unknown file in %s (%s)", async (_, name) => {
    const { id, dir, permits } = await strandedDirectory();
    const file = path.join(dir, name);
    fs.writeFileSync(file, "mine");
    backdate([file, permits, dir, markers(id)[0]!]);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("mine");
    expect(exist(markers(id))).toEqual([true, false]);
  });

  it("keeps a stranded directory while a coordination file is young", async () => {
    const { id, dir, permits } = await strandedDirectory();
    const permit = path.join(permits, `${crypto.randomUUID()}.json`);
    fs.writeFileSync(permit, permitRecord(id, deadPid()));
    backdate([permits, dir, markers(id)[0]!]);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.existsSync(permit)).toBe(true);
    backdate([permit, permits]);
    expect(await pruneSessionLogs(0, env)).toEqual([id]);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
  });

  it.each([
    ["a permit", (id: string) => [`permits/${crypto.randomUUID()}.json`, permitRecord(id, process.pid)]],
    ["a staged permit", (id: string) => [`permits/.agent-permit-${crypto.randomUUID()}`, permitRecord(id, process.pid)]],
    ["a lease", (id: string) => ["human.lease.json", leaseRecord(id, process.pid)]],
    ["a lease renewal temp", () => [`.human.lease.json.tmp-${process.pid}-1`, ""]],
  ])("keeps a stranded directory with %s whose owner is alive", async (_, entry) => {
    const { id, dir, permits } = await strandedDirectory();
    const [name, content] = entry(id);
    const file = path.join(dir, name!);
    fs.writeFileSync(file, content!);
    backdate([file, permits, dir, markers(id)[0]!]);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
    expect(exist(markers(id))).toEqual([true, false]);
  });

  it("finishes a stranded directory on the next prune after one stops midway", async () => {
    const { id, dir, permits } = await strandedDirectory();
    const dead = deadPid();
    const files = [
      [`permits/${crypto.randomUUID()}.json`, permitRecord(id, dead)],
      [`permits/.agent-permit-${crypto.randomUUID()}`, permitRecord(id, dead)],
      [`permits/..agent-permit-${crypto.randomUUID()}.tmp-${dead}-1`, ""],
      ["human.lease.json", leaseRecord(id, dead)],
      [`.human-lease-${crypto.randomUUID()}`, leaseRecord(id, dead)],
      [`..human-lease-${crypto.randomUUID()}.tmp-${dead}-1`, ""],
      [`.human.lease.json.tmp-${dead}-2`, ""],
    ].map(([name, content]) => { const file = path.join(dir, name!); fs.writeFileSync(file, content!); return file; });
    backdate([...files, permits, dir, markers(id)[0]!]);
    const unlink = DirHandle.prototype.unlinkOwnedFile;
    let calls = 0;
    vi.spyOn(DirHandle.prototype, "unlinkOwnedFile").mockImplementation(async function (this: DirHandle, name, stat) {
      calls += 1;
      if (calls === 2) throw new Error("crash");
      return unlink.call(this, name, stat);
    });
    await expect(pruneSessionLogs(0, env)).rejects.toThrow("crash");
    expect(exist(files).filter(Boolean)).toHaveLength(files.length - 1);
    vi.restoreAllMocks();
    // The stopped prune left both directories old, so the next one finishes.
    expect(await pruneSessionLogs(0, env)).toEqual([id]);
    expect(fs.readdirSync(sessionsDir(env))).toEqual([]);
  });

  it("keeps markers when prune stops after carrying the teardown time", async () => {
    const record = await closed();
    backdate(markers(record.id));
    setStoppedAt(record.id, new Date(Date.now() - 3_600_000));
    vi.spyOn(DirHandle.prototype, "unlinkChild").mockRejectedValueOnce(new Error("crash"));
    await expect(pruneSessionLogs(0, env)).rejects.toThrow("crash");
    expect(fs.existsSync(path.join(sessionDataDir(record.id, env), "stopped.json"))).toBe(true);
    vi.restoreAllMocks();
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    expect(exist(markers(record.id))).toEqual([true, true]);
    await lateInput(record.id);
  });

  // A first permit caller killed after it links the takeover identity, before
  // it unlinks the staging file, and another killed inside writeFileAtomic.
  async function identityStaging() {
    const record = await createSession({ type: "desktop", status: "running", projectDir: home }, env);
    const unlink = DirHandle.prototype.unlinkChild;
    vi.spyOn(DirHandle.prototype, "unlinkChild").mockImplementation(async function (this: DirHandle, name) {
      if (name.startsWith(".takeover-identity-")) throw new Error("killed");
      return unlink.call(this, name);
    });
    await expect(withAgentPermit(record.id, env, async () => {})).rejects.toThrow();
    vi.restoreAllMocks();
    const root = sessionsDir(env);
    const staging = fs.readdirSync(root).filter((name) => name.startsWith(".takeover-identity-"));
    expect(staging).toHaveLength(1);
    const temp = path.join(root, `..takeover-identity-${crypto.randomUUID()}.tmp-${deadPid()}-1`);
    fs.writeFileSync(temp, "[0,0,null]");
    return { record, files: [path.join(root, staging[0]!), temp] };
  }

  it("removes takeover identity staging files that a killed writer left", async () => {
    const { record, files } = await identityStaging();
    backdate(files);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist(files)).toEqual([false, false]);
    expect(fs.existsSync(markers(record.id)[0]!)).toBe(true);
    await withAgentPermit(record.id, env, async () => {});
  });

  it("keeps takeover identity staging files inside the horizon", async () => {
    const { files } = await identityStaging();
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(exist(files)).toEqual([true, true]);
  });

  it.each([
    ["a temp whose writer is alive", () => `..takeover-identity-${crypto.randomUUID()}.tmp-${process.pid}-1`, "file"],
    ["a staging name that is a symlink", () => `.takeover-identity-${crypto.randomUUID()}`, "symlink"],
    ["a staging name that is a directory", () => `.takeover-identity-${crypto.randomUUID()}`, "directory"],
    ["a near-miss name", () => `.takeover-identity-${crypto.randomUUID()}.bak`, "file"],
  ])("keeps %s in the sessions root", async (_, name, kind) => {
    const root = sessionsDir(env);
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(home, "target");
    fs.writeFileSync(target, "mine");
    const file = path.join(root, name());
    if (kind === "file") fs.writeFileSync(file, "mine");
    else if (kind === "symlink") fs.symlinkSync(target, file);
    else fs.mkdirSync(file);
    backdate([file, target]);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.lstatSync(file)).toBeDefined();
    expect(fs.readFileSync(target, "utf8")).toBe("mine");
  });

  it("fails closed for a writer that stalls past the horizon before it links the identity", async () => {
    const record = await createSession({ type: "desktop", status: "running", projectDir: home }, env);
    const link = DirHandle.prototype.linkChild;
    let paused!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => { paused = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(DirHandle.prototype, "linkChild").mockImplementation(async function (this: DirHandle, from, to) {
      if (from.startsWith(".takeover-identity-")) { paused(); await gate; }
      return link.call(this, from, to);
    });
    let delivered = false;
    const late = withAgentPermit(record.id, env, async () => { delivered = true; });
    await reached;
    const root = sessionsDir(env);
    const staging = fs.readdirSync(root).filter((name) => name.startsWith(".takeover-identity-"));
    backdate(staging.map((name) => path.join(root, name)));
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.readdirSync(root).filter((name) => name.startsWith(".takeover-identity-"))).toEqual([]);
    resume();
    await expect(late).rejects.toThrow();
    expect(delivered).toBe(false);
    expect(fs.existsSync(markers(record.id)[0]!)).toBe(false);
  });
});
