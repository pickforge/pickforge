import http from "node:http";
import type { Duplex } from "node:stream";
import type net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { getSession, readProcessIdentity } from "@pickforge/lab-core";
import {
  connectSessionVncReadOnly,
  readViewerLaunchRecord,
  ViewerVncUnavailableError,
  VIEWER_LAUNCH_ID_PATTERN,
  withViewerDir,
  writeViewerPrivateFile,
  type ViewerLaunchRecord,
} from "@pickforge/lab-desktop-linux";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { resolveViewerAssets, type ViewerAssetDirs } from "./assets.js";
import { applyHyprlandWindowMode } from "./hyprland.js";
import {
  VIEWER_HOST,
  VIEWER_CLOSE_CODES,
  VIEWER_STATUS_API_PATH,
  type ViewerWindowMode,
} from "./contract.js";

const BUFFER_LIMIT = 256 * 1024;
const HARD_BUFFER_LIMIT = BUFFER_LIMIT + 64 * 1024;

export interface ViewerBridgeOptions {
  sessionId: string;
  token: string;
  registryEnv?: NodeJS.ProcessEnv;
  assets?: ViewerAssetDirs;
  windowController?: (
    launch: ViewerLaunchRecord,
    mode: ViewerWindowMode,
  ) => Promise<boolean>;
  /** Short intervals let tests exercise lifecycle deadlines. */
  idleMs?: number;
  pollMs?: number;
  pingMs?: number;
  connectMs?: number;
  startupGraceMs?: number;
  handshakeMs?: number;
}

export interface ViewerBridge {
  port: number;
  close(): Promise<void>;
}

interface BridgeActivity {
  startedAt: number;
  lastActivity: number;
  pending: Set<Promise<void>>;
}

function trackBridgeWork(work: Promise<void>, activity: BridgeActivity): void {
  activity.pending.add(work);
  void work.then(
    () => activity.pending.delete(work),
    () => activity.pending.delete(work),
  );
}

function headerValues(request: http.IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (
    let headerIndex = 0;
    headerIndex < request.rawHeaders.length;
    headerIndex += 2
  ) {
    if (request.rawHeaders[headerIndex]?.toLowerCase() === name) {
      values.push(request.rawHeaders[headerIndex + 1]!);
    }
  }
  return values;
}

function exactHeader(
  request: http.IncomingMessage,
  name: string,
  expected: string,
): boolean {
  const values = headerValues(request, name);
  return values.length === 1 && values[0] === expected;
}

function allowedRequest(
  request: http.IncomingMessage,
  port: number,
  requireOrigin: boolean,
): boolean {
  if (!exactHeader(request, "host", `${VIEWER_HOST}:${port}`)) {
    return false;
  }
  const origins = headerValues(request, "origin");
  return origins.length === 0
    ? !requireOrigin
    : origins.length === 1 && origins[0] === `http://${VIEWER_HOST}:${port}`;
}

function tokenMatches(candidate: string | undefined, token: string): boolean {
  if (candidate === undefined) {
    return false;
  }
  const candidateBuffer = Buffer.from(candidate);
  const tokenBuffer = Buffer.from(token);
  return (
    candidateBuffer.length === tokenBuffer.length &&
    timingSafeEqual(candidateBuffer, tokenBuffer)
  );
}

/** Build the security headers for every bridge response. */
export function viewerResponseHeaders(port: number): Record<string, string> {
  return {
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; " +
      `connect-src 'self' ws://${VIEWER_HOST}:${port}; object-src 'none'; base-uri 'none'; ` +
      "frame-ancestors 'none'; form-action 'none'; worker-src 'none'",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Type": "application/json; charset=utf-8",
  };
}

interface Asset {
  data: Buffer;
  type: string;
}

async function loadAsset(
  file: string,
  rootDirectory: string,
  type: string,
): Promise<Asset | undefined> {
  const realPath = await fs.realpath(file);
  if (
    !realPath.startsWith(`${rootDirectory}${path.sep}`) ||
    !(await fs.stat(realPath)).isFile()
  ) {
    return undefined;
  }
  return { data: await fs.readFile(realPath), type };
}

async function noVncAssets(
  rootDirectory: string,
  name: string,
  assets: Map<string, Asset>,
): Promise<void> {
  const walk = async (directory: string, relative: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const next = path.join(directory, entry.name);
      const route = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(next, route);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const asset = await loadAsset(
          next,
          rootDirectory,
          "text/javascript; charset=utf-8",
        );
        if (asset) {
          assets.set(`/novnc/${name}${route}`, asset);
        }
      }
    }
  };
  await walk(rootDirectory, "");
}

async function buildAssets(
  assetDirs: ViewerAssetDirs,
): Promise<Map<string, Asset>> {
  const assets = new Map<string, Asset>();
  const pageRoot = await fs.realpath(assetDirs.pageDir);
  for (const [name, type] of [
    ["index.html", "text/html"],
    ["viewer.js", "text/javascript"],
    ["viewer.css", "text/css"],
  ]) {
    const asset = await loadAsset(
      path.join(pageRoot, name!),
      pageRoot,
      `${type}; charset=utf-8`,
    );
    if (asset) {
      assets.set(
        name === "index.html" ? "page" : `/viewer-assets/${name}`,
        asset,
      );
    }
  }
  for (const name of ["core", "vendor"]) {
    const rootDirectory = await fs.realpath(
      path.join(assetDirs.novncDir, name),
    );
    await noVncAssets(rootDirectory, name, assets);
  }
  return assets;
}

function respond(
  response: http.ServerResponse,
  status: number,
  body = "",
): void {
  response.writeHead(status);
  response.end(body);
}

function windowLaunchId(url: string): string | undefined {
  const match = /^\/api\/launches\/([0-9a-f]{32})\/window$/.exec(url);
  return match?.[1];
}

function readMode(
  request: http.IncomingMessage,
): Promise<ViewerWindowMode | undefined> {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      finish();
      request.resume();
      reject(new Error("Body deadline"));
    }, 5_000);
    const finish = (): void => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", error);
    };
    const error = (): void => {
      finish();
      reject(new Error("Body failed"));
    };
    const data = (chunk: Buffer): void => {
      length += chunk.length;
      if (length > 1024) {
        finish();
        request.resume();
        reject(new Error("Body too large"));
      } else {
        chunks.push(chunk);
      }
    };
    const end = (): void => {
      finish();
      try {
        const body: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (
          body === null ||
          typeof body !== "object" ||
          Object.keys(body).length !== 1
        ) {
          resolve(undefined);
          return;
        }
        const mode = (
          body as {
            mode?: unknown;
          }
        ).mode;
        resolve(mode === "thumbnail" || mode === "expanded" ? mode : undefined);
      } catch {
        resolve(undefined);
      }
    };
    request.on("data", data);
    request.once("end", end);
    request.once("error", error);
  });
}

function authorizedRequest(
  request: http.IncomingMessage,
  token: string,
): boolean {
  const authorization = headerValues(request, "authorization");
  if (authorization.length !== 1 || !authorization[0]?.startsWith("Bearer ")) {
    return false;
  }
  return tokenMatches(authorization[0].slice(7), token);
}

async function windowRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  launchId: string,
  options: ViewerBridgeOptions,
): Promise<void> {
  if (!authorizedRequest(request, options.token)) {
    respond(response, 401);
    return;
  }
  if (!exactHeader(request, "content-type", "application/json")) {
    respond(response, 415);
    return;
  }
  if (Number(request.headers["content-length"]) > 1024) {
    respond(response, 413);
    request.resume();
    return;
  }
  let mode: ViewerWindowMode | undefined;
  try {
    mode = await readMode(request);
  } catch {
    respond(response, 413);
    return;
  }
  if (mode === undefined) {
    respond(response, 400);
    return;
  }
  const launch = await readViewerLaunchRecord(
    options.sessionId,
    launchId,
    options.registryEnv,
  );
  if (launch === undefined || launch.sessionId !== options.sessionId) {
    respond(response, 404);
    return;
  }
  const applied = await (options.windowController ?? applyHyprlandWindowMode)(
    launch,
    mode,
  );
  respond(response, 200, JSON.stringify({ applied, size: launch[mode] }));
}

async function httpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  port: number,
  options: ViewerBridgeOptions,
  assets: Map<string, Asset>,
): Promise<void> {
  for (const [name, value] of Object.entries(viewerResponseHeaders(port))) {
    response.setHeader(name, value);
  }
  const url = request.url ?? "";
  const requireOrigin =
    request.method === "POST" && url !== VIEWER_STATUS_API_PATH;
  if (!allowedRequest(request, port, requireOrigin)) {
    respond(response, 403);
    return;
  }
  if (url === VIEWER_STATUS_API_PATH) {
    statusRequest(request, response, options.token);
    return;
  }
  const launchId = windowLaunchId(url);
  if (launchId !== undefined) {
    if (request.method !== "POST") {
      respond(response, 405);
      return;
    }
    await windowRequest(request, response, launchId, options);
    return;
  }
  const page = /^\/viewer\/([^/]+)$/.exec(url);
  const asset =
    page && VIEWER_LAUNCH_ID_PATTERN.test(page[1]!)
      ? assets.get("page")
      : assets.get(url);
  if (asset === undefined) {
    respond(response, 404);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    respond(response, 405);
    return;
  }
  response.setHeader("Content-Type", asset.type);
  response.setHeader("Content-Length", asset.data.length);
  response.writeHead(200);
  response.end(request.method === "HEAD" ? undefined : asset.data);
}

function statusRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  token: string,
): void {
  if (request.method !== "GET") {
    respond(response, 405);
    return;
  }
  respond(response, authorizedRequest(request, token) ? 204 : 401);
}

function rejectUpgrade(socket: Duplex, status: number, port: number): void {
  const headers = Object.entries(viewerResponseHeaders(port))
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  socket.end(
    `HTTP/1.1 ${status} Rejected\r\n${headers}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  );
}

function validUpgrade(
  request: http.IncomingMessage,
  port: number,
  token: string,
): boolean {
  if (
    !allowedRequest(request, port, true) ||
    request.method !== "GET" ||
    !request.url?.startsWith("/websockify?")
  ) {
    return false;
  }
  try {
    const url = new URL(request.url, `http://${VIEWER_HOST}:${port}`);
    return (
      url.pathname === "/websockify" &&
      url.searchParams.getAll("token").length === 1 &&
      tokenMatches(url.searchParams.get("token") ?? undefined, token)
    );
  } catch {
    return false;
  }
}

function closeCode(error: unknown): number {
  if (!(error instanceof ViewerVncUnavailableError)) {
    return VIEWER_CLOSE_CODES.vncUnavailable;
  }
  return error.reason === "writable"
    ? VIEWER_CLOSE_CODES.vncWritable
    : error.reason === "session-ended"
      ? VIEWER_CLOSE_CODES.sessionEnded
      : VIEWER_CLOSE_CODES.vncUnavailable;
}

function frameBuffer(data: RawData): Buffer {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.from(data as ArrayBuffer);
}

function relayVncData(
  webSocket: WebSocket,
  vncSocket: net.Socket,
  stop: (code?: number) => void,
  hasEnded: () => boolean,
): void {
  vncSocket.on("data", (data: Buffer) => {
    if (webSocket.readyState !== WebSocket.OPEN) {
      stop();
      return;
    }
    if (webSocket.bufferedAmount + data.length > HARD_BUFFER_LIMIT) {
      stop(1009);
      return;
    }
    webSocket.send(data, { binary: true }, (error) => {
      if (error) {
        stop();
      } else if (!hasEnded() && webSocket.bufferedAmount < BUFFER_LIMIT) {
        vncSocket.resume();
      }
    });
    if (webSocket.bufferedAmount >= BUFFER_LIMIT) {
      vncSocket.pause();
    }
  });
}

function relayWebSocket(
  webSocket: WebSocket,
  options: ViewerBridgeOptions,
): Promise<void> {
  let vncSocket: net.Socket | undefined;
  let ended = false;
  let pong = true;
  let pendingBytes = 0;
  const pending: Buffer[] = [];
  const stop = (code?: number): void => {
    if (ended) {
      return;
    }
    ended = true;
    clearInterval(heartbeat);
    clearTimeout(deadline);
    vncSocket?.destroy();
    if (code !== undefined) {
      webSocket.close(code);
      const timer = setTimeout(() => webSocket.terminate(), 500);
      timer.unref();
      webSocket.once("close", () => clearTimeout(timer));
    } else {
      webSocket.terminate();
    }
  };
  const heartbeat = setInterval(() => {
    if (!pong) {
      stop();
      return;
    }
    pong = false;
    webSocket.ping();
  }, options.pingMs ?? 15_000);
  const deadline = setTimeout(
    () => stop(VIEWER_CLOSE_CODES.vncUnavailable),
    options.connectMs ?? 2_500,
  );
  webSocket.on("pong", () => {
    pong = true;
  });
  webSocket.on("error", () => stop());
  webSocket.on("close", () => stop());
  webSocket.on("message", (data, binary) => {
    if (!binary) {
      stop(1003);
      return;
    }
    const buffer = frameBuffer(data);
    if (vncSocket === undefined) {
      pendingBytes += buffer.length;
      if (pendingBytes > 64 * 1024) {
        stop(1009);
        return;
      }
      pending.push(buffer);
      return;
    }
    if (vncSocket.writableLength + buffer.length > HARD_BUFFER_LIMIT) {
      stop(1009);
      return;
    }
    if (!vncSocket.write(buffer)) {
      webSocket.pause();
    }
  });
  webSocket.pause();
  return connectSessionVncReadOnly(options.sessionId, options.registryEnv)
    .then((socket) => {
      if (ended) {
        socket.destroy();
        return;
      }
      clearTimeout(deadline);
      vncSocket = socket;
      vncSocket.on("error", () => stop());
      vncSocket.on("close", () => stop());
      vncSocket.on("end", () => stop());
      vncSocket.on("drain", () => webSocket.resume());
      relayVncData(webSocket, vncSocket, stop, () => ended);
      for (const buffer of pending) {
        if (!vncSocket.write(buffer)) {
          webSocket.pause();
        }
      }
      pending.length = 0;
      if (vncSocket.writableLength < vncSocket.writableHighWaterMark) {
        webSocket.resume();
      }
    })
    .catch((error) => stop(closeCode(error)));
}

function installUpgrades(
  server: http.Server,
  webSocketServer: WebSocketServer,
  port: number,
  options: ViewerBridgeOptions,
  activity: BridgeActivity,
  isClosing: () => boolean,
): void {
  webSocketServer.on("headers", (headers) => {
    for (const [name, value] of Object.entries(viewerResponseHeaders(port))) {
      headers.push(`${name}: ${value}`);
    }
  });
  server.on("upgrade", (request, socket, head) => {
    activity.lastActivity = Date.now();
    socket.on("error", () => socket.destroy());
    if (!validUpgrade(request, port, options.token)) {
      rejectUpgrade(socket, 403, port);
      return;
    }
    if (isClosing() || webSocketServer.clients.size >= 8) {
      rejectUpgrade(socket, 503, port);
      return;
    }
    // ws parser rejections use the same response boundary and security headers.
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
      trackBridgeWork(relayWebSocket(webSocket, options), activity);
    });
  });
  webSocketServer.on("connection", (webSocket: WebSocket) => {
    webSocket.once("close", () => {
      activity.lastActivity = Date.now();
    });
  });
  webSocketServer.on("wsClientError", (_error, socket) =>
    rejectUpgrade(socket, 400, port),
  );
}

function installHandshakeDeadline(server: http.Server, timeout: number): void {
  const timers = new WeakMap<Duplex, NodeJS.Timeout>();
  server.on("connection", (socket) => {
    const timer = setTimeout(() => socket.destroy(), timeout);
    timers.set(socket, timer);
    socket.once("close", () => clearTimeout(timer));
  });
  const complete = (request: http.IncomingMessage): void => {
    clearTimeout(timers.get(request.socket));
  };
  server.on("request", complete);
  server.on("upgrade", complete);
  server.on("checkContinue", complete);
  server.on("checkExpectation", complete);
  server.on("connect", complete);
}

function installOtherRequests(
  server: http.Server,
  getPort: () => number,
): void {
  const expectation = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void => {
    const port = getPort();
    for (const [name, value] of Object.entries(viewerResponseHeaders(port))) {
      response.setHeader(name, value);
    }
    respond(
      response,
      allowedRequest(request, port, request.method === "POST") ? 417 : 403,
    );
  };
  server.on("checkContinue", expectation);
  server.on("checkExpectation", expectation);
  server.on("connect", (request, socket) => {
    socket.on("error", () => socket.destroy());
    rejectUpgrade(
      socket,
      allowedRequest(request, getPort(), false) ? 404 : 403,
      getPort(),
    );
  });
}

function closeBridgeServers(
  server: http.Server,
  webSocketServer: WebSocketServer,
  code: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    for (const webSocket of webSocketServer.clients) {
      webSocket.close(code);
    }
    const timer = setTimeout(() => {
      for (const webSocket of webSocketServer.clients) {
        webSocket.terminate();
      }
    }, 250);
    const httpClosed = new Promise<void>((done) => server.close(() => done()));
    const wsClosed = new Promise<void>((done) =>
      webSocketServer.close(() => done()),
    );
    server.closeIdleConnections();
    const force = setTimeout(() => server.closeAllConnections(), 500);
    force.unref();
    void Promise.all([httpClosed, wsClosed]).then(() => {
      clearTimeout(timer);
      clearTimeout(force);
      resolve();
    });
  });
}

function superviseViewerBridge(
  server: http.Server,
  webSocketServer: WebSocketServer,
  options: ViewerBridgeOptions,
  activity: BridgeActivity,
): { close: (code?: number) => Promise<void>; isClosing: () => boolean } {
  let registered = false;
  let closing: Promise<void> | undefined;
  const close = (
    code: number = VIEWER_CLOSE_CODES.shuttingDown,
  ): Promise<void> => {
    if (closing === undefined) {
      clearInterval(poll);
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.off(signal, onSignal);
      }
      closing = closeBridgeServers(server, webSocketServer, code).then(
        async () => {
          // No new requests or upgrades can start after both servers have closed.
          // Pending connects include the VNC lock's release and sentinel cleanup.
          await Promise.allSettled(activity.pending);
        },
      );
    }
    return closing;
  };
  const onSignal = (): void => {
    void close();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, onSignal);
  }
  let checking = false;
  const poll = setInterval(() => {
    if (checking) {
      return;
    }
    checking = true;
    void getSession(options.sessionId, options.registryEnv)
      .then((record) => {
        if (record?.status !== "running") {
          void close(VIEWER_CLOSE_CODES.sessionEnded);
          return;
        }
        const recordedPid = record?.desktop?.viewerBridgePid;
        if (recordedPid === process.pid) {
          registered = true;
        }
        const startupExpired =
          Date.now() - activity.startedAt > (options.startupGraceMs ?? 10_000);
        const expectedRegistration =
          registered || recordedPid !== undefined || startupExpired;
        const displaced = recordedPid !== process.pid && expectedRegistration;
        const idle =
          webSocketServer.clients.size === 0 &&
          Date.now() - activity.lastActivity > (options.idleMs ?? 600_000);
        if (displaced || idle) {
          void close();
        }
      })
      .catch(() => {
        void close();
      })
      .finally(() => {
        checking = false;
      });
  }, options.pollMs ?? 1_000);
  return { close, isClosing: () => closing !== undefined };
}

/** Serve private viewer requests and relay the session's read-only VNC connection. */
export async function startViewerBridge(
  options: ViewerBridgeOptions,
): Promise<ViewerBridge> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.token)) {
    throw new Error("Invalid viewer capability");
  }
  const assets = await buildAssets(options.assets ?? resolveViewerAssets());
  let port = 0;
  const activity: BridgeActivity = {
    startedAt: Date.now(),
    lastActivity: Date.now(),
    pending: new Set(),
  };
  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
    handleProtocols: (protocols) =>
      protocols.has("binary") ? "binary" : false,
  });
  const server = http.createServer(
    { requireHostHeader: false },
    (request, response) => {
      activity.lastActivity = Date.now();
      const work = httpRequest(request, response, port, options, assets).catch(
        () => {
          if (!response.headersSent) {
            respond(response, 500);
          } else {
            response.destroy();
          }
        },
      );
      trackBridgeWork(work, activity);
    },
  );
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.timeout = 5_000;
  installHandshakeDeadline(server, options.handshakeMs ?? 5_000);
  installOtherRequests(server, () => port);
  server.on("clientError", (_error, socket) => {
    socket.on("error", () => socket.destroy());
    if (!socket.writableEnded) {
      rejectUpgrade(socket, 400, port);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, VIEWER_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as net.AddressInfo).port;
  const { close, isClosing } = superviseViewerBridge(
    server,
    webSocketServer,
    options,
    activity,
  );
  installUpgrades(server, webSocketServer, port, options, activity, isClosing);
  try {
    const identity = readProcessIdentity(process.pid);
    if (!identity) {
      throw new Error("Bridge identity unavailable");
    }
    await withViewerDir(
      options.sessionId,
      options.registryEnv ?? process.env,
      false,
      (directory) =>
        writeViewerPrivateFile(
          directory,
          "bridge.json",
          JSON.stringify({
            pid: identity.pid,
            startTicks: identity.startTicks,
            port,
          }),
        ),
    );
  } catch (error) {
    await close();
    throw error;
  }
  return { port, close };
}
