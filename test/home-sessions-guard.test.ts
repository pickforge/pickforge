import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { legacySessionsDirs, sessionsDir } from "../packages/core/src/paths.js";
import {
  allowRealHomeChanges,
  describeDirChange,
  dirChangeMessage,
  guardedSessionDirs,
  readDirSnapshot,
  startGuard,
  type GuardTeardown,
} from "./home-sessions-guard.js";

describe("home sessions guard helpers", () => {
  it("guards the default, legacy, and parent PICKFORGE_HOME sessions directories", () => {
    const defaults = [
      "/home/u/.pickforge/lab/sessions",
      "/home/u/.pickforge/picklab/sessions",
      "/home/u/.picklab/sessions",
    ];
    expect(guardedSessionDirs({}, "/home/u")).toEqual(defaults);
    expect(guardedSessionDirs({ PICKFORGE_HOME: "" }, "/home/u")).toEqual(defaults);
    expect(guardedSessionDirs({ PICKFORGE_HOME: "/srv/pf" }, "/home/u")).toEqual([
      ...defaults,
      "/srv/pf/sessions",
    ]);
  });

  it("matches the product's default and legacy sessions directories", () => {
    expect(guardedSessionDirs({})).toEqual([sessionsDir({}), ...legacySessionsDirs({})]);
  });

  it("reads the opt-out only from its exact value", () => {
    expect(allowRealHomeChanges({})).toBe(false);
    expect(allowRealHomeChanges({ PICKFORGE_TEST_ALLOW_REAL_HOME_CHANGES: "0" })).toBe(false);
    expect(allowRealHomeChanges({ PICKFORGE_TEST_ALLOW_REAL_HOME_CHANGES: "1" })).toBe(true);
  });

  it("reports added, removed, and modified entries and directory changes", () => {
    const snap = (entries: Record<string, string>) => new Map(Object.entries(entries));
    expect(describeDirChange(undefined, undefined)).toBeUndefined();
    expect(describeDirChange(snap({ a: "dir" }), snap({ a: "dir" }))).toBeUndefined();
    expect(describeDirChange(snap({ a: "dir" }), snap({ a: "dir", b: "f" }))).toEqual({
      added: ["b"],
      removed: [],
      modified: [],
    });
    expect(describeDirChange(snap({ a: "x", b: "y" }), snap({ a: "z" }))).toEqual({
      added: [],
      removed: ["b"],
      modified: ["a"],
    });
    expect(describeDirChange(undefined, snap({}))).toMatchObject({ directory: "created" });
    expect(describeDirChange(snap({}), undefined)).toMatchObject({ directory: "removed" });
  });

  it("names the directory, the paths, the opt-out, and the issue in the message", () => {
    const names = Array.from({ length: 12 }, (_, i) => `desk-${i}`);
    const message = dirChangeMessage("/home/u/.pickforge/lab/sessions", {
      added: names,
      removed: ["old"],
      modified: ["desk-1/permit"],
    });
    expect(message).toContain("/home/u/.pickforge/lab/sessions changed");
    expect(message).toContain("added desk-0,");
    expect(message).toContain("and 2 more");
    expect(message).toContain("removed old");
    expect(message).toContain("modified desk-1/permit");
    expect(message).toContain("PICKFORGE_TEST_ALLOW_REAL_HOME_CHANGES=1");
    expect(message).toContain("#264");
    expect(
      dirChangeMessage("/d", { added: [], removed: [], modified: [], directory: "created" }),
    ).toContain("created the directory");
  });
});

describe("startGuard", () => {
  let root: string;
  let dir: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-home-guard-"));
    dir = path.join(root, "sessions");
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function start(): GuardTeardown {
    const teardown = startGuard([dir]);
    if (teardown === undefined) throw new Error("expected an active guard");
    return teardown;
  }

  function seed(): void {
    fs.mkdirSync(path.join(dir, "desk-keep", "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "desk-keep.json"), "{}");
    fs.writeFileSync(path.join(dir, "desk-keep", "agents", "a.json"), "{}");
  }

  it("passes when the directory stays absent or unchanged", () => {
    const absent = start();
    expect(absent()).toBeUndefined();
    seed();
    const present = start();
    expect(present()).toBeUndefined();
    expect(process.exitCode).toBe(savedExitCode);
  });

  it("records nested entries with relative paths", () => {
    seed();
    expect([...(readDirSnapshot(dir)?.keys() ?? [])].sort()).toEqual([
      "desk-keep",
      "desk-keep.json",
      path.join("desk-keep", "agents"),
      path.join("desk-keep", "agents", "a.json"),
    ]);
  });

  it("fails and sets the exit code when a test adds an entry", () => {
    fs.mkdirSync(dir);
    const teardown = start();
    fs.mkdirSync(path.join(dir, "desk-leak"));
    fs.writeFileSync(path.join(dir, ".desk-leak.takeover-identity"), "[]");
    expect(() => teardown()).toThrow(/added \.desk-leak\.takeover-identity, desk-leak/);
    expect(process.exitCode).toBe(1);
    // The guard only observes: the leaked entries stay in place.
    expect(fs.existsSync(path.join(dir, "desk-leak"))).toBe(true);
  });

  it("fails when a test adds an entry inside an existing session", () => {
    seed();
    const teardown = start();
    fs.writeFileSync(path.join(dir, "desk-keep", "agents", "b.json"), "{}");
    expect(() => teardown()).toThrow(`added ${path.join("desk-keep", "agents", "b.json")}`);
  });

  it("fails when a test removes a nested entry", () => {
    seed();
    const teardown = start();
    fs.rmSync(path.join(dir, "desk-keep", "agents", "a.json"));
    expect(() => teardown()).toThrow(`removed ${path.join("desk-keep", "agents", "a.json")}`);
  });

  it("fails when a test rewrites a session record or a nested file", () => {
    seed();
    const teardown = start();
    // An atomic rewrite with the same size still replaces the inode.
    const record = path.join(dir, "desk-keep.json");
    fs.writeFileSync(`${record}.tmp`, "[]");
    fs.renameSync(`${record}.tmp`, record);
    fs.writeFileSync(path.join(dir, "desk-keep", "agents", "a.json"), "{\"changed\":true}");
    expect(() => teardown()).toThrow(
      `modified desk-keep.json, ${path.join("desk-keep", "agents", "a.json")}`,
    );
  });

  it("fails when the directory is created during the run", () => {
    const teardown = start();
    fs.mkdirSync(dir);
    expect(() => teardown()).toThrow(/created the directory/);
    expect(process.exitCode).toBe(1);
  });

  it("fails when the directory is removed during the run", () => {
    seed();
    const teardown = start();
    fs.rmSync(dir, { recursive: true });
    expect(() => teardown()).toThrow(/removed the directory; removed desk-keep/);
  });

  it("reports every changed directory, including legacy roots", () => {
    const home = path.join(root, "home");
    const dirs = guardedSessionDirs({}, home);
    for (const guarded of dirs) fs.mkdirSync(guarded, { recursive: true });
    const teardown = startGuard(dirs);
    fs.writeFileSync(path.join(dirs[1], "a"), "");
    fs.writeFileSync(path.join(dirs[2], "b"), "");
    let error: unknown;
    try {
      teardown?.();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    const messages = (error as AggregateError).errors.map((e: Error) => e.message);
    expect(messages).toEqual([
      expect.stringContaining(`${path.join(home, ".pickforge", "picklab", "sessions")} changed`),
      expect.stringContaining(`${path.join(home, ".picklab", "sessions")} changed`),
    ]);
  });

  it("only warns, with the changed paths, when changes are allowed", () => {
    seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const teardown = startGuard([dir], { allowChanges: true });
    fs.writeFileSync(path.join(dir, "desk-keep", "agents", "b.json"), "{}");
    expect(teardown?.()).toBeUndefined();
    expect(process.exitCode).toBe(savedExitCode);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`added ${path.join("desk-keep", "agents", "b.json")}`),
    );
  });

  it("fails when the directory cannot be read at teardown", () => {
    fs.mkdirSync(dir);
    const teardown = start();
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, "");
    expect(() => teardown()).toThrow(/could not read .* at teardown/);
    expect(process.exitCode).toBe(1);
  });

  it("skips a directory it cannot read at setup", () => {
    fs.writeFileSync(dir, "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(startGuard([dir])).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Home sessions guard skips"));
  });
});
