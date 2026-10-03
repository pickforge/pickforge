import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeXServer, installProcessIdentityFixture, installTargetFixture } from "./x11-fixture.js";

vi.mock("@pickforge/lab-core", async (original) => {
  const actual = await original<typeof import("@pickforge/lab-core")>();
  return { ...actual, runCommand: vi.fn() };
});
import { createSession, runCommand, updateSession, type EnvLike } from "@pickforge/lab-core";
import { click, drag } from "../src/input.js";
import { verifyOwnedDisplayTarget } from "../src/x11-target.js";
import { X11_SETUP_MS } from "../src/x11-wire.js";

let root: string;
let server: FakeXServer;
let env: EnvLike;
let sessionId: string;
let processStat: string;
const identity = { display: ":190", pid: 777, startTicks: 123 };
const desktop = { display: identity.display, xvfbPid: identity.pid, xvfbStartTimeTicks: identity.startTicks };
const verify = () => verifyOwnedDisplayTarget(sessionId, identity.display, env);

beforeEach(async () => {
  root = fs.mkdtempSync("/tmp/pointer-target-");
  server = new FakeXServer(path.join(root, "s"));
  await server.start();
  installTargetFixture(root, server);
  processStat = installProcessIdentityFixture(root, identity.pid, identity.startTicks);
  env = { PICKFORGE_HOME: path.join(root, "pf") };
  sessionId = (await createSession({ type: "desktop", projectDir: root, status: "running", desktop }, env)).id;
  vi.mocked(runCommand).mockReset().mockResolvedValue({ ok: true, code: 0, signal: null, stdout: "", stderr: "", timedOut: false, stdoutTruncated: false, stderrTruncated: false });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeProc(index: number, content: string): void {
  fs.writeFileSync(path.join(root, `proc-${index}`), content);
}

it("resolves the matched Xvfb process and unique listening socket identity", async () => {
  await expect(verify()).resolves.toEqual(identity);
  expect(vi.mocked(fs.readFileSync).mock.calls.filter(([file]) => file === "/proc/777/stat")).toHaveLength(2);
  expect(server.connections).toBe(0);
  expect(runCommand).not.toHaveBeenCalled();
});

it("rejects a lock pid that differs from the session owner", async () => {
  writeProc(1, "778\n");
  await expect(verify()).resolves.toBeUndefined();
});

it("rejects a listening socket inode owned by another pid", async () => {
  const readlink = vi.mocked(fs.readlinkSync).getMockImplementation()!;
  vi.mocked(fs.readlinkSync).mockImplementation(((...args: Parameters<typeof fs.readlinkSync>) =>
    String(args[0]) === "/proc/777/fd/3" ? "socket:[54321]" : Reflect.apply(readlink, fs, args)) as typeof fs.readlinkSync);
  await expect(verify()).resolves.toBeUndefined();
});

it("rejects duplicate listening sockets for the same display", async () => {
  const file = path.join(root, "proc-2");
  fs.appendFileSync(file, fs.readFileSync(file, "utf8").split("\n")[1]!.replace("12345", "54321") + "\n");
  await expect(verify()).resolves.toBeUndefined();
});

it.each([
  ["argv display mismatch", ["/usr/bin/Xvfb", ":191", "-nolisten", "tcp"]],
  ["authentication enabled", ["/usr/bin/Xvfb", ":190", "-nolisten", "tcp", "-auth", "/tmp/foreign-auth"]],
  ["wrong executable", ["/usr/bin/Xorg", ":190", "-nolisten", "tcp"]],
  ["TCP listener enabled", ["/usr/bin/Xvfb", ":190"]],
  ["wrong disabled transport", ["/usr/bin/Xvfb", ":190", "-nolisten", "unix"]],
])("rejects an unowned server command: %s", async (_name, argv) => {
  writeProc(0, [...argv, ""].join("\0"));
  await expect(verify()).resolves.toBeUndefined();
});

it.each(["socket", "process"] as const)("rejects a foreign %s UID", async (kind) => {
  if (kind === "socket") {
    const lstat = vi.mocked(fs.lstatSync).getMockImplementation()!;
    vi.mocked(fs.lstatSync).mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      const value = Reflect.apply(lstat, fs, args) as fs.Stats;
      return String(args[0]) === "/tmp/.X11-unix/X190" ? Object.assign(value, { uid: value.uid + 1 }) : value;
    }) as typeof fs.lstatSync);
  } else {
    const stat = vi.mocked(fs.statSync).getMockImplementation()!;
    vi.mocked(fs.statSync).mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      const value = Reflect.apply(stat, fs, args) as fs.Stats;
      return String(args[0]) === "/proc/777" ? Object.assign(value, { uid: value.uid + 1 }) : value;
    }) as typeof fs.statSync);
  }
  await expect(verify()).resolves.toBeUndefined();
});

it("rejects a requested display that differs from the session display", async () => {
  await expect(verifyOwnedDisplayTarget(sessionId, ":191", env)).resolves.toBeUndefined();
  expect(fs.lstatSync).not.toHaveBeenCalled();
});

it.each(["", ":0.0", ":0190", "localhost:190", ":1000000"])("rejects invalid display syntax: %s", async (display) => {
  await expect(verifyOwnedDisplayTarget(sessionId, display, env)).resolves.toBeUndefined();
  expect(fs.lstatSync).not.toHaveBeenCalled();
});

it("rejects a missing session", async () => {
  await expect(verifyOwnedDisplayTarget("desk-missing", ":190", env)).resolves.toBeUndefined();
});

it.each(["starting", "stopped", "error"] as const)("rejects a session that is %s", async (status) => {
  await updateSession(sessionId, { status }, env);
  await expect(verify()).resolves.toBeUndefined();
});

it("rejects a session without a desktop leg", async () => {
  const session = await createSession({ type: "android", projectDir: root, status: "running" }, env);
  await expect(verifyOwnedDisplayTarget(session.id, ":190", env)).resolves.toBeUndefined();
});

it.each([
  ["missing pid", { ...desktop, xvfbPid: undefined }],
  ["invalid pid", { ...desktop, xvfbPid: 0 }],
  ["fractional pid", { ...desktop, xvfbPid: 777.5 }],
  ["missing start ticks", { ...desktop, xvfbStartTimeTicks: undefined }],
  ["negative start ticks", { ...desktop, xvfbStartTimeTicks: -1 }],
  ["fractional start ticks", { ...desktop, xvfbStartTimeTicks: 123.5 }],
])("rejects an invalid recorded identity: %s", async (_name, value) => {
  await updateSession(sessionId, { desktop: value }, env);
  await expect(verify()).resolves.toBeUndefined();
});

it.each(["gone", "zombie"])("rejects a dead server: %s", async (kind) => {
  const stat = fs.readFileSync(processStat, "utf8");
  fs.writeFileSync(processStat, kind === "zombie" ? stat.replace(") S ", ") Z ") : "");
  await expect(verify()).resolves.toBeUndefined();
});

it("rejects a server that dies during socket ownership checks", async () => {
  const readlink = vi.mocked(fs.readlinkSync).getMockImplementation()!;
  vi.mocked(fs.readlinkSync).mockImplementation(((...args: Parameters<typeof fs.readlinkSync>) => {
    const result = Reflect.apply(readlink, fs, args);
    if (String(args[0]) === "/proc/777/fd/3") fs.writeFileSync(processStat, "");
    return result;
  }) as typeof fs.readlinkSync);
  await expect(verify()).resolves.toBeUndefined();
  expect(fs.readlinkSync).toHaveBeenCalledWith("/proc/777/fd/3");
});

it("rejects a recycled pid with different start ticks", async () => {
  fs.writeFileSync(processStat, fs.readFileSync(processStat, "utf8").replace("123\n", "124\n"));
  await expect(verify()).resolves.toBeUndefined();
});

it("rejects a new server with a different pid on the same display number", async () => {
  writeProc(1, "778\n");
  writeProc(2, "Num RefCount Protocol Flags Type St Inode Path\n0: 2 0 10000 0001 01 54321 /tmp/.X11-unix/X190\n");
  await expect(verify()).resolves.toBeUndefined();
});

it.each([true, false])("ignores inherited host endpoints for matched ownership: %s", async (matched) => {
  const host = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-host", XAUTHORITY: "/tmp/host-auth" };
  for (const [name, value] of Object.entries(host)) vi.stubEnv(name, value);
  env = { ...env, ...host, HOME: "/tmp/foreign-home" };
  if (!matched) writeProc(1, "778\n");
  await expect(verify()).resolves.toEqual(matched ? identity : undefined);
});

it("never reads caller host endpoints or home configuration", async () => {
  for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "HOME"]) {
    Object.defineProperty(env, name, { get: () => { throw new Error(`Unexpected ${name} read`); } });
  }
  await expect(verify()).resolves.toEqual(identity);
});

it.each([
  ["click", true], ["drag", true], ["click", false], ["drag", false],
] as const)("%s uses the session display despite inherited endpoints and evidence ownership %s", async (action, matched) => {
  for (const [name, value] of Object.entries({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-host", XAUTHORITY: "/tmp/host-auth" })) vi.stubEnv(name, value);
  env = { ...env, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-caller", XAUTHORITY: "/tmp/caller-auth" };
  if (!matched) writeProc(1, "778\n");
  await expect(verify()).resolves.toEqual(matched ? identity : undefined);
  const options = { sessionId, display: desktop.display, env };
  if (action === "click") await click({ ...options, x: 10, y: 20 });
  else await drag({ ...options, fromX: 10, fromY: 20, toX: 30, toY: 40 });
  expect(runCommand).toHaveBeenCalledTimes(1);
  const [command, args, commandOptions] = vi.mocked(runCommand).mock.calls[0]!;
  expect(command).toBe("xdotool");
  expect(args.slice(0, 3)).toEqual(["mousemove", "10", "20"]);
  expect(commandOptions?.env).toEqual({ DISPLAY: desktop.display });
});

it("resolves undefined when a procfs read throws", async () => {
  vi.spyOn(fs, "readSync").mockImplementation(() => { throw new Error("private procfs failure"); });
  await expect(verify()).resolves.toBeUndefined();
});

it("stops ownership checks when the X11 setup budget expires", async () => {
  let now = performance.now();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const readlink = vi.mocked(fs.readlinkSync).getMockImplementation()!;
  vi.mocked(fs.readlinkSync).mockImplementation(((...args: Parameters<typeof fs.readlinkSync>) => {
    now += X11_SETUP_MS + 1;
    return Reflect.apply(readlink, fs, args);
  }) as typeof fs.readlinkSync);
  await expect(verify()).resolves.toBeUndefined();
});
