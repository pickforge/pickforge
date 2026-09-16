import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeXServer, installTargetFixture } from "./x11-fixture.js";

vi.mock("@pickforge/lab-core", async (original) => {
  const actual = await original<typeof import("@pickforge/lab-core")>();
  return { ...actual, runCommand: vi.fn(), processIdentityMatches: vi.fn(() => true) };
});
import { AGENT_PERMITS_DIR, acquireHumanLease, createSession, sessionDataDir, updateSession, runCommand, processIdentityMatches, type EnvLike } from "@pickforge/lab-core";
import { typeText } from "../src/input.js";
import { validateTypingTarget } from "../src/x11-target.js";
import { X11Wire } from "../src/x11-wire.js";

let root: string;
let server: FakeXServer;
let sessionId: string;
let env: EnvLike;
let version: string;
let events: { code: number; level: number }[];

function fixtureCodepoint(symbol: number): number {
  if (symbol >= 0x1000000) return symbol - 0x1000000;
  if (symbol === 0x7e1) return 0x3b1;
  if (symbol >= 0xff08 && symbol <= 0xff0d) return symbol & 0x7f;
  if (symbol === 0xff1b || symbol === 0xffff) return symbol & 0x7f;
  return symbol;
}

function delayedText(): string {
  return events.map(({ code, level }) => {
    const symbol = server.rows.get(code)?.[level];
    return symbol ? String.fromCodePoint(fixtureCodepoint(symbol)) : "";
  }).join("");
}

function dispatch(text: string): void {
  server.inputCalls++;
  const entries = [...server.rows].sort(([a], [b]) => a - b).flatMap(([code, row]) => row.map((symbol, level) => ({ code, level, symbol })));
  if (version.includes("4.20260303.1")) entries.pop();
  for (const char of text) {
    const entry = entries.find(({ symbol }) => fixtureCodepoint(symbol) === char.codePointAt(0));
    if (entry) events.push({ code: entry.code, level: entry.level });
    else {
      // The old unsafe fallback. Assertions consume these events after return.
      server.rows.set(8, [char.codePointAt(0)!]);
      events.push({ code: 8, level: 0 });
      server.rows.delete(8);
    }
  }
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));
  env = { PICKFORGE_HOME: path.join(root, "pf") };
  server = new FakeXServer(path.join(root, "s"));
  await server.start();
  installTargetFixture(root, server);
  vi.mocked(processIdentityMatches).mockReturnValue(true);
  const session = await createSession({ type: "desktop", projectDir: root }, env);
  sessionId = session.id;
  await updateSession(sessionId, { status: "running", desktop: { display: ":190", xvfbPid: 777, xvfbStartTimeTicks: 123, width: 1280, height: 800 } }, env);
  version = "xdotool version 3.20160805.1";
  events = [];
  vi.mocked(runCommand).mockReset();
  vi.mocked(runCommand).mockImplementation(async (_command, argv) => {
    if (argv[0] === "type") dispatch(argv.at(-1)!);
    else expect(argv).toEqual(["--version"]); // `version` would open X before preparation.
    return { ok: true, code: 0, signal: null, stdout: version, stderr: "", timedOut: false, stdoutTruncated: false, stderrTruncated: false };
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

async function type(text: string): Promise<void> {
  await typeText({ sessionId, display: ":190", text, env });
}

it.each(["áéáé", "Olá café 日本"])("preserves delayed text after return: %s", async (text) => {
  await type(text);
  expect(delayedText()).toBe(text);
  expect(server.changes).not.toContain(8);
});

it.each(["3.20160805.1", "4.20260303.1"])("keeps distinct bindings across later calls and consumption (%s)", async (family) => {
  version = `xdotool version ${family}`;
  server.fragments = true;
  await type("áéáé");
  const first = [...server.changes];
  await type("Olá café 日本");
  await type("áé");
  expect(delayedText()).toBe("áéáéOlá café 日本áé");
  expect(server.deliveredChunks).toContain(3);
  expect(new Set(server.changes).size).toBe(server.changes.length);
  expect(server.changes.filter((code) => first.includes(code))).toEqual(first);
});

it.each(["áé", "ASCII\t\n", "α"])("anchors a cold dispatch until completion: %s", async (text) => {
  server.resetOnLastClient = true;
  const normal = vi.mocked(runCommand).getMockImplementation()!;
  let closed: Promise<unknown> | undefined;
  vi.mocked(runCommand).mockImplementation(async (cmd, args, options) => {
    if (args[0] === "type") {
      expect([...server.wires].some((socket) => !socket.destroyed)).toBe(true);
      expect(server.grab).toBeUndefined();
      expect(options?.signal?.aborted).toBe(false);
      closed = once([...server.sockets][0]!, "close");
    }
    return normal(cmd, args, options);
  });
  await type(text);
  await closed;
  const count = server.changes.length;
  await type(text);
  await closed;
  if (text === "áé") expect(server.changes.length).toBe(count * 2);
  expect([...server.wires].every((socket) => socket.destroyed)).toBe(true);
});

it("keeps cross-call bindings while a consumer spans mapper replacement", async () => {
  server.resetOnLastClient = true;
  const consumer = new X11Wire("/tmp/.X11-unix/X190", performance.now() + 3000, () => true);
  try {
    await consumer.hello();
    await type("áéáé");
    const first = [...server.changes];
    await type("Olá café 日本");
    expect(delayedText()).toBe("áéáéOlá café 日本");
    expect(server.changes.filter((code) => first.includes(code))).toEqual(first);
  } finally { consumer.close(); }
});

it("serializes concurrent allocators through the server grab", async () => {
  await Promise.all([type("á"), type("é"), type("日")]);
  expect(new Set(server.changes).size).toBe(3);
  expect(new Set(delayedText())).toEqual(new Set("áé日"));
  expect(server.grab).toBeUndefined();
});

it("preserves occupied, modifier and reserved minimum codes", async () => {
  server.rows.set(8, []);
  server.modifiers.add(255);
  server.rows.set(254, [0x1234]);
  await type("áé");
  expect(server.changes).toEqual([253, 252]);
  expect(server.rows.get(254)).toEqual([0x1234]);
  expect(server.rows.get(8)).toEqual([]);
});

it("checks full capacity before mutation or dispatch", async () => {
  for (let code = 9; code <= 255; code++) server.rows.set(code, [0xffe1]);
  server.rows.delete(254);
  await expect(type("áé")).rejects.toThrow("capacity exhausted");
  expect(server.changes).toEqual([]);
  expect(server.inputCalls).toBe(0);
});

it.each(["3.20160805.1", "4.20260303.1"])("reuses natural case pairs across calls at actual one-slot capacity (%s)", async (family) => {
  version = `xdotool version ${family}`;
  for (let code = 9; code <= 255; code++) server.rows.set(code, [0xffe1]);
  server.rows.delete(254);
  await type("á");
  await type("Á");
  expect(server.changes).toEqual([254]);
  expect(delayedText()).toBe("áÁ");
});

it("does not allocate an unrequested uppercase partner for a borrowed lowercase legacy symbol", async () => {
  await type("α");
  expect(server.changes).toEqual([]);
  expect(delayedText()).toBe("α");
});

it("handles ASCII, tabs, newlines, legacy Greek, cases and non-BMP without normalization", async () => {
  await type("A\ta\nα😀áÁé");
  expect(delayedText()).toBe("A\ta\nα😀áÁé");
  expect(server.changes).toHaveLength(3); // Emoji, Latin case pair, combining accent.
});

it("rejects the newest client's excluded final entry if server reshaping leaves no lookup", async () => {
  version = "xdotool version 4.20260303.1";
  server.collapseGroups = true;
  await expect(type("日")).rejects.toThrow("preparation failed");
  expect(server.inputCalls).toBe(0);
  expect(server.changes).toEqual([255]);
  expect(server.rows.get(255)).toBeDefined(); // Do not recycle partial bindings.
});

it.each(["\0", "\ud800", "\udfff", "a".repeat(65537)])("rejects invalid or excessive text privately before connection %#", async (text) => {
  await expect(type(text)).rejects.toThrow("preparation failed");
  expect(server.connections).toBe(0);
  expect(server.inputCalls).toBe(0);
});

it("rechecks socket ownership after the version query", async () => {
  const normal = vi.mocked(runCommand).getMockImplementation()!;
  vi.mocked(runCommand).mockImplementation(async (command, args, options) => {
    const result = await normal(command, args, options);
    fs.writeFileSync(path.join(root, "proc-2"), "ownership changed");
    return result;
  });
  await expect(type("private")).rejects.toThrow("preparation failed");
  expect(server.connections).toBe(0);
});

it("rechecks the owned target before xdotool opens its dispatch connection", async () => {
  server.fault = (opcode, reply) => {
    if (opcode === 43) fs.writeFileSync(path.join(root, "proc-2"), "ownership changed");
    return reply;
  };
  await expect(type("á")).rejects.toThrow("preparation failed");
  expect(server.inputCalls).toBe(0);
  expect(server.changes).toHaveLength(1);
});

it("refuses unknown client semantics rather than assuming the latest bug", async () => {
  version = "xdotool version 9.0.0";
  await expect(type("secret")).rejects.toThrow("supported xdotool");
  expect(server.connections).toBe(0);
});

it("shares the 60s budget, literal argv, clean empty auth, and private dispatch errors", async () => {
  await type("áéáé");
  expect(server.grab).toBeUndefined();
  const calls = vi.mocked(runCommand).mock.calls;
  expect(calls[0]?.[1]).toEqual(["--version"]);
  expect(calls[0]?.[2]).toMatchObject({ cleanEnv: true, env: { DISPLAY: undefined, XAUTHORITY: "/dev/null" } });
  expect(calls.at(-1)?.[1]).toEqual(["type", "--delay", "50", "--", "áéáé"]);
  expect(calls.at(-1)?.[2]).toMatchObject({ cleanEnv: true, killGraceMs: 0, env: { DISPLAY: ":190", XAUTHORITY: "/dev/null" } });
  expect(calls.at(-1)?.[2]?.timeoutMs).toBeLessThan(60000);
});

it("holds the same permit through preparation and dispatch", async () => {
  const observed: string[][] = [];
  const directory = path.join(sessionDataDir(sessionId, env), AGENT_PERMITS_DIR);
  const observe = () => observed.push(fs.readdirSync(directory));
  const normal = vi.mocked(runCommand).getMockImplementation()!;
  vi.mocked(runCommand).mockImplementation(async (command, args, options) => {
    observe();
    return normal(command, args, options);
  });
  server.fault = (_opcode, reply) => { observe(); return reply; };
  await type("áé");
  expect(observed.length).toBeGreaterThan(6);
  for (const permits of observed) {
    expect(permits).toHaveLength(1);
    expect(permits).toEqual(observed[0]);
  }
  expect(fs.readdirSync(directory)).toEqual([]);
});

it("does not extend the total deadline with a separate setup budget", async () => {
  const now = performance.now();
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now + elapsed);
  const normal = vi.mocked(runCommand).getMockImplementation()!;
  vi.mocked(runCommand).mockImplementation(async (command, args, options) => {
    const result = await normal(command, args, options);
    elapsed = 60001;
    return result;
  });
  await expect(type("private")).rejects.toThrow("preparation failed");
  expect(server.connections).toBe(0);
  expect(server.inputCalls).toBe(0);
});

it("preserves currently supported control characters", async () => {
  const text = "\b\t\n\v\r\u001b\u007f";
  await type(text);
  expect(delayedText()).toBe(text);
});

it("refuses a human lease before version query, connection, or binding", async () => {
  await acquireHumanLease(sessionId, env);
  await expect(type("private")).rejects.toThrow(/human/i);
  expect(runCommand).not.toHaveBeenCalled();
  expect(server.connections).toBe(0);
  expect(server.changes).toEqual([]);
});

async function useDesktopCapability(type: "browser" | "desktop+android"): Promise<void> {
  const session = await createSession({
    type, projectDir: root, status: "running",
    desktop: { display: ":190", xvfbPid: 777, xvfbStartTimeTicks: 123, width: 1280, height: 800 },
    ...(type === "desktop+android"
      ? { android: { avdName: "synthetic-avd" } }
      : { browser: { browserPid: 888, browserStartTimeTicks: 321, binaryPath: "/synthetic/chromium", profileMode: "ephemeral" as const, profileDir: path.join(root, "browser") } }),
  }, env);
  sessionId = session.id;
}

it.each(["browser", "desktop+android"] as const)("validates desktop capability for %s", async (kind) => {
  await useDesktopCapability(kind);
  const target = await validateTypingTarget(sessionId, ":190", env);
  expect(target.path).toBe("/tmp/.X11-unix/X190");
  expect(target.alive()).toBe(true);
  expect(server.connections).toBe(0);
});

it.each(["browser", "desktop+android"] as const)("types through desktop capability for %s", async (kind) => {
  await useDesktopCapability(kind);
  await type("áéáé Olá café 日本");
  expect(delayedText()).toBe("áéáé Olá café 日本");
  expect(server.inputCalls).toBe(1);
  expect(server.changes.length).toBeGreaterThan(0);
  expect(server.changes).not.toContain(8);
});

const invalidCapabilities = (["browser", "desktop+android"] as const).flatMap((kind) =>
  ["missing-desktop", "wrong-display", "invalid-display", "dead", "foreign"].map((fault) => ({ kind, fault })),
);
it.each(invalidCapabilities)("refuses unsafe $kind desktop capability: $fault", async ({ kind, fault }) => {
  await useDesktopCapability(kind);
  if (fault === "missing-desktop") await updateSession(sessionId, { desktop: undefined }, env);
  if (fault === "dead") vi.mocked(processIdentityMatches).mockReturnValue(false);
  if (fault === "foreign") fs.writeFileSync(path.join(root, "proc-0"), ["Xorg", ":190", "-nolisten", "tcp", ""].join("\0"));
  const display = fault === "wrong-display" ? ":191" : fault === "invalid-display" ? "localhost:190" : ":190";
  await expect(validateTypingTarget(sessionId, display, env)).rejects.toThrow("preparation failed");
  await expect(typeText({ sessionId, display, text: "private", env })).rejects.toThrow("preparation failed");
  expect(server.connections).toBe(0);
  expect(server.changes).toEqual([]);
  expect(runCommand).not.toHaveBeenCalled();
});

it.each(["wrong", "dead", "missing", "stopped", "missing-desktop"])("refuses an uncertain target before socket access: %s", async (kind) => {
  if (kind === "dead") vi.mocked(processIdentityMatches).mockReturnValue(false);
  if (kind === "missing") sessionId = "missing";
  if (kind === "stopped") await updateSession(sessionId, { status: "stopped" }, env);
  if (kind === "missing-desktop") await updateSession(sessionId, { desktop: undefined }, env);
  const display = kind === "wrong" ? ":191" : ":190";
  await expect(typeText({ sessionId, display, text: "private", env })).rejects.toThrow();
  expect(server.connections).toBe(0);
  expect(server.changes).toEqual([]);
  expect(runCommand).not.toHaveBeenCalled();
});

it.each(["cmdline", "lock", "socket-owner"])("refuses invalid owned-display evidence: %s", async (kind) => {
  const index = { cmdline: 0, lock: 1, "socket-owner": 2 }[kind as "cmdline" | "lock" | "socket-owner"];
  fs.writeFileSync(path.join(root, `proc-${index}`), "unrelated");
  await expect(type("private")).rejects.toThrow("preparation failed");
  expect(server.connections).toBe(0);
});

it("refuses a foreign UID before connecting", async () => {
  const original = vi.mocked(fs.statSync).getMockImplementation()!;
  vi.mocked(fs.statSync).mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    const result = Reflect.apply(original, fs, args) as fs.Stats;
    if (String(args[0]) === "/proc/777") result.uid = process.getuid!() + 1;
    return result;
  }) as typeof fs.statSync);
  await expect(type("private")).rejects.toThrow("preparation failed");
  expect(server.connections).toBe(0);
});

it("refuses missing start identity and configured X authorization without reading it", async () => {
  await updateSession(sessionId, { desktop: { display: ":190", xvfbPid: 777, width: 1280, height: 800 } }, env);
  await expect(type("private")).rejects.toThrow("preparation failed");
  await updateSession(sessionId, { desktop: { display: ":190", xvfbPid: 777, xvfbStartTimeTicks: 123, width: 1280, height: 800 } }, env);
  fs.writeFileSync(path.join(root, "proc-0"), ["Xvfb", ":190", "-nolisten", "tcp", "-auth", "/synthetic-auth", ""].join("\0"));
  await expect(type("private")).rejects.toThrow("preparation failed");
  expect(vi.mocked(fs.openSync).mock.calls.some(([file]) => String(file) === "/synthetic-auth")).toBe(false);
  expect(server.connections).toBe(0);
});

it("uses nonblocking no-follow ownership reads and refuses planted symlinks", async () => {
  await type("a");
  const reads = vi.mocked(fs.openSync).mock.calls.filter(([file]) => String(file) === "/tmp/.X190-lock");
  expect(reads.length).toBeGreaterThan(0);
  for (const [, flags] of reads) {
    expect(Number(flags) & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(Number(flags) & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
  }
  const lock = path.join(root, "proc-1");
  fs.renameSync(lock, lock + "-saved");
  fs.symlinkSync(lock + "-saved", lock);
  const connected = server.connections;
  await expect(type("private")).rejects.toThrow("preparation failed");
  expect(server.connections).toBe(connected);
});

it("refuses ambiguous socket ownership", async () => {
  fs.appendFileSync(path.join(root, "proc-2"), "0: 2 0 10000 0001 01 54321 /tmp/.X11-unix/X190\n");
  await expect(type("private")).rejects.toThrow("preparation failed");
  expect(server.connections).toBe(0);
});

it("uses PICKLAB fallback but gives an empty PICKFORGE_HOME precedence", async () => {
  const home = env.PICKFORGE_HOME;
  env = { PICKLAB_HOME: home };
  await type("á");
  expect(delayedText()).toBe("á");
  const connected = server.connections;
  env = { PICKFORGE_HOME: "", PICKLAB_HOME: home, HOME: root };
  await expect(type("private")).rejects.toThrow();
  expect(server.connections).toBe(connected);
});

it("does not expose argv or child output from dispatch failure", async () => {
  const normal = vi.mocked(runCommand).getMockImplementation()!;
  vi.mocked(runCommand).mockImplementation(async (command, args, options) => {
    if (args[0] === "type") throw new Error("sensitive-marker raw output");
    return normal(command, args, options);
  });
  await expect(type("sensitive-marker")).rejects.toThrow("Desktop text dispatch failed; text may have been partially sent");
});

const replyFaults: { name: string; opcode: number; mutate: (reply: Buffer, socket: import("node:net").Socket) => Buffer | undefined }[] = [
  { name: "zero-core-width", opcode: 101, mutate: (reply) => { reply[1] = 0; return reply; } },
  { name: "oversize", opcode: 101, mutate: (reply) => { reply.writeUInt32LE(0xffffffff, 4); return reply; } },
  { name: "sequence", opcode: 101, mutate: (reply) => { reply.writeUInt16LE(65500, 2); return reply; } },
  { name: "truncated", opcode: 101, mutate: (reply, socket) => { socket.end(reply.subarray(0, 33)); return undefined; } },
  { name: "eof", opcode: 101, mutate: (_reply, socket) => { socket.end(); return undefined; } },
  { name: "zero-type-levels", opcode: 135, mutate: (reply) => { reply[44] = 0; return reply; } },
  { name: "zero-group-width", opcode: 135, mutate: (reply) => { reply[77] = 0; return reply; } },
  { name: "bad-total", opcode: 135, mutate: (reply) => { reply.writeUInt16LE(65535, 18); return reply; } },
  { name: "events", opcode: 101, mutate: () => {
    const event = Buffer.alloc(32); event[0] = 34;
    return Buffer.concat(Array.from({ length: 4100 }, () => event));
  } },
  { name: "timeout", opcode: 101, mutate: () => undefined },
  { name: "death", opcode: 119, mutate: (reply) => { vi.mocked(processIdentityMatches).mockReturnValue(false); return reply; } },
];
it.each(replyFaults)("closes the connection and releases its grab on $name", async (fault) => {
  server.fault = (opcode, reply, socket) => {
    if (opcode === fault.opcode && reply.length > 32) return fault.mutate(reply, socket);
    return reply;
  };
  await expect(type("private")).rejects.toThrow("preparation failed");
  expect(server.inputCalls).toBe(0);
  expect(server.changes).toEqual([]);
  const stop = Date.now() + 500;
  while (server.grab && Date.now() < stop) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(server.grab).toBeUndefined();
});

it("keeps protocol byte order separate from the server's image byte order", async () => {
  server.fault = (opcode, reply) => {
    if (opcode === -1) { reply[30] = 1; reply[31] = 1; }
    return reply;
  };
  await type("áé");
  expect(delayedText()).toBe("áé");
});

it.each(["denied", "endian", "missing-xkb", "denied-xkb", "screens", "depths"])("fails closed during setup: %s", async (fault) => {
  server.fault = (opcode, reply) => {
    if (opcode === -1 && fault === "denied") reply[0] = 0;
    if (opcode === -1 && fault === "endian") reply.writeUInt16BE(11, 2);
    if (opcode === -1 && fault === "screens") reply[28] = 2;
    if (opcode === -1 && fault === "depths") reply[79] = 1;
    if (opcode === 98 && fault === "missing-xkb") reply[8] = 0;
    if (opcode === 135 && fault === "denied-xkb") reply[1] = 0;
    return reply;
  };
  await expect(type("private")).rejects.toThrow("preparation failed");
  expect(server.requests).not.toContain(36);
  expect(server.inputCalls).toBe(0);
});
