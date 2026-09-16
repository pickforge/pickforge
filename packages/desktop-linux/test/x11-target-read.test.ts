import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeXServer, installTargetFixture } from "./x11-fixture.js";

vi.mock("@pickforge/lab-core", async (original) => {
  const actual = await original<typeof import("@pickforge/lab-core")>();
  return { ...actual, runCommand: vi.fn(), processIdentityMatches: vi.fn(() => true) };
});
import { createSession, runCommand, type EnvLike } from "@pickforge/lab-core";
import { typeText } from "../src/input.js";
import { validateTypingTarget } from "../src/x11-target.js";

let root: string;
let server: FakeXServer;
let env: EnvLike;
let sessionId: string;
const header = "Num RefCount Protocol Flags Type St Inode Path\n";
const owned = "0: 2 0 10000 0001 01 12345 /tmp/.X11-unix/X190\n";
const duplicate = "0: 2 0 10000 0001 01 54321 /tmp/.X11-unix/X190\n";
const connected = "0000000008bef73a: 00000003 00000000 00000000 0001 03 67890 /tmp/.X11-unix/X190\n";

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xr-"));
  server = new FakeXServer(path.join(root, "s"));
  await server.start();
  installTargetFixture(root, server);
  env = { PICKFORGE_HOME: path.join(root, "pf") };
  const session = await createSession({ type: "desktop", projectDir: root, status: "running", desktop: { display: ":190", xvfbPid: 777, xvfbStartTimeTicks: 123 } }, env);
  sessionId = session.id;
  vi.mocked(runCommand).mockReset();
  vi.mocked(runCommand).mockResolvedValue({ ok: true, code: 0, signal: null, stdout: "xdotool version 3.20160805.1", stderr: "", timedOut: false, stdoutTruncated: false, stderrTruncated: false });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

interface ChunkOptions { size: number; failAt?: number; onRead?: () => void }
function shortReads(options: ChunkOptions) {
  const state = { opens: 0, closes: 0, reads: 0, bytes: 0, eofs: 0, active: new Set<number>() };
  const open = vi.mocked(fs.openSync).getMockImplementation()!;
  const read = fs.readSync.bind(fs);
  const close = fs.closeSync.bind(fs);
  vi.mocked(fs.openSync).mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const fd = Reflect.apply(open, fs, args) as number;
    if (String(args[0]) === "/proc/net/unix") { state.opens++; state.active.add(fd); }
    return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
    const [fd, data, offset, length, position] = args as [number, Buffer, number, number, number | null];
    if (!state.active.has(fd)) return Reflect.apply(read, fs, args);
    state.reads++;
    options.onRead?.();
    if (state.reads === options.failAt) throw Object.assign(new Error("private read payload"), { code: "EACCES" });
    const n = read(fd, data, offset, Math.min(length, options.size), position);
    state.bytes += n;
    if (n === 0) state.eofs++;
    return n;
  }) as typeof fs.readSync);
  vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    if (state.active.delete(fd)) state.closes++;
    close(fd);
  });
  return state;
}

async function exercise(mode: "helper" | "typing"): Promise<void> {
  if (mode === "helper") {
    expect((await validateTypingTarget(sessionId, ":190", env)).path).toBe("/tmp/.X11-unix/X190");
  } else {
    await typeText({ sessionId, display: ":190", text: "a", env });
    expect(vi.mocked(runCommand).mock.calls.some(([, args]) => args[0] === "type")).toBe(true);
  }
}

it.each(["helper", "typing"] as const)("finds owned socket after short reads: %s", async (mode) => {
  fs.writeFileSync(path.join(root, "proc-2"), header + owned);
  const state = shortReads({ size: header.length });
  await exercise(mode);
  expect(state.reads).toBeGreaterThan(state.opens);
  expect(state.eofs).toBe(state.opens);
  expect(state.closes).toBe(state.opens);
  expect(state.active.size).toBe(0);
});

it.each(["helper", "typing"] as const)("accepts listener with connected endpoints: %s", async (mode) => {
  fs.writeFileSync(path.join(root, "proc-2"), header + connected + owned + connected.replace("67890", "67891"));
  const state = shortReads({ size: 3 });
  await exercise(mode);
  expect(state.eofs).toBe(state.opens);
  expect(state.closes).toBe(state.opens);
  expect(state.active.size).toBe(0);
});

it.each(["helper", "typing"] as const)("rejects duplicate listeners after short reads: %s", async (mode) => {
  fs.writeFileSync(path.join(root, "proc-2"), header + owned + duplicate);
  const state = shortReads({ size: header.length + owned.length });
  await expect(exercise(mode)).rejects.toThrow("preparation failed");
  expect(state.eofs).toBe(1);
  expect(state.closes).toBe(1);
  expect(state.active.size).toBe(0);
  expect(server.connections).toBe(0);
  expect(runCommand).not.toHaveBeenCalled();
});

it("rejects a later duplicate listener even when its inode repeats", async () => {
  fs.writeFileSync(path.join(root, "proc-2"), header + owned + owned);
  const state = shortReads({ size: header.length + owned.length });
  await expect(exercise("helper")).rejects.toThrow("preparation failed");
  expect(state.eofs).toBe(1);
  expect(state.closes).toBe(1);
});

it.each(["helper", "typing"] as const)("enforces aggregate limit after short reads: %s", async (mode) => {
  fs.writeFileSync(path.join(root, "proc-2"), header + owned + "x".repeat(1024 * 1024));
  const state = shortReads({ size: 4096 });
  await expect(exercise(mode)).rejects.toThrow("preparation failed");
  expect(state.bytes).toBe(1024 * 1024 + 1);
  expect(state.eofs).toBe(0);
  expect(state.closes).toBe(1);
  expect(state.active.size).toBe(0);
  expect(server.connections).toBe(0);
  expect(runCommand).not.toHaveBeenCalled();
});

it("accepts exactly the byte limit only after observing EOF", async () => {
  const prefix = header + owned;
  fs.writeFileSync(path.join(root, "proc-2"), prefix + " ".repeat(1024 * 1024 - Buffer.byteLength(prefix) - 1) + "\n");
  const state = shortReads({ size: 4096 });
  await exercise("helper");
  expect(state.bytes).toBe(1024 * 1024);
  expect(state.eofs).toBe(1);
  expect(state.closes).toBe(1);
});

it.each([
  ["connected only", connected.replace("67890", "12345")],
  ["foreign listener with owned connected endpoint", duplicate + connected.replace("67890", "12345")],
  ["missing listener", header],
  ["two listeners around connected endpoint", owned + connected + duplicate],
  ["malformed listener flags", owned.replace("10000", "private") + connected],
  ["unknown connected state", owned + connected.replace("0001 03", "0001 02")],
  ["wrong socket type", owned + connected.replace("0001 03", "0002 03")],
  ["wrong protocol", owned + connected.replace("00000003 00000000", "00000003 00000001")],
  ["malformed inode", owned + connected.replace("67890", "private")],
  ["missing field", owned + connected.replace("0001 03", "03")],
  ["truncated matching row", owned + connected.slice(0, -1)],
  ["truncated pathname", owned + connected.slice(0, -4)],
  ["uncertain flags", owned + connected.replace("00000000 0001", "00010000 0001")],
])("rejects uncertain listener proof: %s", async (_name, rows) => {
  fs.writeFileSync(path.join(root, "proc-2"), header + rows);
  const state = shortReads({ size: 7 });
  await expect(exercise("typing")).rejects.toThrow(/^Desktop text preparation failed; no text was sent$/);
  expect(state.closes).toBe(1);
  expect(state.active.size).toBe(0);
  expect(server.connections).toBe(0);
  expect(runCommand).not.toHaveBeenCalled();
});

it("terminates repeated one-byte chunks only at EOF", async () => {
  const text = header + owned;
  fs.writeFileSync(path.join(root, "proc-2"), text);
  const state = shortReads({ size: 1 });
  await exercise("helper");
  expect(state.reads).toBe(Buffer.byteLength(text) + 1);
  expect(state.eofs).toBe(1);
  expect(state.closes).toBe(1);
  expect(state.active.size).toBe(0);
});

it.each(["helper", "typing"] as const)("closes an unreadable stream without exposing its error: %s", async (mode) => {
  const state = shortReads({ size: 1, failAt: 2 });
  await expect(exercise(mode)).rejects.toThrow(/^Desktop text preparation failed; no text was sent$/);
  expect(state.reads).toBe(2);
  expect(state.closes).toBe(1);
  expect(state.active.size).toBe(0);
  expect(server.connections).toBe(0);
});

it.each(["symlink", "directory"])("rejects a nonregular procfs fixture: %s", async (kind) => {
  const file = path.join(root, "proc-2");
  fs.renameSync(file, file + "-saved");
  if (kind === "symlink") fs.symlinkSync(file + "-saved", file);
  else fs.mkdirSync(file);
  const state = shortReads({ size: 1 });
  await expect(exercise("helper")).rejects.toThrow("preparation failed");
  expect(state.reads).toBe(0);
  expect(state.opens).toBe(kind === "symlink" ? 0 : 1);
  expect(state.closes).toBe(state.opens);
  expect(state.active.size).toBe(0);
});

it("closes a short-read stream when its absolute helper deadline expires", async () => {
  const start = performance.now();
  let now = start;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const state = shortReads({ size: 1, onRead: () => { now += 35; } });
  await expect(validateTypingTarget(sessionId, ":190", env, start + 100)).rejects.toThrow("preparation failed");
  expect(state.reads).toBe(3);
  expect(state.eofs).toBe(0);
  expect(state.closes).toBe(1);
  expect(state.active.size).toBe(0);
});

it("uses the original typing deadline across repeated ownership reads", async () => {
  const start = performance.now();
  let now = start;
  let afterVersion = false;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const state = shortReads({ size: 1, onRead: () => { if (afterVersion) now += 400; } });
  const normal = vi.mocked(runCommand).getMockImplementation()!;
  vi.mocked(runCommand).mockImplementation(async (command, args, options) => {
    const result = await normal(command, args, options);
    now += 59000;
    afterVersion = true;
    return result;
  });
  const bytes = fs.readFileSync(path.join(root, "proc-2")).length;
  await expect(typeText({ sessionId, display: ":190", text: "a", env })).rejects.toThrow("preparation failed");
  expect(state.reads).toBe(bytes + 1 + 3);
  expect(state.eofs).toBe(1);
  expect(state.closes).toBe(2);
  expect(state.active.size).toBe(0);
  expect(server.connections).toBe(0);
  expect(vi.mocked(runCommand).mock.calls.map(([, args]) => args)).toEqual([["--version"]]);
});
