import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { EventEmitter, once } from "node:events";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createSession,
  updateSession,
  getSession,
  readProcessIdentity,
  identityIsAlive,
  destroySessionRecord,
  stopProcessGroupVerified,
} from "@pickforge/lab-core";
import * as desktop from "@pickforge/lab-desktop-linux";
import { ensureCliBuilt } from "./build-once.js";
import {
  startViewerBridge,
  type ViewerBridge,
  type ViewerBridgeOptions,
} from "../src/viewer/bridge.js";
import { ensureViewerBridge } from "../src/viewer/bridge-daemon.js";
import { runViewerBridge } from "../src/commands/viewer-bridge.js";
import { buildProgram } from "../src/program.js";

let testRoot: string;
let registryEnv: NodeJS.ProcessEnv;
let sessionId: string;
let token: string;
let assets: ViewerBridgeOptions["assets"];
const bridges: ViewerBridge[] = [];
const clients: WebSocket[] = [];
const owned: {
  pid: number;
  startTicks: number;
}[] = [];

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(process.cwd(), ".viewer-bridge-test-"));
  registryEnv = { ...process.env, PICKFORGE_HOME: testRoot };
  sessionId = (
    await createSession(
      {
        type: "desktop",
        status: "running",
        projectDir: testRoot,
        desktop: { display: ":991", viewerBridgePid: process.pid },
      },
      registryEnv,
    )
  ).id;
  await desktop.prepareViewerLaunch(sessionId, registryEnv);
  token = randomBytes(32).toString("base64url");
  assets = {
    pageDir: path.join(testRoot, "page"),
    novncDir: path.join(testRoot, "novnc"),
  };
  await fs.mkdir(assets.pageDir);
  await fs.mkdir(path.join(assets.novncDir, "core"), { recursive: true });
  await fs.mkdir(path.join(assets.novncDir, "vendor"));
  for (const name of ["index.html", "viewer.js", "viewer.css"]) {
    await fs.writeFile(path.join(assets.pageDir, name), "asset");
  }
});

afterEach(async () => {
  for (const webSocket of clients.splice(0)) {
    webSocket.terminate();
  }
  for (const bridge of bridges.splice(0)) {
    await bridge.close();
  }
  for (const identity of owned.splice(0)) {
    await stopProcessGroupVerified(identity, { timeoutMs: 500 });
  }
  vi.restoreAllMocks();
  await fs.rm(testRoot, { recursive: true, force: true });
});

async function start(
  patch: Partial<ViewerBridgeOptions> = {},
): Promise<ViewerBridge> {
  const bridge = await startViewerBridge({
    sessionId: sessionId,
    token,
    registryEnv: registryEnv,
    assets,
    pollMs: 10,
    ...patch,
  });
  bridges.push(bridge);
  return bridge;
}

async function open(bridge: ViewerBridge, autoPong = true): Promise<WebSocket> {
  const webSocket = new WebSocket(
    `ws://127.0.0.1:${bridge.port}/websockify?token=${token}`,
    {
      headers: { Origin: `http://127.0.0.1:${bridge.port}` },
      autoPong,
    },
  );
  webSocket.on("error", () => {});
  clients.push(webSocket);
  await once(webSocket, "open");
  return webSocket;
}

function fakeTcp(): net.Socket {
  return Object.assign(new EventEmitter(), {
    writableLength: 0,
    writableHighWaterMark: 16384,
    write: vi.fn(() => true),
    pause: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
  }) as unknown as net.Socket;
}

async function closedPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("error", () => resolve(true));
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe("bridge socket lifecycle", () => {
  it("bounds both relay directions and resumes from send callbacks without polling", async () => {
    const vncSocket = fakeTcp();
    vi.spyOn(desktop, "connectSessionVncReadOnly").mockResolvedValue(vncSocket);
    vi.mocked(vncSocket.write).mockReturnValue(false);
    const pause = vi.spyOn(WebSocket.prototype, "pause");
    const resume = vi.spyOn(WebSocket.prototype, "resume");
    const intervals = vi.spyOn(globalThis, "setInterval");
    const bridge = await start({ pollMs: 1000 });
    const webSocket = await open(bridge);
    webSocket.send(Buffer.from("binary"));
    await vi.waitFor(() => expect(vncSocket.write).toHaveBeenCalled());
    expect(pause).toHaveBeenCalled();
    const calls = resume.mock.calls.length;
    vncSocket.emit("drain");
    expect(resume.mock.calls.length).toBeGreaterThan(calls);
    const serverSockets: WebSocket[] = [];
    const sendCallbacks: ((error?: Error) => void)[] = [];
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      _data,
      _options,
      callback,
    ) {
      serverSockets.push(this);
      sendCallbacks.push(callback!);
      Object.defineProperty(this, "bufferedAmount", {
        configurable: true,
        value: 256 * 1024 + 1,
      });
    });
    vncSocket.emit("data", Buffer.from("frame"));
    vncSocket.emit("data", Buffer.from("second frame"));
    expect(vncSocket.pause).toHaveBeenCalledTimes(2);
    expect(vncSocket.resume).not.toHaveBeenCalled();
    sendCallbacks[0]!();
    expect(vncSocket.resume).not.toHaveBeenCalled();
    Object.defineProperty(serverSockets.at(-1)!, "bufferedAmount", {
      configurable: true,
      value: 0,
    });
    sendCallbacks[1]!();
    expect(vncSocket.resume).toHaveBeenCalledOnce();
    // Only session supervision and heartbeat use intervals.
    expect(intervals.mock.calls.map(([, delay]) => delay)).toEqual([
      1000, 15000,
    ]);
    Object.defineProperty(serverSockets.at(-1)!, "bufferedAmount", {
      configurable: true,
      value: 320 * 1024,
    });
    const close = once(webSocket, "close");
    vncSocket.emit("data", Buffer.from("overflow"));
    expect((await close)[0]).toBe(1009);
    expect(vncSocket.destroy).toHaveBeenCalled();
  });
  it("closes both sockets when a WebSocket send fails", async () => {
    const vncSocket = fakeTcp();
    vi.spyOn(desktop, "connectSessionVncReadOnly").mockResolvedValue(vncSocket);
    const bridge = await start();
    const webSocket = await open(bridge);
    const closed = once(webSocket, "close");
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(
      function (_data, _options, callback) {
        callback!(new Error("Send failed"));
      },
    );
    vncSocket.emit("data", Buffer.from("frame"));
    await closed;
    expect(vncSocket.destroy).toHaveBeenCalledOnce();
    expect(vncSocket.resume).not.toHaveBeenCalled();
  });
  it("rejects TCP write overflow and closes both sides on a TCP error", async () => {
    const vncSocket = fakeTcp();
    vi.spyOn(desktop, "connectSessionVncReadOnly").mockResolvedValue(vncSocket);
    const bridge = await start();
    let webSocket = await open(bridge);
    Object.defineProperty(vncSocket, "writableLength", {
      value: 320 * 1024,
      configurable: true,
    });
    let closed = once(webSocket, "close");
    webSocket.send(Buffer.from("overflow"));
    expect((await closed)[0]).toBe(1009);
    expect(vncSocket.write).not.toHaveBeenCalled();
    expect(vncSocket.destroy).toHaveBeenCalled();
    Object.defineProperty(vncSocket, "writableLength", { value: 0 });
    webSocket = await open(bridge);
    closed = once(webSocket, "close");
    vncSocket.emit("error", new Error("private upstream error"));
    await closed;
    expect(vncSocket.destroy).toHaveBeenCalledTimes(2);
  });
  it("terminates a peer that misses a pong while keeping responsive peers alive", async () => {
    vi.spyOn(desktop, "connectSessionVncReadOnly").mockImplementation(
      async () => fakeTcp(),
    );
    const bridge = await start({ pingMs: 25 });
    const responsive = await open(bridge);
    const silent = await open(bridge, false);
    await once(silent, "close");
    expect(responsive.readyState).toBe(WebSocket.OPEN);
  });
  it("enforces upstream connect deadlines and destroys late connections", async () => {
    const vncSocket = fakeTcp();
    let resolve!: (socket: net.Socket) => void;
    vi.spyOn(desktop, "connectSessionVncReadOnly").mockImplementation(
      () =>
        new Promise((resolveConnection) => {
          resolve = resolveConnection;
        }),
    );
    const bridge = await start({ connectMs: 20 });
    const webSocket = await open(bridge);
    expect((await once(webSocket, "close"))[0]).toBe(4001);
    resolve(vncSocket);
    await vi.waitFor(() => expect(vncSocket.destroy).toHaveBeenCalled());
  });
  it("enforces an absolute handshake deadline", async () => {
    const bridge = await start({ handshakeMs: 30 });
    const socket = net.connect({ host: "127.0.0.1", port: bridge.port });
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write("GET /web");
    await once(socket, "close");
    expect(socket.destroyed).toBe(true);
  });
  it("closes sockets with 4004 during idempotent shutdown", async () => {
    const vncSocket = fakeTcp();
    vi.spyOn(desktop, "connectSessionVncReadOnly").mockResolvedValue(vncSocket);
    const bridge = await start();
    const webSocket = await open(bridge);
    const close = once(webSocket, "close");
    await Promise.all([bridge.close(), bridge.close()]);
    expect((await close)[0]).toBe(4004);
    expect(vncSocket.destroy).toHaveBeenCalled();
  });
});

describe("bridge supervision", () => {
  it.each(["stopped", "deleted", "replaced"])(
    "exits when the session is %s",
    async (reason) => {
      vi.spyOn(desktop, "connectSessionVncReadOnly").mockResolvedValue(
        fakeTcp(),
      );
      const bridge = await start();
      const webSocket = await open(bridge);
      const close = once(webSocket, "close");
      if (reason === "deleted") {
        await destroySessionRecord(sessionId, registryEnv);
      } else if (reason === "stopped") {
        await updateSession(sessionId, { status: "stopped" }, registryEnv);
      } else {
        await updateSession(
          sessionId,
          { desktop: { display: ":991", viewerBridgePid: 99999999 } },
          registryEnv,
        );
      }
      expect((await close)[0]).toBe(4004);
      await vi.waitFor(async () =>
        expect(await closedPort(bridge.port)).toBe(true),
      );
    },
  );
  it("exits after idle time and counts requests and connected peers as activity", async () => {
    vi.spyOn(desktop, "connectSessionVncReadOnly").mockResolvedValue(fakeTcp());
    const bridge = await start({ idleMs: 80 });
    const webSocket = await open(bridge);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(webSocket.readyState).toBe(WebSocket.OPEN);
    webSocket.close();
    await once(webSocket, "close");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const response = await fetch(`http://127.0.0.1:${bridge.port}/unknown`);
    expect(response.status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(await closedPort(bridge.port)).toBe(false);
    await vi.waitFor(async () =>
      expect(await closedPort(bridge.port)).toBe(true),
    );
  });
  it.each(["SIGTERM", "SIGINT"] as const)(
    "closes on %s without changing the host session",
    async (signal) => {
      const bridge = await start();
      process.emit(signal, signal);
      await vi.waitFor(async () =>
        expect(await closedPort(bridge.port)).toBe(true),
      );
    },
  );
  it("gives daemon registration a bounded startup grace", async () => {
    await updateSession(
      sessionId,
      { desktop: { display: ":991" } },
      registryEnv,
    );
    const bridge = await start({ startupGraceMs: 20 });
    await vi.waitFor(async () =>
      expect(await closedPort(bridge.port)).toBe(true),
    );
  });
});

async function daemonEntry(
  kind: "ready" | "hang" | "exit" = "ready",
): Promise<string> {
  const entry = path.join(testRoot, "daemon.cjs");
  const viewer = desktop.sessionViewerDir(sessionId, registryEnv);
  await fs.writeFile(
    entry,
    `const fileSystem = require('node:fs');
const viewerDirectory = ${JSON.stringify(viewer)};
if (${JSON.stringify(kind)} === 'exit') {
  process.exit(1);
}
if (${JSON.stringify(kind)} === 'ready') {
  const stat = fileSystem.readFileSync('/proc/' + process.pid + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/);
  const startTicks = Number(fields[19]);
  const temporaryPath = viewerDirectory + '/.ready-' + process.pid;
  fileSystem.writeFileSync(temporaryPath, JSON.stringify({
    pid: process.pid,
    startTicks,
    port: 45678,
  }), { mode: 0o600 });
  fileSystem.renameSync(temporaryPath, viewerDirectory + '/bridge.json');
}
setInterval(() => {}, 1000);
`,
  );
  return entry;
}

describe("detached bridge daemon", () => {
  it("runs the built hidden command with bundled assets and stops its detached process", async () => {
    await ensureCliBuilt();
    await fs.copyFile(
      path.join(process.cwd(), "packages/cli/package.json"),
      path.join(testRoot, "package.json"),
    );
    const cliDir = path.join(testRoot, "cli");
    await fs.cp(path.join(process.cwd(), "packages/cli/dist"), cliDir, {
      recursive: true,
    });
    await fs.symlink(
      path.join(process.cwd(), "packages/cli/node_modules"),
      path.join(cliDir, "node_modules"),
    );
    await fs.cp(
      path.join(process.cwd(), "packages/cli/src/viewer/page"),
      path.join(cliDir, "viewer/page"),
      { recursive: true },
    );
    const require = createRequire(new URL("../package.json", import.meta.url));
    const novnc = path.dirname(path.dirname(require.resolve("@novnc/novnc")));
    for (const name of ["core", "vendor"]) {
      await fs.cp(
        path.join(novnc, name),
        path.join(cliDir, "viewer/novnc", name),
        { recursive: true },
      );
    }
    await updateSession(
      sessionId,
      { desktop: { display: ":991" } },
      registryEnv,
    );
    let bridge: Awaited<ReturnType<typeof ensureViewerBridge>>;
    try {
      bridge = await ensureViewerBridge(sessionId, {
        registryEnv: registryEnv,
        _cliEntry: path.join(cliDir, "pickforge-lab.js"),
      });
    } catch (error) {
      throw new Error(
        await fs.readFile(
          path.join(testRoot, "sessions", sessionId, "viewer-bridge.log"),
          "utf8",
        ),
        { cause: error },
      );
    }
    const identity = readProcessIdentity(bridge.pid)!;
    owned.push(identity);
    const response = await fetch(
      `http://127.0.0.1:${bridge.port}/viewer/${"a".repeat(32)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const webSocket = new WebSocket(
      `ws://127.0.0.1:${bridge.port}/websockify?token=${bridge.token}`,
      { headers: { Origin: `http://127.0.0.1:${bridge.port}` } },
    );
    webSocket.on("error", () => {});
    clients.push(webSocket);
    const close = once(webSocket, "close");
    await once(webSocket, "open");
    expect((await close)[0]).toBe(4001);
    await stopProcessGroupVerified(identity, { timeoutMs: 1000 });
    expect(identityIsAlive(identity.pid, identity.startTicks)).toBe(false);
    expect(
      await fs.readFile(
        path.join(testRoot, "sessions", sessionId, "viewer-bridge.log"),
        "utf8",
      ),
    ).toBe("");
  }, 300000);
  it("starts, verifies, records and reuses a daemon without exposing its token in argv", async () => {
    await updateSession(
      sessionId,
      { desktop: { display: ":991" } },
      registryEnv,
    );
    const entry = await daemonEntry();
    const first = await ensureViewerBridge(sessionId, {
      registryEnv: registryEnv,
      _cliEntry: entry,
    });
    const identity = readProcessIdentity(first.pid)!;
    owned.push(identity);
    expect(first.reused).toBe(false);
    expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
    const second = await ensureViewerBridge(sessionId, {
      registryEnv: registryEnv,
      _cliEntry: entry,
    });
    expect(second).toEqual({ ...first, reused: true });
    expect((await getSession(sessionId, registryEnv))?.desktop).toMatchObject({
      viewerBridgePid: first.pid,
      viewerBridgePort: first.port,
      viewerBridgeStartTimeTicks: identity.startTicks,
    });
    const argv = await fs.readFile(`/proc/${first.pid}/cmdline`, "utf8");
    expect(argv).not.toContain(first.token);
    expect(argv.split("\0").slice(1, -1)).toEqual([
      entry,
      "internal",
      "viewer-bridge",
      "--session",
      sessionId,
    ]);
    const tokenFile = path.join(
      desktop.sessionViewerDir(sessionId, registryEnv),
      "token",
    );
    expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(tokenFile, "utf8")).toBe(first.token);
    expect(
      (
        await fs.stat(
          path.join(
            desktop.sessionViewerDir(sessionId, registryEnv),
            "bridge.json",
          ),
        )
      ).mode & 0o777,
    ).toBe(0o600);
    expect(
      await desktop.stopSessionViewer(
        sessionId,
        (await getSession(sessionId, registryEnv))?.desktop,
        registryEnv,
      ),
    ).toEqual([]);
    expect(identityIsAlive(first.pid, identity.startTicks)).toBe(false);
  });
  it("serializes simultaneous starts and rotates the capability on restart", async () => {
    await updateSession(
      sessionId,
      { desktop: { display: ":991" } },
      registryEnv,
    );
    const entry = await daemonEntry();
    const [first, second] = await Promise.all([
      ensureViewerBridge(sessionId, {
        registryEnv: registryEnv,
        _cliEntry: entry,
      }),
      ensureViewerBridge(sessionId, {
        registryEnv: registryEnv,
        _cliEntry: entry,
      }),
    ]);
    expect(first.pid).toBe(second.pid);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    const identity = readProcessIdentity(first.pid)!;
    owned.push(identity);
    await stopProcessGroupVerified(identity);
    const next = await ensureViewerBridge(sessionId, {
      registryEnv: registryEnv,
      _cliEntry: entry,
    });
    owned.push(readProcessIdentity(next.pid)!);
    expect(next.reused).toBe(false);
    expect(next.token).not.toBe(first.token);
  });
  it("restarts an owned bridge with a missing token and refuses a token symlink", async () => {
    await updateSession(
      sessionId,
      { desktop: { display: ":991" } },
      registryEnv,
    );
    const entry = await daemonEntry();
    const first = await ensureViewerBridge(sessionId, {
      registryEnv: registryEnv,
      _cliEntry: entry,
    });
    const identity = readProcessIdentity(first.pid)!;
    owned.push(identity);
    const tokenFile = path.join(
      desktop.sessionViewerDir(sessionId, registryEnv),
      "token",
    );
    await fs.unlink(tokenFile);
    const next = await ensureViewerBridge(sessionId, {
      registryEnv: registryEnv,
      _cliEntry: entry,
    });
    owned.push(readProcessIdentity(next.pid)!);
    expect(next.token).not.toBe(first.token);
    expect(identityIsAlive(identity.pid, identity.startTicks)).toBe(false);
    await fs.unlink(tokenFile);
    await fs.symlink(path.join(testRoot, "foreign"), tokenFile);
    await expect(
      ensureViewerBridge(sessionId, {
        registryEnv: registryEnv,
        _cliEntry: entry,
      }),
    ).rejects.toThrow();
    await expect(fs.lstat(path.join(testRoot, "foreign"))).rejects.toThrow();
  });
  it.each(["hang", "exit"] as const)(
    "cleans failed %s startups without recording a ready bridge",
    async (kind) => {
      await updateSession(
        sessionId,
        { desktop: { display: ":991" } },
        registryEnv,
      );
      await expect(
        ensureViewerBridge(sessionId, {
          registryEnv: registryEnv,
          _cliEntry: await daemonEntry(kind),
          _readyMs: 100,
        }),
      ).rejects.toThrow();
      expect(
        (await getSession(sessionId, registryEnv))?.desktop?.viewerBridgePid,
      ).toBeUndefined();
    },
  );
  it("rejects a stopped session and exposes the hidden command without its capability", async () => {
    await expect(
      ensureViewerBridge("../escape", { registryEnv: registryEnv }),
    ).rejects.toThrow("Invalid session id");
    await updateSession(sessionId, { status: "stopped" }, registryEnv);
    await expect(
      ensureViewerBridge(sessionId, {
        registryEnv: registryEnv,
        _cliEntry: await daemonEntry(),
      }),
    ).rejects.toThrow();
    const program = buildProgram();
    const internal = program.commands.find(
      (command) => command.name() === "internal",
    )!;
    expect(
      internal.commands
        .find((command) => command.name() === "viewer-bridge")
        ?.options.map((option) => option.long),
    ).toEqual(["--session"]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // Use an invalid id so this command cannot touch the user's registry.
    expect(await runViewerBridge({ session: "invalid" })).toBe(1);
    expect(log).toHaveBeenCalledWith("Viewer bridge startup failed");
  });
});
