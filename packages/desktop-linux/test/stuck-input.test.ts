import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, isPidAlive, readHumanLease, readProcessStartTicks, readActions, resolveRunStorage, updateSession, runCommand, sessionDataDir, stopPid, type EnvLike } from "@pickforge/lab-core";
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

/** XI2 exposes buttons above 5, which core QueryPointer cannot report. */
async function pointerButtons(display: string): Promise<Buffer> {
  const wire = new X11Wire(`/tmp/.X11-unix/X${display.slice(1)}`, performance.now() + 3_000, () => true);
  try {
    await wire.hello();
    const name = Buffer.from("XInputExtension");
    const query = request(98, 8 + ((name.length + 3) & ~3));
    query.writeUInt16LE(name.length, 4);
    name.copy(query, 8);
    const extension = await wire.reply(query);
    expect(extension[8]).toBe(1);
    const opcode = extension[9]!;
    const version = request(opcode, 8, 47);
    version.writeUInt16LE(2, 4);
    await wire.reply(version);
    const device = request(opcode, 8, 48);
    device.writeUInt16LE(2, 4); // Xvfb virtual core pointer.
    const reply = await wire.reply(device);
    const classes = reply.readUInt16LE(38);
    let offset = 44 + ((reply.readUInt16LE(40) + 3) & ~3);
    for (let index = 0; index < classes; index++) {
      if (reply.readUInt16LE(offset) === 1) {
        const count = reply.readUInt16LE(offset + 6);
        return Buffer.from(reply.subarray(offset + 8, offset + 8 + Math.ceil((count + 1) / 8)));
      }
      offset += reply.readUInt16LE(offset + 2) * 4;
    }
    throw new Error("No pointer button state");
  } finally { wire.close(); }
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
    await runCommand("xdotool", ["keydown", "shift", "mousedown", "1", "mousedown", "8", "mousedown", "9"], {
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
    expect((await pointerButtons(xvfb.display))[1]! & 3).toBe(3);
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
      .toEqual(Array.from({ length: 9 }, (_, index) => ["mouseup", String(index + 1)]));
    for (const entry of releases) expect(entry).toMatchObject({ display: xvfb.display, auth: "/dev/null" });
    expect(await keymap(xvfb.display)).toEqual(Buffer.alloc(32));
    expect((await pointerButtons(xvfb.display)).every((byte) => byte === 0)).toBe(true);
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

  it.each(["dead-host", "non-group-leader"])("stops the recorded viewer with a %s", async (scenario) => {
    const id = await sessionId();
    await startHumanTakeover(id, { transport: "viewer", registryEnv: env, env });
    owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const viewer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    childPid = viewer.pid!;
    await expect.poll(() => readProcessStartTicks(childPid!)).toBeDefined();
    const ownerPid = owner.pid!;
    const ownerStartTicks = readProcessStartTicks(ownerPid)!;
    if (scenario === "dead-host") await stopPid(ownerPid);
    const stale = { ...await readHumanLease(id, env), ownerPid, ownerStartTicks,
      viewerPid: childPid, viewerStartTicks: readProcessStartTicks(childPid), expiresAt: new Date(0).toISOString() };
    fs.writeFileSync(path.join(sessionDataDir(id, env), "human.lease.json"), JSON.stringify(stale));
    await heldShift();
    expect(await recoverStaleHumanLease(id, env)).toEqual({ recovered: true });
    expect(isPidAlive(childPid)).toBe(false);
    expect(await readHumanLease(id, env)).toBeUndefined();
    expect(await keymap(xvfb.display)).toEqual(Buffer.alloc(32));
  });

  it("skips input release when the recorded Xvfb identity changed", async () => {
    const id = await sessionId();
    await startHumanTakeover(id, { transport: "viewer", registryEnv: env, env });
    const stale = { ...await readHumanLease(id, env), ownerPid: 999_999, ownerStartTicks: undefined, expiresAt: new Date(0).toISOString() };
    fs.writeFileSync(path.join(sessionDataDir(id, env), "human.lease.json"), JSON.stringify(stale));
    await updateSession(id, { desktop: { display: xvfb.display, xvfbPid: xvfb.pid, xvfbStartTimeTicks: xvfb.startTimeTicks! + 1 } }, env);
    await heldShift();
    expect(await recoverStaleHumanLease(id, env)).toEqual({ recovered: true });
    expect(await readHumanLease(id, env)).toBeUndefined();
    expect((await keymap(xvfb.display)).some((byte) => byte !== 0)).toBe(true);
    await releaseStuckInput(xvfb.display, env);
  });

  it("records release failure but clears the lease after stopping its verified owner", async () => {
    const id = await sessionId();
    await startHumanTakeover(id, { transport: "viewer", registryEnv: env, env });
    owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await expect.poll(() => readProcessStartTicks(owner!.pid!)).toBeDefined();
    const stale = { ...await readHumanLease(id, env), ownerPid: owner.pid!, ownerStartTicks: readProcessStartTicks(owner.pid!), expiresAt: new Date(0).toISOString() };
    fs.writeFileSync(path.join(sessionDataDir(id, env), "human.lease.json"), JSON.stringify(stale));
    await heldShift();
    expect(await recoverStaleHumanLease(id, { ...env, PATH: path.join(root, "missing") })).toEqual({ recovered: true });
    expect(isPidAlive(owner.pid!)).toBe(false);
    expect(await readHumanLease(id, env)).toBeUndefined();
    const { runsDir } = await resolveRunStorage(root, env);
    const actions = (await Promise.all(fs.readdirSync(runsDir).filter((name) => !name.startsWith(".")).map((name) => readActions(path.join(runsDir, name))))).flat();
    expect(actions).toContainEqual(expect.objectContaining({ tool: "takeover_recovered", status: "error" }));
    await releaseStuckInput(xvfb.display, env);
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
