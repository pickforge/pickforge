import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { ensureCliBuilt } from "./build-once.js";
import { EventEmitter, once } from "node:events";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createSession, updateSession, getSession, readProcessIdentity, identityIsAlive,
  destroySessionRecord, stopProcessGroupVerified,
} from "@pickforge/lab-core";
import * as desktop from "@pickforge/lab-desktop-linux";
import { startViewerBridge, type ViewerBridge, type ViewerBridgeOptions } from "../src/viewer/bridge.js";
import { ensureViewerBridge } from "../src/viewer/bridge-daemon.js";
import { runViewerBridge } from "../src/commands/viewer-bridge.js";
import { buildProgram } from "../src/program.js";

let root: string;
let env: NodeJS.ProcessEnv;
let id: string;
let token: string;
let assets: ViewerBridgeOptions["assets"];
const bridges: ViewerBridge[] = [];
const clients: WebSocket[] = [];
const owned: { pid: number; startTicks: number }[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), ".viewer-bridge-test-"));
  env = { ...process.env, PICKFORGE_HOME: root };
  id = (await createSession({ type: "desktop", status: "running", projectDir: root, desktop: { display: ":991", viewerBridgePid: process.pid } }, env)).id;
  await desktop.prepareViewerLaunch(id, env);
  token = randomBytes(32).toString("base64url");
  assets = { pageDir: path.join(root, "page"), novncDir: path.join(root, "novnc") };
  await fs.mkdir(assets.pageDir); await fs.mkdir(path.join(assets.novncDir, "core"), { recursive: true });
  await fs.mkdir(path.join(assets.novncDir, "vendor"));
  for (const name of ["index.html", "viewer.js", "viewer.css"]) await fs.writeFile(path.join(assets.pageDir, name), "asset");
});
afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const identity of owned.splice(0)) await stopProcessGroupVerified(identity, { timeoutMs: 500 });
  vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true });
});
async function start(patch: Partial<ViewerBridgeOptions> = {}): Promise<ViewerBridge> {
  const bridge = await startViewerBridge({ sessionId: id, token, registryEnv: env, assets, pollMs: 10, ...patch });
  bridges.push(bridge); return bridge;
}
async function open(bridge: ViewerBridge, autoPong = true): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/websockify?token=${token}`, {
    headers: { Origin: `http://127.0.0.1:${bridge.port}` }, autoPong,
  });
  ws.on("error", () => {}); clients.push(ws); await once(ws, "open"); return ws;
}
function fakeTcp(): net.Socket {
  return Object.assign(new EventEmitter(), { writableLength: 0, writableHighWaterMark: 16384,
    write: vi.fn(() => true), pause: vi.fn(), resume: vi.fn(), destroy: vi.fn() }) as unknown as net.Socket;
}
async function closedPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("error", () => resolve(true)); socket.once("connect", () => { socket.destroy(); resolve(false); });
  });
}

describe("bridge socket lifecycle", () => {
  it("bounds both relay directions and pauses/resumes their producers", async () => {
    const tcp = fakeTcp(); vi.spyOn(desktop, "connectSessionVncReadOnly").mockResolvedValue(tcp);
    vi.mocked(tcp.write).mockReturnValue(false);
    const pause = vi.spyOn(WebSocket.prototype, "pause"); const resume = vi.spyOn(WebSocket.prototype, "resume");
    const bridge = await start(); const ws = await open(bridge);
    ws.send(Buffer.from("binary"));
    await vi.waitFor(() => expect(tcp.write).toHaveBeenCalled()); expect(pause).toHaveBeenCalled();
    const calls = resume.mock.calls.length; tcp.emit("drain"); expect(resume.mock.calls.length).toBeGreaterThan(calls);
    const original = WebSocket.prototype.send;
    const serverSockets: WebSocket[] = [];
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
      original.apply(this, args);
      serverSockets.push(this);
      Object.defineProperty(this, "bufferedAmount", { configurable: true, value: 256 * 1024 });
    });
    tcp.emit("data", Buffer.from("frame")); expect(tcp.pause).toHaveBeenCalled();
    Object.defineProperty(serverSockets.at(-1)!, "bufferedAmount", { configurable: true, value: 0 });
    await vi.waitFor(() => expect(tcp.resume).toHaveBeenCalled());
    Object.defineProperty(serverSockets.at(-1)!, "bufferedAmount", { configurable: true, value: 320 * 1024 });
    const close = once(ws, "close"); tcp.emit("data", Buffer.from("overflow")); expect((await close)[0]).toBe(1009);
    expect(tcp.destroy).toHaveBeenCalled();
  });
  it("rejects TCP write overflow and closes both sides on a TCP error", async () => {
    const tcp = fakeTcp(); vi.spyOn(desktop, "connectSessionVncReadOnly").mockResolvedValue(tcp);
    const bridge = await start(); let ws = await open(bridge);
    Object.defineProperty(tcp, "writableLength", { value: 320 * 1024, configurable: true });
    let closed = once(ws, "close"); ws.send(Buffer.from("overflow")); expect((await closed)[0]).toBe(1009);
    expect(tcp.write).not.toHaveBeenCalled(); expect(tcp.destroy).toHaveBeenCalled();
    Object.defineProperty(tcp, "writableLength", { value: 0 });
    ws = await open(bridge); closed = once(ws, "close"); tcp.emit("error", new Error("private upstream error"));
    await closed; expect(tcp.destroy).toHaveBeenCalledTimes(2);
  });
  it("terminates a peer that misses a pong while keeping responsive peers alive", async () => {
    vi.spyOn(desktop, "connectSessionVncReadOnly").mockImplementation(async () => fakeTcp());
    const bridge = await start({ pingMs: 25 }); const responsive = await open(bridge); const silent = await open(bridge, false);
    await once(silent, "close"); expect(responsive.readyState).toBe(WebSocket.OPEN);
  });
  it("enforces upstream connect deadlines and destroys late connections", async () => {
    const tcp = fakeTcp(); let resolve!: (socket: net.Socket) => void;
    vi.spyOn(desktop, "connectSessionVncReadOnly").mockImplementation(() => new Promise(r => { resolve = r; }));
    const bridge = await start({ connectMs: 20 }); const ws = await open(bridge);
    expect((await once(ws, "close"))[0]).toBe(4001);
    resolve(tcp); await vi.waitFor(() => expect(tcp.destroy).toHaveBeenCalled());
  });
  it("enforces an absolute handshake deadline", async () => {
    const bridge = await start({ handshakeMs: 30 }); const socket = net.connect({ host: "127.0.0.1", port: bridge.port });
    socket.on("error", () => {}); await once(socket, "connect"); socket.write("GET /web"); await once(socket, "close");
    expect(socket.destroyed).toBe(true);
  });
  it("closes sockets with 4004 during idempotent shutdown", async () => {
    const tcp = fakeTcp(); vi.spyOn(desktop, "connectSessionVncReadOnly").mockResolvedValue(tcp);
    const bridge = await start(); const ws = await open(bridge); const close = once(ws, "close");
    await Promise.all([bridge.close(), bridge.close()]); expect((await close)[0]).toBe(4004); expect(tcp.destroy).toHaveBeenCalled();
  });
});

describe("bridge supervision", () => {
  it.each(["stopped", "deleted", "replaced"])("exits when the session is %s", async reason => {
    vi.spyOn(desktop, "connectSessionVncReadOnly").mockResolvedValue(fakeTcp());
    const bridge = await start(); const ws = await open(bridge); const close = once(ws, "close");
    if (reason === "deleted") await destroySessionRecord(id, env);
    else if (reason === "stopped") await updateSession(id, { status: "stopped" }, env);
    else await updateSession(id, { desktop: { display: ":991", viewerBridgePid: 99999999 } }, env);
    expect((await close)[0]).toBe(4004); await vi.waitFor(async () => expect(await closedPort(bridge.port)).toBe(true));
  });
  it("exits after idle time and counts requests and connected peers as activity", async () => {
    vi.spyOn(desktop, "connectSessionVncReadOnly").mockResolvedValue(fakeTcp());
    const bridge = await start({ idleMs: 80 }); const ws = await open(bridge);
    await new Promise(resolve => setTimeout(resolve, 100)); expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close(); await once(ws, "close");
    await new Promise(resolve => setTimeout(resolve, 40));
    const res = await fetch(`http://127.0.0.1:${bridge.port}/unknown`); expect(res.status).toBe(404);
    await new Promise(resolve => setTimeout(resolve, 45)); expect(await closedPort(bridge.port)).toBe(false);
    await vi.waitFor(async () => expect(await closedPort(bridge.port)).toBe(true));
  });
  it.each(["SIGTERM", "SIGINT"] as const)("closes on %s without changing the host session", async signal => {
    const bridge = await start(); process.emit(signal, signal);
    await vi.waitFor(async () => expect(await closedPort(bridge.port)).toBe(true));
  });
  it("gives daemon registration a bounded startup grace", async () => {
    await updateSession(id, { desktop: { display: ":991" } }, env);
    const bridge = await start({ startupGraceMs: 20 });
    await vi.waitFor(async () => expect(await closedPort(bridge.port)).toBe(true));
  });
});

async function daemonEntry(kind: "ready" | "hang" | "exit" = "ready"): Promise<string> {
  const entry = path.join(root, "daemon.cjs");
  const viewer = desktop.sessionViewerDir(id, env);
  await fs.writeFile(entry, `const fs = require('node:fs');
const dir = ${JSON.stringify(viewer)};
if (${JSON.stringify(kind)} === 'exit') process.exit(1);
if (${JSON.stringify(kind)} === 'ready') {
  const stat = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8');
  const startTicks = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/)[19]);
  const temp = dir + '/.ready-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, startTicks, port: 45678 }), { mode: 0o600 });
  fs.renameSync(temp, dir + '/bridge.json');
}
setInterval(() => {}, 1000);
`);
  return entry;
}

describe("detached bridge daemon", () => {
  it("runs the built hidden command with bundled assets and stops its detached process", async () => {
    await ensureCliBuilt();
    await fs.copyFile(path.join(process.cwd(), "packages/cli/package.json"), path.join(root, "package.json"));
    const cliDir = path.join(root, "cli");
    await fs.cp(path.join(process.cwd(), "packages/cli/dist"), cliDir, { recursive: true });
    await fs.symlink(path.join(process.cwd(), "packages/cli/node_modules"), path.join(cliDir, "node_modules"));
    await fs.cp(path.join(process.cwd(), "packages/cli/src/viewer/page"), path.join(cliDir, "viewer/page"), { recursive: true });
    const require = createRequire(new URL("../package.json", import.meta.url));
    const novnc = path.dirname(path.dirname(require.resolve("@novnc/novnc")));
    for (const name of ["core", "vendor"]) await fs.cp(path.join(novnc, name), path.join(cliDir, "viewer/novnc", name), { recursive: true });
    await updateSession(id, { desktop: { display: ":991" } }, env);
    let bridge: Awaited<ReturnType<typeof ensureViewerBridge>>;
    try { bridge = await ensureViewerBridge(id, { registryEnv: env, _cliEntry: path.join(cliDir, "pickforge-lab.js") }); }
    catch (error) { throw new Error(await fs.readFile(path.join(root, "sessions", id, "viewer-bridge.log"), "utf8"), { cause: error }); }
    const identity = readProcessIdentity(bridge.pid)!; owned.push(identity);
    const response = await fetch(`http://127.0.0.1:${bridge.port}/viewer/${"a".repeat(32)}`);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/websockify?token=${bridge.token}`, { headers: { Origin: `http://127.0.0.1:${bridge.port}` } });
    ws.on("error", () => {}); clients.push(ws);
    const close = once(ws, "close"); await once(ws, "open"); expect((await close)[0]).toBe(4001);
    await stopProcessGroupVerified(identity, { timeoutMs: 1000 });
    expect(identityIsAlive(identity.pid, identity.startTicks)).toBe(false);
    expect(await fs.readFile(path.join(root, "sessions", id, "viewer-bridge.log"), "utf8")).toBe("");
  }, 300_000);
  it("starts, verifies, records and reuses a daemon without exposing its token in argv", async () => {
    await updateSession(id, { desktop: { display: ":991" } }, env);
    const entry = await daemonEntry();
    const first = await ensureViewerBridge(id, { registryEnv: env, _cliEntry: entry });
    const identity = readProcessIdentity(first.pid)!; owned.push(identity);
    expect(first.reused).toBe(false); expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
    const second = await ensureViewerBridge(id, { registryEnv: env, _cliEntry: entry }); expect(second).toEqual({ ...first, reused: true });
    expect((await getSession(id, env))?.desktop).toMatchObject({ viewerBridgePid: first.pid, viewerBridgePort: first.port, viewerBridgeStartTimeTicks: identity.startTicks });
    const argv = await fs.readFile(`/proc/${first.pid}/cmdline`, "utf8"); expect(argv).not.toContain(first.token);
    expect(argv.split("\0").slice(1, -1)).toEqual([entry, "internal", "viewer-bridge", "--session", id]);
    const tokenFile = path.join(desktop.sessionViewerDir(id, env), "token");
    expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o600); expect(await fs.readFile(tokenFile, "utf8")).toBe(first.token);
    expect((await fs.stat(path.join(desktop.sessionViewerDir(id, env), "bridge.json"))).mode & 0o777).toBe(0o600);
    expect(await desktop.stopSessionViewer(id, (await getSession(id, env))?.desktop, env)).toEqual([]);
    expect(identityIsAlive(first.pid, identity.startTicks)).toBe(false);
  });
  it("serializes simultaneous starts and rotates the capability on restart", async () => {
    await updateSession(id, { desktop: { display: ":991" } }, env); const entry = await daemonEntry();
    const [first, second] = await Promise.all([ensureViewerBridge(id, { registryEnv: env, _cliEntry: entry }), ensureViewerBridge(id, { registryEnv: env, _cliEntry: entry })]);
    expect(first.pid).toBe(second.pid); expect([first.reused, second.reused].sort()).toEqual([false, true]);
    const identity = readProcessIdentity(first.pid)!; owned.push(identity); await stopProcessGroupVerified(identity);
    const next = await ensureViewerBridge(id, { registryEnv: env, _cliEntry: entry }); owned.push(readProcessIdentity(next.pid)!);
    expect(next.reused).toBe(false); expect(next.token).not.toBe(first.token);
  });
  it("restarts an owned bridge with a missing token and refuses a token symlink", async () => {
    await updateSession(id, { desktop: { display: ":991" } }, env); const entry = await daemonEntry();
    const first = await ensureViewerBridge(id, { registryEnv: env, _cliEntry: entry }); const identity = readProcessIdentity(first.pid)!; owned.push(identity);
    const tokenFile = path.join(desktop.sessionViewerDir(id, env), "token"); await fs.unlink(tokenFile);
    const next = await ensureViewerBridge(id, { registryEnv: env, _cliEntry: entry }); owned.push(readProcessIdentity(next.pid)!);
    expect(next.token).not.toBe(first.token); expect(identityIsAlive(identity.pid, identity.startTicks)).toBe(false);
    await fs.unlink(tokenFile); await fs.symlink(path.join(root, "foreign"), tokenFile);
    await expect(ensureViewerBridge(id, { registryEnv: env, _cliEntry: entry })).rejects.toThrow();
    await expect(fs.lstat(path.join(root, "foreign"))).rejects.toThrow();
  });
  it.each(["hang", "exit"] as const)("cleans failed %s startups without recording a ready bridge", async kind => {
    await updateSession(id, { desktop: { display: ":991" } }, env);
    await expect(ensureViewerBridge(id, { registryEnv: env, _cliEntry: await daemonEntry(kind), _readyMs: 100 })).rejects.toThrow();
    expect((await getSession(id, env))?.desktop?.viewerBridgePid).toBeUndefined();
  });
  it("rejects a stopped session and exposes the hidden command without its capability", async () => {
    await expect(ensureViewerBridge("../escape", { registryEnv: env })).rejects.toThrow("Invalid session id");
    await updateSession(id, { status: "stopped" }, env);
    await expect(ensureViewerBridge(id, { registryEnv: env, _cliEntry: await daemonEntry() })).rejects.toThrow();
    const program = buildProgram(); const internal = program.commands.find(command => command.name() === "internal")!;
    expect(internal.commands.find(command => command.name() === "viewer-bridge")?.options.map(option => option.long)).toEqual(["--session"]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // Use an invalid id so this command cannot touch the user's registry.
    expect(await runViewerBridge({ session: "invalid" })).toBe(1); expect(log).toHaveBeenCalledWith("Viewer bridge startup failed");
  });
});
