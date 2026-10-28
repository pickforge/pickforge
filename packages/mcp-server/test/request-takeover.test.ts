import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  acquireHumanLease, releaseHumanLease, readHumanLease, readActions, readProcessIdentity,
  projectConfigPath, resolveRunStorage, type EnvLike,
} from "@pickforge/lab-core";
import { withViewerDir, writeViewerPrivateFile, type NativeViewerHostIdentity, type ViewerControlEvent } from "@pickforge/lab-desktop-linux";
import { registerTakeoverTools } from "../src/tools/takeover.js";
import type { ViewerLauncher } from "../src/context.js";
import { connectLab, makeLabDirs, MINI_PNG, parseToolJson, writeDesktopSessionRecord, writeScript, type ConnectedLab, type LabDirs } from "./helpers.js";

let dirs: LabDirs;
let env: EnvLike;
let lab: ConnectedLab | undefined;
let id: string;
let captureLog: string;
let fake: Awaited<ReturnType<typeof openFakeHost>> | undefined;

beforeEach(() => {
  dirs = makeLabDirs();
  env = { PICKFORGE_HOME: dirs.home, PICKFORGE_STORAGE_MODE: "project-local", PATH: dirs.binDir };
  const fixture = path.join(dirs.root, "fresh.png");
  captureLog = path.join(dirs.root, "captures");
  fs.writeFileSync(fixture, MINI_PNG);
  const body = `echo capture >> "${captureLog}"\nfor arg in "$@"; do out="$arg"; done\n/bin/cp "${fixture}" "$out"`;
  writeScript(path.join(dirs.binDir, "import"), body);
  writeScript(path.join(dirs.binDir, "maim"), body);
  id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
});

afterEach(async () => {
  await lab?.close();
  await fake?.close();
  lab = undefined;
  fake = undefined;
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

/** A stdio-free host fixture exercises the real authenticated socket client. */
async function openFakeHost(): Promise<{
  host: NativeViewerHostIdentity;
  calls: Array<Record<string, unknown>>;
  emit(event: ViewerControlEvent): void;
  close(): Promise<void>;
}> {
  const calls: Array<Record<string, unknown>> = [];
  const subscribers = new Set<net.Socket>();
  const sockets = new Set<net.Socket>();
  let state: ViewerControlEvent | undefined;
  let host!: NativeViewerHostIdentity;
  const emit = (event: ViewerControlEvent): void => {
    state = event;
    for (const socket of subscribers) socket.write(`${JSON.stringify(event)}\n`);
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => { sockets.delete(socket); subscribers.delete(socket); });
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      if (!pending.includes("\n")) return;
      const request = JSON.parse(pending);
      pending = "";
      calls.push(request);
      const response = { ok: true, host, mode: "expanded", sessionEnded: false };
      if (request.op === "subscribe") {
        subscribers.add(socket);
        socket.write(`${JSON.stringify({ ...response, requestState: state })}\n`);
      } else {
        socket.end(`${JSON.stringify({ ...response, ...(request.op === "requestTakeover" ? { requestId: "request-1" } : {}) })}\n`);
        if (request.op === "cancelRequest") emit({ event: "requestEnded", requestId: "request-1", outcome: "cancelled" });
      }
    });
  });
  await withViewerDir(id, env, true, async (directory) => {
    server.listen(directory.resolve("host.sock"));
    await once(server, "listening");
    fs.chmodSync(directory.resolve("host.sock"), 0o600);
    const stats = (await directory.lstatChild("host.sock"))!;
    const identity = readProcessIdentity(process.pid)!;
    host = { version: "0.6.0", sessionId: id, launchId: "a".repeat(32), ...identity,
      viewerPid: identity.pid, viewerStartTicks: identity.startTicks,
      socket: path.join(dirs.home, "sessions", id, "viewer", "host.sock"), socketIno: stats.ino, socketDev: stats.dev };
    await writeViewerPrivateFile(directory, "host.json", JSON.stringify(host));
  });
  return { host, calls, emit, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

async function connect(viewerLauncher?: ViewerLauncher): Promise<ConnectedLab> {
  return lab = await connectLab({ projectDir: dirs.projectDir, env, viewerLauncher });
}

async function waitForSubscription(): Promise<void> {
  await expect.poll(() => fake!.calls.some((call) => call.op === "subscribe")).toBe(true);
}

function autoMode(): void {
  fs.mkdirSync(path.dirname(projectConfigPath(dirs.projectDir)), { recursive: true });
  fs.writeFileSync(projectConfigPath(dirs.projectDir), JSON.stringify({ viewer: { mode: "auto" } }));
}

describe("request_takeover", () => {
  it("returns the CLI command in manual mode without probing or launching", async () => {
    const launcher = { available: vi.fn(async () => true), launch: vi.fn() };
    const { client } = await connect(launcher);
    const result = parseToolJson(await client.callTool({ name: "request_takeover", arguments: { message: "Help" } }));
    expect(result).toMatchObject({ ok: true, outcome: "viewer_not_open", command: `pickforge-lab watch --session ${id}`, screenshot: null });
    expect(launcher.available).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it.each(["library", "unavailable"])("does not launch with auto mode and %s", async (kind) => {
    autoMode();
    const launcher = { available: vi.fn(async () => false), launch: vi.fn() };
    const { client } = await connect(kind === "library" ? undefined : launcher);
    const result = parseToolJson(await client.callTool({ name: "request_takeover", arguments: { session: id, message: "Help" } }));
    expect(result).toMatchObject({ ok: true, outcome: "viewer_not_open", command: `pickforge-lab watch --session ${id}` });
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("launches through the injected launcher only in auto mode", async () => {
    autoMode();
    const launcher = { available: vi.fn(async () => true), launch: vi.fn(async () => (fake = await openFakeHost()).host) };
    const { client } = await connect(launcher);
    const pending = client.callTool({ name: "request_takeover", arguments: { message: "Help" } });
    await expect.poll(() => fake).toBeDefined();
    await waitForSubscription();
    fake!.emit({ event: "viewerClosed", requestId: "request-1", outcome: "viewer_closed" });
    expect(parseToolJson(await pending)).toMatchObject({ ok: true, outcome: "viewer_closed", screenshot: { sessionId: id } });
    expect(launcher.available).toHaveBeenCalledWith(expect.objectContaining(env));
    expect(launcher.launch).toHaveBeenCalledWith(id, expect.objectContaining(env));
  });

  it("waits on an existing lease without launching or sending attention", async () => {
    const lease = await acquireHumanLease(id, env);
    const launcher = { available: vi.fn(), launch: vi.fn() };
    const { client } = await connect(launcher);
    const pending = client.callTool({ name: "request_takeover", arguments: { message: "Help" } });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(fs.existsSync(captureLog)).toBe(false);
    await releaseHumanLease(id, lease.leaseId, env);
    expect(parseToolJson(await pending)).toMatchObject({ ok: true, outcome: "returned", screenshot: { sessionId: id } });
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("returns a fresh screenshot after taken and returned, with message-free evidence", async () => {
    fake = await openFakeHost();
    const { client } = await connect();
    const message = "Please help with the account";
    const pending = client.callTool({ name: "request_takeover", arguments: { session: id, message } });
    await waitForSubscription();
    expect(fake.calls).toContainEqual({ op: "requestTakeover", message, timeoutMs: 600_000 });
    const lease = await acquireHumanLease(id, env);
    fake.emit({ event: "controlTaken", requestId: "request-1" });
    expect(fs.existsSync(captureLog)).toBe(false);
    await releaseHumanLease(id, lease.leaseId, env);
    fake.emit({ event: "controlReturned", reason: "returned", requestId: "request-1", outcome: "returned" });
    const result = parseToolJson(await pending);
    expect(result).toMatchObject({ ok: true, outcome: "returned", screenshot: { sessionId: id } });
    expect(result.heldMs).toBeGreaterThanOrEqual(0);
    expect(fs.readFileSync(result.screenshot.path)).toEqual(MINI_PNG);
    const actions = await readActions(result.screenshot.runDir);
    expect(actions).toContainEqual(expect.objectContaining({ tool: "takeover_requested", status: "ok" }));
    expect(JSON.stringify(actions)).not.toContain(message);
  });

  it.each([false, true])("returns timeout with control taken=%s without ending the lease", async (taken) => {
    fake = await openFakeHost();
    const { client } = await connect();
    const pending = client.callTool({ name: "request_takeover", arguments: { message: "Help", timeoutMs: 100 } });
    await waitForSubscription();
    const lease = taken ? await acquireHumanLease(id, env) : undefined;
    fake.emit({ event: "requestEnded", requestId: "request-1", outcome: "timeout" });
    const result = parseToolJson(await pending);
    expect(result).toMatchObject({ ok: true, outcome: "timeout" });
    expect(Boolean(result.screenshot)).toBe(!taken);
    if (lease !== undefined) {
      expect((await readHumanLease(id, env))?.leaseId).toBe(lease.leaseId);
      await releaseHumanLease(id, lease.leaseId, env);
    }
  });

  it("reports a disconnected viewer with a screenshot", async () => {
    fake = await openFakeHost();
    const { client } = await connect();
    const pending = client.callTool({ name: "request_takeover", arguments: { message: "Help" } });
    await waitForSubscription();
    await fake.close();
    fake = undefined;
    expect(parseToolJson(await pending)).toMatchObject({ ok: true, outcome: "viewer_closed", screenshot: { sessionId: id } });
  });

  it("cancels the host request through the handler and preserves live control", async () => {
    fake = await openFakeHost();
    const registerTool = vi.fn();
    registerTakeoverTools({ registerTool } as unknown as McpServer, { projectDir: dirs.projectDir, env });
    const handler = registerTool.mock.calls.find(([name]) => name === "request_takeover")![2];
    const controller = new AbortController();
    const pending = handler({ session: id, message: "Help" }, { mcpReq: { signal: controller.signal } });
    await waitForSubscription();
    const lease = await acquireHumanLease(id, env);
    controller.abort();
    expect(parseToolJson(await pending)).toMatchObject({ ok: true, outcome: "cancelled", screenshot: null });
    expect(fake.calls).toContainEqual({ op: "cancelRequest", requestId: "request-1" });
    expect((await readHumanLease(id, env))?.leaseId).toBe(lease.leaseId);
    await releaseHumanLease(id, lease.leaseId, env);
  });

  it("cancels through MCP transport and records cancellation", async () => {
    fake = await openFakeHost();
    const { client } = await connect();
    const controller = new AbortController();
    const pending = client.callTool({ name: "request_takeover", arguments: { message: "Help" } }, { signal: controller.signal });
    await waitForSubscription();
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expect.poll(() => fake!.calls.some((call) => call.op === "cancelRequest")).toBe(true);
    const { runsDir } = await resolveRunStorage(dirs.projectDir, env);
    await expect.poll(async () => {
      const names = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((name) => !name.startsWith(".")) : [];
      const actions = (await Promise.all(names.map((name) => readActions(path.join(runsDir, name))))).flat();
      return actions.some((action) => "tool" in action && action.tool === "takeover_requested" && action.status === "cancelled");
    }).toBe(true);
  });

  it.each([{ message: "a".repeat(501) }, { message: "line\nbreak" }, { message: "Help", timeoutMs: -1 },
    { message: "Help", timeoutMs: 3_600_001 }, { message: "Help", timeoutMs: 1.5 }])("rejects invalid arguments %j", async (args) => {
    const { client } = await connect();
    expect((await client.callTool({ name: "request_takeover", arguments: args })).isError).toBe(true);
    expect(fs.existsSync(captureLog)).toBe(false);
  });
});
