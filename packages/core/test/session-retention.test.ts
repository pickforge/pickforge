import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, destroySessionRecord, sessionDataDir, takeoverIdentityName, updateSession } from "../src/session.js";
import { sessionsDir } from "../src/paths.js";
import { parseSessionRetentionDuration, pruneSessionLogs, retainSessionLogs } from "../src/session-retention.js";
import { acquireAgentPermit, releaseAgentPermit, withAgentPermit } from "../src/takeover.js";

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
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

async function stopped(type: "desktop" | "browser" | "android" = "desktop", takeover = false) {
  const record = await createSession({ type, projectDir: home }, env);
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

  it("retires a takeover identity bound to the pruned directory so its id works again", async () => {
    const { record, dir } = await stopped("desktop", true);
    const marker = path.join(sessionsDir(env), takeoverIdentityName(record.id));
    expect(fs.existsSync(marker)).toBe(true);
    // A late caller for the torn-down session fails closed before pruning.
    await expect(acquireAgentPermit(record.id, env)).rejects.toThrow(/identity changed/);
    expect(await pruneSessionLogs(0, env)).toEqual([record.id]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    const permit = await acquireAgentPermit(record.id, env);
    await releaseAgentPermit(permit);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it.each([
    ["another directory", JSON.stringify([0, 0, null])],
    ["unreadable", "not json"],
  ])("keeps the directory and a takeover identity bound to %s", async (_label, content) => {
    const { record, dir } = await stopped("desktop", true);
    const marker = path.join(sessionsDir(env), takeoverIdentityName(record.id));
    fs.unlinkSync(marker);
    fs.writeFileSync(marker, content);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.existsSync(path.join(dir, "xvfb.log"))).toBe(true);
    expect(fs.readFileSync(marker, "utf8")).toBe(content);
  });

  it("keeps a takeover identity symlink without following it", async () => {
    const { record, dir } = await stopped("desktop", true);
    const marker = path.join(sessionsDir(env), takeoverIdentityName(record.id));
    const outside = path.join(home, "outside");
    fs.renameSync(marker, outside);
    fs.symlinkSync(outside, marker);
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    expect(fs.existsSync(path.join(dir, "xvfb.log"))).toBe(true);
    expect(fs.lstatSync(marker).isSymbolicLink()).toBe(true);
  });

  it("keeps the binding while a permit is held or the session is registered", async () => {
    const held = await stopped("desktop", true);
    fs.mkdirSync(path.join(held.dir, "permits"));
    const active = await stopped("desktop", true);
    fs.writeFileSync(path.join(sessionsDir(env), `${active.record.id}.json`), JSON.stringify({ ...active.record, status: "running" }));
    expect(await pruneSessionLogs(0, env)).toEqual([]);
    for (const { record } of [held, active]) {
      expect(fs.existsSync(path.join(sessionsDir(env), takeoverIdentityName(record.id)))).toBe(true);
    }
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
