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
import { createSession, runCommand, processIdentityMatches, type EnvLike } from "@pickforge/lab-core";
import { typeText } from "../src/input.js";
import { prepareText } from "../src/x11-prebind.js";
import { request, X11Wire } from "../src/x11-wire.js";
let root: string;
let env: EnvLike;
let server: FakeXServer;
let id: string;
let now: number;
const success = { ok: true, code: 0, signal: null, stdout: "xdotool version 3.20160805.1", stderr: "", timedOut: false, stdoutTruncated: false, stderrTruncated: false } as const;
beforeEach(async () => {
  now = performance.now();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xa-"));
  env = { PICKFORGE_HOME: path.join(root, "pf") };
  server = new FakeXServer(path.join(root, "s"));
  await server.start(); installTargetFixture(root, server);
  id = (await createSession({ type: "desktop", projectDir: root, status: "running", desktop: { display: ":190", xvfbPid: 777, xvfbStartTimeTicks: 123 } }, env)).id;
  vi.mocked(processIdentityMatches).mockReturnValue(true);
  vi.mocked(runCommand).mockReset().mockResolvedValue(success);
});
afterEach(async () => {
  for (const wire of server.wires) wire.destroy();
  await server.stop();
  vi.useRealTimers(); vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const prepare = () => prepareText(id, ":190", "áé", env, now + 60000);
const type = () => typeText({ sessionId: id, display: ":190", text: "private áé", env });

it("passive anchor survives old grab/setup caps but expires at the original idle deadline", async () => {
  const anchor = await prepare();
  expect(server.grab).toBeUndefined();
  expect(vi.getTimerCount()).toBe(2);
  now += 4000; await vi.advanceTimersByTimeAsync(4000);
  anchor.check(); expect(anchor.signal.aborted).toBe(false);
  now += 56000; await vi.advanceTimersByTimeAsync(56000);
  expect(anchor.signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect([...server.wires].every((s) => s.destroyed)).toBe(true);
});

it("slow version cannot obtain a fresh preparation budget", async () => {
  vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
    if (args[0] === "--version") now += 3001;
    return success;
  });
  await expect(type()).rejects.toThrow(/^Desktop text preparation failed; no text was sent$/);
  expect(vi.mocked(runCommand).mock.calls).toHaveLength(1);
  expect(vi.mocked(runCommand).mock.calls[0]![2]?.timeoutMs).toBe(3000);
  expect(server.connections).toBe(0);
});

it("elapsed initial ownership work is charged to the same preparation budget", async () => {
  const lstat = vi.mocked(fs.lstatSync).getMockImplementation()!;
  let validations = 0;
  vi.mocked(fs.lstatSync).mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === "/tmp/.X11-unix/X190" && ++validations === 1) now += 2500;
    return Reflect.apply(lstat, fs, args);
  }) as typeof fs.lstatSync);
  vi.mocked(runCommand).mockImplementation(async () => { now += 600; return success; });
  await expect(type()).rejects.toThrow(/^Desktop text preparation failed; no text was sent$/);
  expect(vi.mocked(runCommand).mock.calls).toHaveLength(1);
  expect(vi.mocked(runCommand).mock.calls[0]![2]?.timeoutMs).toBe(500);
  expect(server.connections).toBe(0);
});

it("near-expiry negotiation cannot extend preparation by starting a grab", async () => {
  let replies = 0;
  server.fault = (opcode, reply) => {
    if (opcode === 135 && ++replies === 1) now += 2990;
    if (opcode === 119) now += 11;
    return reply;
  };
  await expect(type()).rejects.toThrow(/^Desktop text preparation failed; no text was sent$/);
  expect(vi.mocked(runCommand).mock.calls.map(([, args]) => args)).toEqual([["--version"]]);
  expect([...server.wires].every((s) => s.destroyed)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("normal dispatch can outlive three seconds without a grab", async () => {
  vi.mocked(runCommand).mockImplementation(async (_cmd, args, options) => {
    if (args[0] === "type") {
      now += 4000; await vi.advanceTimersByTimeAsync(4000);
      expect(options?.signal?.aborted).toBe(false);
      expect(server.grab).toBeUndefined();
      expect([...server.wires].some((s) => !s.destroyed)).toBe(true);
    }
    return success;
  });
  await type();
  expect(vi.getTimerCount()).toBe(0);
});

it("identity loss cancels the passive guarantee without traffic", async () => {
  const anchor = await prepare();
  vi.mocked(processIdentityMatches).mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(50);
  expect(anchor.signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["eof", "parser", "flood", "socket-error"])("dispatch loss %s cancels once and never becomes success or leaks data", async (kind) => {
  let cancellations = 0;
  vi.mocked(runCommand).mockImplementation(async (_cmd, args, options) => {
    if (args[0] === "type") {
      const signal = options!.signal!;
      const lost = once(signal, "abort");
      signal.addEventListener("abort", () => { cancellations++; }, { once: true });
      const peer = [...server.sockets][0]!;
      if (kind === "eof") peer.end();
      else if (kind === "parser") peer.write(Buffer.alloc(32));
      else if (kind === "socket-error") [...server.wires][0]!.emit("error", new Error("private payload"));
      else {
        const notify = Buffer.alloc(32 * 4097);
        for (let i = 0; i < 4097; i++) notify[i * 32] = 34;
        peer.write(notify);
      }
      await lost;
    }
    return success; // Race: cancellation wins even against code zero.
  });
  await expect(type()).rejects.toThrow(/^Desktop text dispatch failed; text may have been partially sent$/);
  expect(cancellations).toBe(1);
  expect(vi.mocked(runCommand).mock.calls.filter(([, args]) => args[0] === "type")).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("post-preparation validation failure closes the anchor without dispatch", async () => {
  const lstat = vi.mocked(fs.lstatSync).getMockImplementation()!;
  let validations = 0;
  vi.mocked(fs.lstatSync).mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === "/tmp/.X11-unix/X190" && ++validations === 3) throw new Error("private metadata");
    return Reflect.apply(lstat, fs, args);
  }) as typeof fs.lstatSync);
  await expect(type()).rejects.toThrow(/^Desktop text preparation failed; no text was sent$/);
  expect(vi.mocked(runCommand).mock.calls.map(([, args]) => args)).toEqual([["--version"]]);
  expect([...server.wires].every((s) => s.destroyed)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("delayed post-preparation validation cannot extend the absolute budget", async () => {
  const lstat = vi.mocked(fs.lstatSync).getMockImplementation()!;
  let validations = 0;
  vi.mocked(fs.lstatSync).mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === "/tmp/.X11-unix/X190" && ++validations === 3) now += 60001;
    return Reflect.apply(lstat, fs, args);
  }) as typeof fs.lstatSync);
  await expect(type()).rejects.toThrow(/^Desktop text preparation failed; no text was sent$/);
  expect(vi.mocked(runCommand).mock.calls.map(([, args]) => args)).toEqual([["--version"]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("passive mode refuses further requests and requires completed ungrab sync", async () => {
  const incomplete = new X11Wire("/tmp/.X11-unix/X190", now + 60000, () => true);
  await incomplete.hello();
  expect(() => incomplete.retain()).toThrow("preparation failed");
  const anchor = await prepare();
  const requests = server.requests.length;
  expect(() => anchor.send(request(43))).toThrow("preparation failed");
  expect(server.requests).toHaveLength(requests);
  expect(anchor.signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
