import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, isPidAlive, readHumanLease, readProcessStartTicks, runCommand, sessionDataDir, stopPid, type EnvLike } from "@pickforge/lab-core";
import { startXvfb, stopXvfb, type XvfbHandle } from "../src/display.js";
import { releaseStuckInput } from "../src/stuck-input.js";
import { endHumanTakeover, recoverStaleHumanLease, startHumanTakeover } from "../src/takeover.js";
import { findOnPath } from "../src/util.js";
import { request, X11Wire } from "../src/x11-wire.js";
import { unusedTestDisplay } from "./test-resources.js";

const available = ["Xvfb", "xdotool"].every((bin) => findOnPath(bin) !== null);
if (!available && process.env.PICKFORGE_REQUIRE_XVFB === "1") throw new Error("Xvfb and xdotool required");

async function keymap(display: string): Promise<Buffer> {
  const wire = new X11Wire(`/tmp/.X11-unix/X${display.slice(1)}`, performance.now() + 3_000, () => true);
  try {
    await wire.hello();
    return Buffer.from((await wire.reply(request(44))).subarray(8));
  } finally {
    wire.close();
  }
}

describe.skipIf(!available)("viewer stuck-input backstop on explicit Xvfb", () => {
  let root: string;
  let env: EnvLike;
  let xvfb: XvfbHandle;
  let owner: ChildProcess | undefined;
  let childPid: number | undefined;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-stuck-input-"));
    env = { ...process.env, PICKFORGE_HOME: path.join(root, "home") };
    xvfb = await startXvfb({ display: unusedTestDisplay(), logDir: root, width: 320, height: 240, env });
  });

  afterEach(async () => {
    if (owner?.pid !== undefined) await stopPid(owner.pid);
    if (childPid !== undefined) await stopPid(childPid);
    owner = undefined;
    childPid = undefined;
    await stopXvfb(xvfb.pid, xvfb.startTimeTicks);
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function heldShift(): Promise<void> {
    await runCommand("xdotool", ["keydown", "shift", "mousedown", "1"], {
      env: { ...env, DISPLAY: xvfb.display, XAUTHORITY: "/dev/null" }, check: true,
    });
    expect((await keymap(xvfb.display)).some((byte) => byte !== 0)).toBe(true);
  }

  async function sessionId(): Promise<string> {
    return (await createSession({ type: "desktop", status: "running", projectDir: root,
      desktop: { display: xvfb.display, homePolicy: "private", xvfbPid: xvfb.pid, xvfbStartTimeTicks: xvfb.startTimeTicks },
    }, env)).id;
  }

  it("releases Shift and all buttons using the session DISPLAY, even with a different caller display", async () => {
    await heldShift();
    const bin = path.join(root, "bin");
    const log = path.join(root, "releases.jsonl");
    fs.mkdirSync(bin);
    const realXdotool = findOnPath("xdotool")!;
    fs.writeFileSync(path.join(bin, "xdotool"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_LOG, JSON.stringify({ args, display: process.env.DISPLAY, auth: process.env.XAUTHORITY }) + '\\n');
const result = require('node:child_process').spawnSync(process.env.REAL_XDOTOOL, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    await releaseStuckInput(xvfb.display, { ...env, DISPLAY: ":999999", PATH: bin, REAL_XDOTOOL: realXdotool, RELEASE_LOG: log });
    const releases = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(releases.filter((entry) => entry.args[0] === "keyup").length).toBeGreaterThan(0);
    expect(releases.filter((entry) => entry.args[0] === "mouseup").map((entry) => entry.args))
      .toEqual(Array.from({ length: 7 }, (_, index) => ["mouseup", String(index + 1)]));
    for (const entry of releases) expect(entry).toMatchObject({ display: xvfb.display, auth: "/dev/null" });
    expect(await keymap(xvfb.display)).toEqual(Buffer.alloc(32));
  });

  it("releases input before returning a viewer lease", async () => {
    const id = await sessionId();
    const handle = await startHumanTakeover(id, { transport: "viewer", registryEnv: env, env });
    await heldShift();
    await endHumanTakeover(handle, { registryEnv: env, env, reason: "return" });
    expect(await keymap(xvfb.display)).toEqual(Buffer.alloc(32));
    expect(await readHumanLease(id, env)).toBeUndefined();
  });

  it.each(["missing", "reused"])("keeps a stale lease and held input when the owner identity is %s", async (identity) => {
    const id = await sessionId();
    await startHumanTakeover(id, { transport: "viewer", registryEnv: env, env });
    owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const ownerPid = owner.pid!;
    await expect.poll(() => readProcessStartTicks(ownerPid)).toBeDefined();
    const stale = { ...await readHumanLease(id, env), ownerPid,
      ownerStartTicks: identity === "missing" ? undefined : readProcessStartTicks(ownerPid)! + 1, expiresAt: new Date(0).toISOString() };
    fs.writeFileSync(path.join(sessionDataDir(id, env), "human.lease.json"), JSON.stringify(stale));
    await heldShift();
    await expect(recoverStaleHumanLease(id, env)).rejects.toThrow(/process identity|owner process group reused/);
    expect(isPidAlive(ownerPid)).toBe(true);
    expect(await readHumanLease(id, env)).toEqual(JSON.parse(JSON.stringify(stale)));
    expect((await keymap(xvfb.display)).some((byte) => byte !== 0)).toBe(true);
  });

  it("stops a stale verified owner group, including its child, before releasing input", async () => {
    const id = await sessionId();
    const handle = await startHumanTakeover(id, { transport: "viewer", registryEnv: env, env });
    const childFile = path.join(root, "child.pid");
    owner = spawn(process.execPath, ["-e", `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(process.argv[1], String(child.pid));
      setInterval(() => {}, 1000);
    `, childFile], { detached: true, stdio: "ignore" });
    await expect.poll(() => fs.existsSync(childFile)).toBe(true);
    childPid = Number(fs.readFileSync(childFile, "utf8"));
    const ownerPid = owner.pid!;
    const ownerStartTicks = readProcessStartTicks(ownerPid)!;
    const stale = { ...await readHumanLease(id, env), ownerPid, ownerStartTicks,
      viewerPid: childPid, viewerStartTicks: readProcessStartTicks(childPid), expiresAt: new Date(0).toISOString() };
    fs.writeFileSync(path.join(sessionDataDir(id, env), "human.lease.json"), JSON.stringify(stale));
    await heldShift();
    expect(await recoverStaleHumanLease(id, env)).toEqual({ recovered: true });
    expect(isPidAlive(ownerPid)).toBe(false);
    expect(isPidAlive(childPid)).toBe(false);
    expect(await keymap(xvfb.display)).toEqual(Buffer.alloc(32));
    expect(await readHumanLease(id, env)).toBeUndefined();
    expect(handle.transport).toBe("viewer");
  });
});
