import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeXServer, installProcessIdentityFixture, installTargetFixture, withFifoRecord } from "./x11-fixture.js";

vi.mock("@pickforge/lab-core", async (original) => {
  const actual = await original<typeof import("@pickforge/lab-core")>();
  return { ...actual, runCommand: vi.fn() };
});
import { CommandError, createSession, runCommand, updateSession, type EnvLike } from "@pickforge/lab-core";
import { click, doubleClick, drag, move, pressKey, scroll } from "../src/input.js";
import { DesktopInputTargetError, verifyOwnedDisplayTarget } from "../src/x11-target.js";
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

it.each(["click", "drag"] as const)("%s uses the session display despite inherited endpoints", async (action) => {
  for (const [name, value] of Object.entries({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-host", XAUTHORITY: "/tmp/host-auth" })) vi.stubEnv(name, value);
  env = { ...env, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-caller", XAUTHORITY: "/tmp/caller-auth" };
  const options = { sessionId, display: desktop.display, env };
  if (action === "click") await click({ ...options, x: 10, y: 20 });
  else await drag({ ...options, fromX: 10, fromY: 20, toX: 30, toY: 40 });
  expect(runCommand).toHaveBeenCalledTimes(1);
  const [command, args, commandOptions] = vi.mocked(runCommand).mock.calls[0]!;
  expect(command).toBe("xdotool");
  expect(args.slice(0, 3)).toEqual(["mousemove", "10", "20"]);
  expect(commandOptions?.env).toEqual({ DISPLAY: desktop.display });
});

const inputs = {
  click: () => click({ sessionId, display: desktop.display, env, x: 10, y: 20 }),
  doubleClick: () => doubleClick({ sessionId, display: desktop.display, env, x: 10, y: 20 }),
  drag: () => drag({ sessionId, display: desktop.display, env, fromX: 10, fromY: 20, toX: 30, toY: 40 }),
  move: () => move({ sessionId, display: desktop.display, env, x: 10, y: 20 }),
  scroll: () => scroll({ sessionId, display: desktop.display, env, deltaX: 0, deltaY: 2 }),
  pressKey: () => pressKey({ sessionId, display: desktop.display, env, key: "Return" }),
};
const unowned: Record<string, () => void> = {
  "another lock owner": () => writeProc(1, "778\n"),
  "a dead server": () => fs.writeFileSync(processStat, ""),
  "a zombie server": () => fs.writeFileSync(processStat, fs.readFileSync(processStat, "utf8").replace(") S ", ") Z ")),
  "a recycled pid": () => fs.writeFileSync(processStat, fs.readFileSync(processStat, "utf8").replace("123\n", "124\n")),
  "a new server on the display number": () => {
    writeProc(1, "778\n");
    writeProc(2, "Num RefCount Protocol Flags Type St Inode Path\n0: 2 0 10000 0001 01 54321 /tmp/.X11-unix/X190\n");
  },
};

it("refuses a FIFO session record within the ownership deadline", async () => {
  const record = path.join(root, "pf", "sessions", `${sessionId}.json`);
  const { result, elapsed } = await withFifoRecord(record, verify);
  expect(result).toBeUndefined();
  expect(elapsed).toBeLessThan(X11_SETUP_MS / 3);
});

it.each(["click", "pressKey"] as const)("%s refuses a FIFO session record without sending input", async (name) => {
  const record = path.join(root, "pf", "sessions", `${sessionId}.json`);
  const { result, elapsed } = await withFifoRecord(record, () => inputs[name]().then(() => "sent", (error: Error) => error.message));
  expect(result).toMatch(/is not a regular file$/);
  expect(elapsed).toBeLessThan(X11_SETUP_MS / 3);
  expect(runCommand).not.toHaveBeenCalled();
});

it.each(Object.keys(inputs))("%s dispatches only to the verified owned Xvfb", async (name) => {
  await inputs[name as keyof typeof inputs]();
  expect(runCommand).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runCommand).mock.calls[0]![0]).toBe("xdotool");
  for (const [scenario, apply] of Object.entries(unowned)) {
    vi.mocked(runCommand).mockClear();
    const stat = fs.readFileSync(processStat, "utf8");
    const files = [1, 2].map((index) => fs.readFileSync(path.join(root, `proc-${index}`), "utf8"));
    apply();
    await expect(inputs[name as keyof typeof inputs](), scenario).rejects.toBeInstanceOf(DesktopInputTargetError);
    expect(runCommand, scenario).not.toHaveBeenCalled();
    fs.writeFileSync(processStat, stat);
    files.forEach((content, index) => writeProc(index + 1, content));
  }
});

it.each([
  [{ code: 2, signal: null, timedOut: false }, "Desktop key dispatch failed (exited with code 2)"],
  [{ code: null, signal: "SIGTERM" as const, timedOut: true }, "Desktop key dispatch failed (killed with signal SIGTERM, timed out)"],
])("a failed key dispatch never echoes the key: %o", async (exit, message) => {
  const key = "pf409-private-key-marker";
  const result = { ok: false, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, ...exit };
  vi.mocked(runCommand).mockImplementation(async (cmd, args) => { throw new CommandError(cmd, args ?? [], result); });
  const error = await pressKey({ sessionId, display: desktop.display, env, key }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(message);
  expect(vi.mocked(runCommand).mock.calls[0]![1]).toContain(key);
});

it("any other key dispatch error never echoes the key", async () => {
  const key = "pf409-private-key-marker";
  vi.mocked(runCommand).mockRejectedValue(new TypeError(`spawn failed for xdotool key -- ${key}`));
  await expect(pressKey({ sessionId, display: desktop.display, env, key })).rejects.toThrow(/^Desktop key dispatch failed$/);
});

it("refuses a key with a NUL character before any dispatch", async () => {
  const key = "pf409-private-key-marker\0Tab";
  const error = await pressKey({ sessionId, display: desktop.display, env, key }).catch((caught: unknown) => caught);
  expect((error as Error).message).toBe("Invalid key: expected a non-empty string without NUL characters");
  expect(runCommand).not.toHaveBeenCalled();
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
