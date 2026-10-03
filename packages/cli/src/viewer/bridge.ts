import http from "node:http";
import type { Duplex } from "node:stream";
import type net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { getSession, readProcessIdentity } from "@pickforge/lab-core";
import {
  connectSessionVncReadOnly, readViewerLaunchRecord, ViewerVncUnavailableError,
  VIEWER_LAUNCH_ID_PATTERN, withViewerDir, writeViewerPrivateFile,
  type ViewerLaunchRecord,
} from "@pickforge/lab-desktop-linux";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { resolveViewerAssets, type ViewerAssetDirs } from "./assets.js";
import { applyHyprlandWindowMode } from "./hyprland.js";
import { VIEWER_HOST, VIEWER_CLOSE_CODES, type ViewerWindowMode } from "./contract.js";

const BUFFER_LIMIT = 256 * 1024;
const HARD_BUFFER_LIMIT = BUFFER_LIMIT + 64 * 1024;

export interface ViewerBridgeOptions {
  sessionId: string;
  token: string;
  registryEnv?: NodeJS.ProcessEnv;
  assets?: ViewerAssetDirs;
  windowController?: (launch: ViewerLaunchRecord, mode: ViewerWindowMode) => Promise<boolean>;
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

function headerValues(req: http.IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1]!);
  }
  return values;
}

function exactHeader(req: http.IncomingMessage, name: string, expected: string): boolean {
  const values = headerValues(req, name);
  return values.length === 1 && values[0] === expected;
}

function allowedRequest(req: http.IncomingMessage, port: number, requireOrigin: boolean): boolean {
  if (!exactHeader(req, "host", `${VIEWER_HOST}:${port}`)) return false;
  const origins = headerValues(req, "origin");
  return origins.length === 0 ? !requireOrigin :
    origins.length === 1 && origins[0] === `http://${VIEWER_HOST}:${port}`;
}

function tokenMatches(candidate: string | undefined, token: string): boolean {
  if (candidate === undefined) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function viewerResponseHeaders(port: number): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; " +
      `connect-src 'self' ws://${VIEWER_HOST}:${port}; object-src 'none'; base-uri 'none'; ` +
      "frame-ancestors 'none'; form-action 'none'; worker-src 'none'",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Type": "application/json; charset=utf-8",
  };
}

interface Asset { data: Buffer; type: string }

async function loadAsset(file: string, root: string, type: string): Promise<Asset | undefined> {
  const real = await fs.realpath(file);
  if (!real.startsWith(`${root}${path.sep}`) || !(await fs.stat(real)).isFile()) return undefined;
  return { data: await fs.readFile(real), type };
}

async function noVncAssets(root: string, name: string, files: Map<string, Asset>): Promise<void> {
  const walk = async (dir: string, relative: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      const route = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(next, route);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const asset = await loadAsset(next, root, "text/javascript; charset=utf-8");
        if (asset) files.set(`/novnc/${name}${route}`, asset);
      }
    }
  };
  await walk(root, "");
}

async function buildAssets(dirs: ViewerAssetDirs): Promise<Map<string, Asset>> {
  const files = new Map<string, Asset>();
  const pageRoot = await fs.realpath(dirs.pageDir);
  for (const [name, type] of [["index.html", "text/html"], ["viewer.js", "text/javascript"], ["viewer.css", "text/css"]]) {
    const asset = await loadAsset(path.join(pageRoot, name!), pageRoot, `${type}; charset=utf-8`);
    if (asset) files.set(name === "index.html" ? "page" : `/viewer-assets/${name}`, asset);
  }
  for (const name of ["core", "vendor"]) {
    const root = await fs.realpath(path.join(dirs.novncDir, name));
    await noVncAssets(root, name, files);
  }
  return files;
}

function respond(res: http.ServerResponse, status: number, body = ""): void {
  res.writeHead(status);
  res.end(body);
}

function windowLaunchId(url: string): string | undefined {
  const match = /^\/api\/launches\/([0-9a-f]{32})\/window$/.exec(url);
  return match?.[1];
}

function readMode(req: http.IncomingMessage): Promise<ViewerWindowMode | undefined> {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { finish(); req.resume(); reject(new Error("Body deadline")); }, 5_000);
    const finish = (): void => { clearTimeout(timer); req.off("data", data); req.off("end", end); req.off("error", error); };
    const error = (): void => { finish(); reject(new Error("Body failed")); };
    const data = (chunk: Buffer): void => {
      length += chunk.length;
      if (length > 1024) { finish(); req.resume(); reject(new Error("Body too large")); }
      else chunks.push(chunk);
    };
    const end = (): void => {
      finish();
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body === null || typeof body !== "object" || Object.keys(body).length !== 1) { resolve(undefined); return; }
        const mode = (body as { mode?: unknown }).mode;
        resolve(mode === "thumbnail" || mode === "expanded" ? mode : undefined);
      } catch { resolve(undefined); }
    };
    req.on("data", data); req.once("end", end); req.once("error", error);
  });
}

async function windowRequest(req: http.IncomingMessage, res: http.ServerResponse, launchId: string, opts: ViewerBridgeOptions): Promise<void> {
  const authorization = headerValues(req, "authorization");
  if (authorization.length !== 1 || !tokenMatches(authorization[0]?.startsWith("Bearer ") ? authorization[0].slice(7) : undefined, opts.token)) {
    respond(res, 401); return;
  }
  if (!exactHeader(req, "content-type", "application/json")) { respond(res, 415); return; }
  if (Number(req.headers["content-length"]) > 1024) { respond(res, 413); req.resume(); return; }
  let mode: ViewerWindowMode | undefined;
  try { mode = await readMode(req); } catch { respond(res, 413); return; }
  if (mode === undefined) { respond(res, 400); return; }
  const launch = await readViewerLaunchRecord(opts.sessionId, launchId, opts.registryEnv);
  if (launch === undefined || launch.sessionId !== opts.sessionId) { respond(res, 404); return; }
  const applied = await (opts.windowController ?? applyHyprlandWindowMode)(launch, mode);
  respond(res, 200, JSON.stringify({ applied, size: launch[mode] }));
}

async function httpRequest(req: http.IncomingMessage, res: http.ServerResponse, port: number, opts: ViewerBridgeOptions, files: Map<string, Asset>): Promise<void> {
  for (const [name, value] of Object.entries(viewerResponseHeaders(port))) res.setHeader(name, value);
  if (!allowedRequest(req, port, req.method === "POST")) { respond(res, 403); return; }
  const url = req.url ?? "";
  const launchId = windowLaunchId(url);
  if (launchId !== undefined) {
    if (req.method !== "POST") { respond(res, 405); return; }
    await windowRequest(req, res, launchId, opts); return;
  }
  const page = /^\/viewer\/([^/]+)$/.exec(url);
  const asset = page && VIEWER_LAUNCH_ID_PATTERN.test(page[1]!) ? files.get("page") : files.get(url);
  if (asset === undefined) { respond(res, 404); return; }
  if (req.method !== "GET" && req.method !== "HEAD") { respond(res, 405); return; }
  res.setHeader("Content-Type", asset.type);
  res.setHeader("Content-Length", asset.data.length);
  res.writeHead(200);
  res.end(req.method === "HEAD" ? undefined : asset.data);
}

function rejectUpgrade(socket: Duplex, status: number, port: number): void {
  const headers = Object.entries(viewerResponseHeaders(port)).map(([name, value]) => `${name}: ${value}`).join("\r\n");
  socket.end(`HTTP/1.1 ${status} Rejected\r\n${headers}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

function validUpgrade(req: http.IncomingMessage, port: number, token: string): boolean {
  if (!allowedRequest(req, port, true) || req.method !== "GET" || !req.url?.startsWith("/websockify?")) return false;
  try {
    const url = new URL(req.url, `http://${VIEWER_HOST}:${port}`);
    return url.pathname === "/websockify" && url.searchParams.getAll("token").length === 1 &&
      tokenMatches(url.searchParams.get("token") ?? undefined, token);
  } catch { return false; }
}

function closeCode(error: unknown): number {
  if (!(error instanceof ViewerVncUnavailableError)) return VIEWER_CLOSE_CODES.vncUnavailable;
  return error.reason === "writable" ? VIEWER_CLOSE_CODES.vncWritable :
    error.reason === "session-ended" ? VIEWER_CLOSE_CODES.sessionEnded : VIEWER_CLOSE_CODES.vncUnavailable;
}

function frameBuffer(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
}

function relayWebSocket(ws: WebSocket, opts: ViewerBridgeOptions): void {
  let tcp: net.Socket | undefined;
  let ended = false;
  let pong = true;
  let pendingBytes = 0;
  const pending: Buffer[] = [];
  const stop = (code?: number): void => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat); clearInterval(drain); clearTimeout(deadline);
    tcp?.destroy();
    if (code !== undefined) {
      ws.close(code);
      const timer = setTimeout(() => ws.terminate(), 500); timer.unref();
      ws.once("close", () => clearTimeout(timer));
    } else ws.terminate();
  };
  const heartbeat = setInterval(() => {
    if (!pong) { stop(); return; }
    pong = false; ws.ping();
  }, opts.pingMs ?? 15_000);
  const drain = setInterval(() => { if (ws.bufferedAmount < BUFFER_LIMIT) tcp?.resume(); }, 10);
  const deadline = setTimeout(() => stop(VIEWER_CLOSE_CODES.vncUnavailable), opts.connectMs ?? 2_500);
  ws.on("pong", () => { pong = true; });
  ws.on("error", () => stop()); ws.on("close", () => stop());
  ws.on("message", (data, binary) => {
    if (!binary) { stop(1003); return; }
    const buffer = frameBuffer(data);
    if (tcp === undefined) {
      pendingBytes += buffer.length;
      if (pendingBytes > 64 * 1024) { stop(1009); return; }
      pending.push(buffer); return;
    }
    if (tcp.writableLength + buffer.length > HARD_BUFFER_LIMIT) { stop(1009); return; }
    if (!tcp.write(buffer)) ws.pause();
  });
  ws.pause();
  void connectSessionVncReadOnly(opts.sessionId, opts.registryEnv).then(socket => {
    if (ended) { socket.destroy(); return; }
    clearTimeout(deadline); tcp = socket;
    tcp.on("error", () => stop()); tcp.on("close", () => stop()); tcp.on("end", () => stop());
    tcp.on("drain", () => ws.resume());
    tcp.on("data", (data: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) { stop(); return; }
      if (ws.bufferedAmount + data.length > HARD_BUFFER_LIMIT) { stop(1009); return; }
      ws.send(data, { binary: true }, error => { if (error) stop(); });
      if (ws.bufferedAmount >= BUFFER_LIMIT) tcp?.pause();
    });
    for (const buffer of pending) if (!tcp.write(buffer)) ws.pause();
    pending.length = 0;
    if (tcp.writableLength < tcp.writableHighWaterMark) ws.resume();
  }).catch(error => stop(closeCode(error)));
}

function installUpgrades(server: http.Server, wss: WebSocketServer, port: number, opts: ViewerBridgeOptions, touch: () => void, isClosing: () => boolean): void {
  wss.on("headers", headers => {
    for (const [name, value] of Object.entries(viewerResponseHeaders(port))) headers.push(`${name}: ${value}`);
  });
  server.on("upgrade", (req, socket, head) => {
    touch();
    socket.on("error", () => socket.destroy());
    if (!validUpgrade(req, port, opts.token)) { rejectUpgrade(socket, 403, port); return; }
    if (isClosing() || wss.clients.size >= 8) { rejectUpgrade(socket, 503, port); return; }
    // ws parser rejections use the same response boundary and security headers.
    wss.handleUpgrade(req, socket, head, ws => { wss.emit("connection", ws, req); relayWebSocket(ws, opts); });
  });
  wss.on("connection", (ws: WebSocket) => { ws.once("close", touch); });
  wss.on("wsClientError", (_error, socket) => rejectUpgrade(socket, 400, port));
}

function installHandshakeDeadline(server: http.Server, timeout: number): void {
  const timers = new WeakMap<Duplex, NodeJS.Timeout>();
  server.on("connection", socket => {
    const timer = setTimeout(() => socket.destroy(), timeout);
    timers.set(socket, timer);
    socket.once("close", () => clearTimeout(timer));
  });
  const complete = (req: http.IncomingMessage): void => { clearTimeout(timers.get(req.socket)); };
  server.on("request", complete); server.on("upgrade", complete);
  server.on("checkContinue", complete); server.on("checkExpectation", complete); server.on("connect", complete);
}

function installOtherRequests(server: http.Server, getPort: () => number): void {
  const expectation = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const port = getPort();
    for (const [name, value] of Object.entries(viewerResponseHeaders(port))) res.setHeader(name, value);
    respond(res, allowedRequest(req, port, req.method === "POST") ? 417 : 403);
  };
  server.on("checkContinue", expectation); server.on("checkExpectation", expectation);
  server.on("connect", (req, socket) => {
    socket.on("error", () => socket.destroy());
    rejectUpgrade(socket, allowedRequest(req, getPort(), false) ? 404 : 403, getPort());
  });
}

export async function startViewerBridge(opts: ViewerBridgeOptions): Promise<ViewerBridge> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(opts.token)) throw new Error("Invalid viewer capability");
  const files = await buildAssets(opts.assets ?? resolveViewerAssets());
  let port = 0;
  let lastActivity = Date.now();
  const started = Date.now();
  let registered = false;
  let closing: Promise<void> | undefined;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024,
    handleProtocols: protocols => protocols.has("binary") ? "binary" : false });
  const server = http.createServer({ requireHostHeader: false }, (req, res) => {
    lastActivity = Date.now();
    void httpRequest(req, res, port, opts, files).catch(() => {
      if (!res.headersSent) respond(res, 500); else res.destroy();
    });
  });
  server.headersTimeout = 5_000; server.requestTimeout = 5_000; server.timeout = 5_000;
  installHandshakeDeadline(server, opts.handshakeMs ?? 5_000);
  installOtherRequests(server, () => port);
  server.on("clientError", (_error, socket) => {
    socket.on("error", () => socket.destroy());
    if (!socket.writableEnded) rejectUpgrade(socket, 400, port);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, VIEWER_HOST, () => { server.off("error", reject); resolve(); });
  });
  port = (server.address() as net.AddressInfo).port;
  installUpgrades(server, wss, port, opts, () => { lastActivity = Date.now(); }, () => closing !== undefined);
  const close = (): Promise<void> => {
    closing ??= new Promise<void>(resolve => {
      clearInterval(poll);
      for (const signal of ["SIGTERM", "SIGINT"] as const) process.off(signal, onSignal);
      for (const ws of wss.clients) ws.close(VIEWER_CLOSE_CODES.shuttingDown);
      const timer = setTimeout(() => { for (const ws of wss.clients) ws.terminate(); }, 250);
      const httpClosed = new Promise<void>(done => server.close(() => done()));
      const wsClosed = new Promise<void>(done => wss.close(() => done()));
      server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), 500); force.unref();
      void Promise.all([httpClosed, wsClosed]).then(() => { clearTimeout(timer); clearTimeout(force); resolve(); });
    });
    return closing;
  };
  const onSignal = (): void => { void close(); };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, onSignal);
  let checking = false;
  const poll = setInterval(() => {
    if (checking) return;
    checking = true;
    void getSession(opts.sessionId, opts.registryEnv).then(record => {
      const named = record?.desktop?.viewerBridgePid;
      if (named === process.pid) registered = true;
      const displaced = named !== process.pid && (registered || named !== undefined || Date.now() - started > (opts.startupGraceMs ?? 10_000));
      if (record?.status !== "running" || displaced ||
          (wss.clients.size === 0 && Date.now() - lastActivity > (opts.idleMs ?? 600_000))) void close();
    }).catch(() => { void close(); }).finally(() => { checking = false; });
  }, opts.pollMs ?? 1_000);
  try {
    const identity = readProcessIdentity(process.pid);
    if (!identity) throw new Error("Bridge identity unavailable");
    await withViewerDir(opts.sessionId, opts.registryEnv ?? process.env, false, dir =>
      writeViewerPrivateFile(dir, "bridge.json", JSON.stringify({ pid: identity.pid, startTicks: identity.startTicks, port })));
  } catch (error) { await close(); throw error; }
  return { port, close };
}
