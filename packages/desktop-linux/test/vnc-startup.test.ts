import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isPidAlive, type EnvLike } from "@pickforge/lab-core";
import { stopXvfb } from "../src/display.js";
import { startVnc, VncStartError } from "../src/vnc.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-vnc-startup-"));
const binDir = path.join(root, "bin");
const childPidFile = path.join(root, "x11vnc-child.pid");
fs.mkdirSync(binDir, { recursive: true });

// An x11vnc that forks a child of its own and then never listens: startup
// times out with a live process group behind it. Cleanup that signalled only
// the recorded pid would leave the child running while reporting success.
fs.writeFileSync(
  path.join(binDir, "x11vnc"),
  [
    `#!${process.execPath}`,
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
    '  stdio: "ignore",',
    "});",
    `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"),
  { mode: 0o755 },
);

const env: EnvLike = { PATH: binDir };
const strays: number[] = [];

afterAll(() => {
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("x11vnc startup failure ownership", () => {
  it(
    "stops the whole spawned group and reports it through a typed partial handle",
    async () => {
      const error: unknown = await startVnc({
        display: ":247",
        port: 56_811,
        logDir: path.join(root, "logs"),
        env,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(VncStartError);
      const failure = error as VncStartError;
      expect(failure.reason).toBe("timeout");
      const partial = failure.partial;
      expect(partial).toBeDefined();
      strays.push(partial?.pid as number);
      expect(partial?.port).toBe(56_811);
      expect(partial?.cleanupConfirmed).toBe(true);
      expect(isPidAlive(partial?.pid as number)).toBe(false);

      const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
      expect(childPid).toBeGreaterThan(0);
      strays.push(childPid);
      expect(isPidAlive(childPid)).toBe(false);
    },
    30_000,
  );
});

describe("stopXvfb identity safety", () => {
  it("refuses a live pid when no recorded start identity is given", async () => {
    // A pid the caller cannot prove anything about: without the recorded start
    // ticks, verifying a snapshot taken *now* would just confirm whatever
    // process inherited the number.
    const child = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid as number;
    strays.push(pid);
    expect(isPidAlive(pid)).toBe(true);

    expect(await stopXvfb(pid)).toBe(false);
    expect(isPidAlive(pid)).toBe(true);

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    // Nothing left to confuse it with: a pid that is already gone is success.
    expect(await stopXvfb(pid)).toBe(true);
  }, 20_000);
});
