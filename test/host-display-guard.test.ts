import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeSocketChange,
  displaySocketPath,
  socketChangeError,
  startGuard,
  watchSocket,
  type GuardTeardown,
  type SocketState,
} from "./host-display-guard.js";

describe("host display guard", () => {
  it("maps local DISPLAY values to their path socket", () => {
    expect(displaySocketPath(":0")).toBe("/tmp/.X11-unix/X0");
    expect(displaySocketPath(":12.1")).toBe("/tmp/.X11-unix/X12");
  });

  it("reads leading zeros as Xlib does", () => {
    expect(displaySocketPath(":061029")).toBe("/tmp/.X11-unix/X61029");
    expect(displaySocketPath(":00")).toBe("/tmp/.X11-unix/X0");
  });

  it("ignores unset, empty, and non-local DISPLAY values", () => {
    for (const display of [undefined, "", "localhost:0", ":", ":x", "0", ":1.", "wayland-1"]) {
      expect({ display, path: displaySocketPath(display) }).toEqual({
        display,
        path: undefined,
      });
    }
  });

  it("reports created, removed, and replaced sockets", () => {
    const absent: SocketState = { kind: "absent" };
    const original: SocketState = { kind: "present", dev: 1, ino: 100 };
    expect(describeSocketChange(absent, absent)).toBeUndefined();
    expect(describeSocketChange(original, { ...original })).toBeUndefined();
    expect(describeSocketChange(absent, original)).toBe("created");
    expect(describeSocketChange(original, absent)).toBe("removed");
    expect(describeSocketChange(original, { kind: "present", dev: 1, ino: 101 })).toBe("replaced");
    expect(describeSocketChange(original, { kind: "present", dev: 2, ino: 100 })).toBe("replaced");
  });

  it("names the display, the path, and the issue in the error", () => {
    const message = socketChangeError(":0", "/tmp/.X11-unix/X0", "replaced").message;
    expect(message).toContain("host display socket for DISPLAY=:0 changed");
    expect(message).toContain("/tmp/.X11-unix/X0");
    expect(message).toContain("#234");
  });
});

describe("startGuard", () => {
  let dir: string;
  let socketPath: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-display-guard-"));
    socketPath = path.join(dir, "X64999");
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function start(): GuardTeardown {
    const teardown = startGuard(":64999", socketPath);
    if (teardown === undefined) throw new Error("expected an active guard");
    return teardown;
  }

  it("passes when the socket does not change", async () => {
    fs.writeFileSync(socketPath, "");
    await expect(start()()).resolves.toBeUndefined();
    expect(process.exitCode).toBe(savedExitCode);
  });

  it("passes when the socket stays absent", async () => {
    await expect(start()()).resolves.toBeUndefined();
  });

  it("fails when the socket is replaced", async () => {
    fs.writeFileSync(socketPath, "");
    const teardown = start();
    fs.rmSync(socketPath);
    fs.writeFileSync(socketPath, "");
    await expect(teardown()).rejects.toThrow("changed during the test run");
    expect(process.exitCode).toBe(1);
  });

  it("fails when the socket is created and removed during the run", async () => {
    const teardown = start();
    fs.writeFileSync(socketPath, "");
    fs.rmSync(socketPath);
    await expect(teardown()).rejects.toThrow("created, removed, or renamed during the run");
    expect(process.exitCode).toBe(1);
  });

  it("fails when the socket is moved away and back to the same inode", async () => {
    fs.writeFileSync(socketPath, "");
    const teardown = start();
    fs.renameSync(socketPath, `${socketPath}.bak`);
    fs.renameSync(`${socketPath}.bak`, socketPath);
    await expect(teardown()).rejects.toThrow("created, removed, or renamed during the run");
    expect(process.exitCode).toBe(1);
  });

  it("ignores changes to other names in the socket directory", async () => {
    fs.writeFileSync(socketPath, "");
    const teardown = start();
    fs.writeFileSync(path.join(dir, "X1"), "");
    fs.rmSync(path.join(dir, "X1"));
    await expect(teardown()).resolves.toBeUndefined();
  });

  it("falls back to snapshots when the directory cannot be watched", async () => {
    socketPath = path.join(dir, "missing", "X64999");
    expect(watchSocket(socketPath)).toBeUndefined();
    await expect(start()()).resolves.toBeUndefined();
  });

  it("warns and stays inactive when setup cannot read the socket", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    expect(startGuard(":64999", socketPath)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("Host display guard inactive");
    expect(String(warn.mock.calls[0][0])).toContain("permission denied");
  });

  it("fails the run when teardown cannot read the socket", async () => {
    fs.writeFileSync(socketPath, "");
    const teardown = start();
    vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    await expect(teardown()).rejects.toThrow(
      `could not read ${socketPath} at teardown: permission denied`,
    );
    expect(process.exitCode).toBe(1);
  });
});
