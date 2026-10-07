import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeDirChange,
  dirChangeError,
  guardedSessionDirs,
  startGuard,
  type GuardTeardown,
} from "./home-sessions-guard.js";

describe("home sessions guard helpers", () => {
  it("guards the default sessions directory and a parent PICKFORGE_HOME", () => {
    expect(guardedSessionDirs({}, "/home/u")).toEqual(["/home/u/.pickforge/lab/sessions"]);
    expect(guardedSessionDirs({ PICKFORGE_HOME: "" }, "/home/u")).toEqual([
      "/home/u/.pickforge/lab/sessions",
    ]);
    expect(guardedSessionDirs({ PICKFORGE_HOME: "/srv/pf" }, "/home/u")).toEqual([
      "/home/u/.pickforge/lab/sessions",
      "/srv/pf/sessions",
    ]);
  });

  it("reports added and removed entries and directory creation", () => {
    expect(describeDirChange(undefined, undefined)).toBeUndefined();
    expect(describeDirChange(["a"], ["a"])).toBeUndefined();
    expect(describeDirChange(["a"], ["a", "b"])).toEqual({ added: ["b"], removed: [] });
    expect(describeDirChange(["a", "b"], ["b"])).toEqual({ added: [], removed: ["a"] });
    expect(describeDirChange(undefined, [])).toEqual({ added: [], removed: [] });
    expect(describeDirChange([], undefined)).toEqual({ added: [], removed: [] });
  });

  it("names the directory, the entries, and the issue in the error", () => {
    const names = Array.from({ length: 12 }, (_, i) => `desk-${i}`);
    const message = dirChangeError("/home/u/.pickforge/lab/sessions", {
      added: names,
      removed: ["old"],
    }).message;
    expect(message).toContain("/home/u/.pickforge/lab/sessions changed");
    expect(message).toContain("added desk-0,");
    expect(message).toContain("and 2 more");
    expect(message).toContain("removed old");
    expect(message).toContain("#264");
    expect(dirChangeError("/d", { added: [], removed: [] }).message).toContain(
      "created or removed the directory",
    );
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

  it("passes when the directory stays absent or unchanged", () => {
    const absent = start();
    expect(absent()).toBeUndefined();
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "desk-keep.json"), "{}");
    const present = start();
    fs.writeFileSync(path.join(dir, "desk-keep.json"), "{\"changed\":true}");
    expect(present()).toBeUndefined();
    expect(process.exitCode).toBe(savedExitCode);
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

  it("fails when the directory is created during the run", () => {
    const teardown = start();
    fs.mkdirSync(dir);
    expect(() => teardown()).toThrow(/created or removed the directory/);
    expect(process.exitCode).toBe(1);
  });

  it("reports every changed directory", () => {
    const other = path.join(root, "other");
    fs.mkdirSync(dir);
    fs.mkdirSync(other);
    const teardown = startGuard([dir, other]);
    fs.writeFileSync(path.join(dir, "a"), "");
    fs.writeFileSync(path.join(other, "b"), "");
    let error: unknown;
    try {
      teardown?.();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
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
