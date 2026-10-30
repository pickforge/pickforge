// @ts-check
/**
 * Browser supervisor (pickforge/pickforge#459). It leads Chrome's process
 * group and owns Chrome's DevTools pipe: Chrome reads commands from fd 3 and
 * writes replies to fd 4, one NUL-terminated JSON message each. Chrome opens no
 * TCP port. The supervisor serves CDP to one client at a time on a 0600 Unix
 * socket in the session's private temp directory. Each client gets its own
 * browser-target session, and its top-level commands run there. Detaching that
 * session when the client leaves makes Chrome undo what the client set up.
 *
 * This file runs as plain JavaScript under Node: the browser package starts it
 * from source in tests, and the CLI build copies it next to its bundle.
 *
 * argv: <endpoint file> <socket path> <browser binary> [browser args...]
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";

/** @typedef {import("ws").WebSocket} WebSocket */
/** @typedef {import("node:stream").Readable} Readable */
/** @typedef {import("node:stream").Writable} Writable */
/**
 * @typedef {object} Pending
 * @property {string} method
 * @property {WebSocket} [client] The client that sent the command.
 * @property {number} [id] The client's own command id.
 * @property {(message: any) => void} [resolve] Set for the bridge's own commands.
 */
/** @typedef {{ path: string, response: http.ServerResponse }} Lease */

const [endpointFile, socketPath, binary, ...args] = process.argv.slice(2);
if (!endpointFile || !socketPath || !binary) process.exit(127);

/** Largest CDP message accepted from Chrome; the same limit as puppeteer. */
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
/** Stop reading Chrome's pipe while this much waits for a slow client. */
const CLIENT_HIGH_WATER_BYTES = 16 * 1024 * 1024;
const RESET_TIMEOUT_MS = 5_000;
/** Most commands a client may have waiting for Chrome's reply. */
const MAX_PENDING_COMMANDS = 1024;
const MAX_STDERR_BUFFER_BYTES = 64 * 1024;
const ALREADY_ATTACHED = "A CDP client is already attached to this browser session";
const ATTACH_METHODS = new Set(["Target.attachToTarget", "Target.attachToBrowserTarget"]);
const browserPath = `/devtools/browser/${randomUUID()}`;

function hasLiveGroupMembers() {
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let content;
    try {
      content = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    } catch {
      continue;
    }
    const close = content.lastIndexOf(")");
    if (close === -1) continue;
    const fields = content.slice(close + 1).trim().split(/\s+/);
    const state = fields[0];
    const pgrp = Number(fields[2]);
    if (state !== "Z" && pgrp === process.pid) return true;
  }
  return false;
}

let childExited = false;
let childCode = 1;
const child = spawn(binary, args, {
  env: process.env,
  shell: false,
  stdio: ["inherit", "inherit", "pipe", "pipe", "pipe"],
});
const toChrome = /** @type {Writable} */ (child.stdio[3]);
const fromChrome = /** @type {Readable} */ (child.stdio[4]);
const browserStderr = /** @type {Readable} */ (child.stderr);

let stderrBuffer = "";
/** @param {string} line */
function forwardBrowserStderr(line) {
  process.stderr.write(
    line.replace(
      /ws:\/\/[^\s]+\/devtools\/browser\/[^\s]+/g,
      "[redacted DevTools capability URL]",
    ),
  );
}
function flushBrowserStderr(final = false) {
  let newline = stderrBuffer.indexOf("\n");
  while (newline !== -1) {
    const line = stderrBuffer.slice(0, newline + 1);
    stderrBuffer = stderrBuffer.slice(newline + 1);
    forwardBrowserStderr(line);
    newline = stderrBuffer.indexOf("\n");
  }
  if (final && stderrBuffer !== "") {
    forwardBrowserStderr(stderrBuffer);
    stderrBuffer = "";
  }
}
browserStderr.setEncoding("utf8");
browserStderr.on("data", (chunk) => {
  stderrBuffer += chunk;
  flushBrowserStderr();
  // No newline arrived to flush a complete line; bound the buffer so an
  // unbounded stream of newline-free stderr can never grow it forever.
  if (stderrBuffer.length > MAX_STDERR_BUFFER_BYTES) {
    stderrBuffer = stderrBuffer.slice(-MAX_STDERR_BUFFER_BYTES);
  }
});
browserStderr.once("end", () => flushBrowserStderr(true));
child.once("error", (error) => {
  console.error("Failed to launch browser:", error.message);
  childExited = true;
  childCode = 127;
});
child.once("exit", (code) => {
  childExited = true;
  childCode = code == null ? 1 : code;
});

const bridge = {
  /** @type {WebSocket | undefined} */
  client: undefined,
  /** @type {Lease | undefined} The lease the current client attached through. */
  clientLease: undefined,
  /** @type {Lease | undefined} */
  lease: undefined,
  /** @type {string | undefined} The current client's own browser-target session. */
  clientSession: undefined,
  /** @type {Promise<string | undefined> | undefined} Resolves with that session once Chrome opens it. */
  clientSessionReady: undefined,
  /** @type {any[]} Client commands that wait for the client's session. */
  queued: [],
  /** @type {Set<string>} Sessions the current client attached below its own session. */
  sessions: new Set(),
  /** Refusals sent to the current client that are not yet written out. */
  refusals: 0,
  /** @type {Promise<void> | undefined} */
  resetting: undefined,
  /** @type {http.Server | undefined} */
  server: undefined,
  waitingForDrain: false,
  closed: false,
};
let nextId = 1;
/** @type {Map<number, Pending>} */
const inflight = new Map();

// Chrome's own end of the pipe closing is reported on the read side.
toChrome.on("error", () => {});

/** @param {object} message */
function writeToChrome(message) {
  return toChrome.write(`${JSON.stringify(message)}\0`);
}

/**
 * Send a command of the bridge's own. It resolves with Chrome's reply, or with
 * `undefined` once Chrome is gone.
 * @param {string} method
 * @param {object} [params]
 * @param {string} [sessionId]
 * @returns {Promise<any>}
 */
function command(method, params = {}, sessionId) {
  return new Promise((resolve) => {
    if (bridge.closed) {
      resolve(undefined);
      return;
    }
    const id = nextId++;
    inflight.set(id, { method, resolve });
    writeToChrome({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) });
  });
}

/**
 * @param {WebSocket} client
 * @param {string} text
 */
function sendToClient(client, text) {
  client.send(text, () => {
    if (bridge.client !== client || client.bufferedAmount < CLIENT_HIGH_WATER_BYTES) {
      fromChrome.resume();
    }
  });
  if (client.bufferedAmount >= CLIENT_HIGH_WATER_BYTES) fromChrome.pause();
}

/** @param {any} message */
function handleChromeResponse(message) {
  const pending = inflight.get(message.id);
  if (pending === undefined) return;
  inflight.delete(message.id);
  if (pending.resolve !== undefined) {
    pending.resolve(message);
    return;
  }
  const client = pending.client;
  const attached = ATTACH_METHODS.has(pending.method) ? message.result?.sessionId : undefined;
  if (client === undefined || client !== bridge.client) {
    // A reply to a client that has since detached is dropped. A session it
    // attached is released, so its events never reach the next client.
    if (typeof attached === "string") {
      void command("Target.detachFromTarget", { sessionId: attached }, message.sessionId);
    }
    return;
  }
  if (typeof attached === "string") bridge.sessions.add(attached);
  message.id = pending.id;
  sendToClient(client, toClientText(message));
}

/**
 * The client sees its own browser-target session as the root session.
 * @param {any} message
 */
function toClientText(message) {
  if (message.sessionId === bridge.clientSession) delete message.sessionId;
  return JSON.stringify(message);
}

/**
 * @param {unknown} sessionId
 * @returns {boolean}
 */
function isClientSession(sessionId) {
  return (
    typeof sessionId === "string" &&
    (sessionId === bridge.clientSession || bridge.sessions.has(sessionId))
  );
}

/** @param {any} message */
function trackSessionEvent(message) {
  const sessionId = message.params?.sessionId;
  if (typeof sessionId !== "string") return;
  if (message.method === "Target.attachedToTarget") {
    // The root session is the bridge's own; it attaches only client sessions.
    if (message.sessionId === undefined) return;
    if (isClientSession(message.sessionId)) {
      bridge.sessions.add(sessionId);
      return;
    }
    // Auto-attach of a detached client: release the target at once.
    void command("Target.detachFromTarget", { sessionId }, message.sessionId);
  } else if (message.method === "Target.detachedFromTarget") {
    bridge.sessions.delete(sessionId);
  }
}

/** @param {string} text */
function handleChromeMessage(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    console.error("Ignored a malformed CDP message from the browser");
    return;
  }
  if (typeof message !== "object" || message === null) return;
  if (typeof message.id === "number") {
    handleChromeResponse(message);
    return;
  }
  trackSessionEvent(message);
  const client = bridge.client;
  // Root events belong to the bridge, and other events to sessions that are
  // not this client's.
  if (client === undefined || !isClientSession(message.sessionId)) return;
  sendToClient(client, message.sessionId === bridge.clientSession ? toClientText(message) : text);
}

/** @type {Buffer[]} */
let frameParts = [];
let frameBytes = 0;
let discardingFrame = false;

/** @param {Buffer} part */
function appendFrame(part) {
  if (part.length === 0 || discardingFrame) return;
  if (frameBytes + part.length > MAX_MESSAGE_BYTES) {
    discardingFrame = true;
    frameParts = [];
    frameBytes = 0;
    return;
  }
  frameParts.push(part);
  frameBytes += part.length;
}

function finishFrame() {
  if (discardingFrame) {
    discardingFrame = false;
    console.error(`Dropped a CDP message over ${MAX_MESSAGE_BYTES} bytes from the browser`);
    // The client now waits for a reply that never comes; end its connection.
    bridge.client?.close(1009, "CDP message too large");
    return;
  }
  const text = Buffer.concat(frameParts, frameBytes).toString("utf8");
  frameParts = [];
  frameBytes = 0;
  if (text !== "") handleChromeMessage(text);
}

/** @param {Buffer} chunk */
function readChromeChunk(chunk) {
  let start = 0;
  for (;;) {
    const end = chunk.indexOf(0, start);
    appendFrame(chunk.subarray(start, end === -1 ? chunk.length : end));
    if (end === -1) return;
    finishFrame();
    start = end + 1;
  }
}

/**
 * An empty session id would address Chrome's root session.
 * @param {unknown} sessionId
 */
function isClientSessionId(sessionId) {
  return sessionId === undefined || (typeof sessionId === "string" && sessionId !== "");
}

/** @param {any} message */
function isClientCommand(message) {
  if (typeof message !== "object" || message === null) return false;
  return Number.isSafeInteger(message.id) && typeof message.method === "string" && isClientSessionId(message.sessionId);
}

/**
 * @param {WebSocket} client
 * @param {import("ws").RawData} data
 */
function handleClientMessage(client, data) {
  if (bridge.client !== client || client.readyState !== client.OPEN) return;
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    message = undefined;
  }
  if (!isClientCommand(message)) {
    client.close(1008, "Invalid CDP message");
    return;
  }
  // Chrome may never answer a command, such as an await of a promise that
  // never settles, so the commands a client may have pending are capped.
  // Refusals come from the bridge, not the pipe, so they count until written.
  if (inflight.size + bridge.queued.length + bridge.refusals >= MAX_PENDING_COMMANDS) {
    client.close(1008, `Too many pending CDP commands (over ${MAX_PENDING_COMMANDS})`);
    return;
  }
  if (bridge.clientSession === undefined) {
    bridge.queued.push(message);
    return;
  }
  forwardClientCommand(client, message);
}

/**
 * Forward a client command under a bridge id, so the bridge can send its own
 * commands on the same pipe without an id collision. A top-level command runs
 * in the client's own browser-target session, which the client sees as the
 * root session. A command for any session the client did not attach gets the
 * error Chrome gives for an unknown session.
 * @param {WebSocket} client
 * @param {any} message
 */
function forwardClientCommand(client, message) {
  if (message.sessionId !== undefined && !bridge.sessions.has(message.sessionId)) {
    const error = { code: -32001, message: "Session with given id not found." };
    bridge.refusals += 1;
    client.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, error }), () => {
      if (bridge.client === client) bridge.refusals -= 1;
    });
    return;
  }
  const id = nextId++;
  inflight.set(id, { client, id: message.id, method: message.method });
  message.id = id;
  if (message.sessionId === undefined) message.sessionId = bridge.clientSession;
  if (writeToChrome(message) || bridge.waitingForDrain) return;
  bridge.waitingForDrain = true;
  client.pause();
  toChrome.once("drain", () => {
    bridge.waitingForDrain = false;
    bridge.client?.resume();
  });
}

/**
 * Undo what a detached client set up, so the next client starts clean. Chrome
 * ends the client's browser-target session and every session below it, and
 * with them auto-attach, discovery, tracing, download behavior and browser
 * contexts created with `disposeOnDetach`. Detaching a session also releases
 * a target paused on start.
 * @param {WebSocket} client
 * @param {Promise<string | undefined>} sessionReady
 */
async function resetClientState(client, sessionReady) {
  const detach = sessionReady.then((sessionId) =>
    sessionId === undefined ? undefined : command("Target.detachFromTarget", { sessionId }),
  );
  await Promise.race([detach, delay(RESET_TIMEOUT_MS)]);
  // Chrome answers in order, so an attach the client sent before it left was
  // answered before this detach, and its session is released by now.
  for (const [id, pending] of inflight) {
    if (pending.client === client) inflight.delete(id);
  }
}

/** @param {WebSocket} client */
function detachClient(client) {
  if (bridge.client !== client) return;
  const sessionReady = bridge.clientSessionReady ?? Promise.resolve(undefined);
  bridge.client = undefined;
  bridge.clientLease = undefined;
  bridge.clientSession = undefined;
  bridge.clientSessionReady = undefined;
  bridge.queued = [];
  bridge.sessions = new Set();
  bridge.refusals = 0;
  fromChrome.resume();
  // Chrome may never answer these. An attach stays until the reset, so a late
  // reply still releases its session.
  for (const [id, pending] of inflight) {
    if (pending.client === client && !ATTACH_METHODS.has(pending.method)) inflight.delete(id);
  }
  bridge.resetting = resetClientState(client, sessionReady).finally(() => {
    bridge.resetting = undefined;
  });
}

/**
 * Give the client its own browser-target session. Its commands wait in a
 * queue until Chrome opens the session.
 * @param {WebSocket} client
 * @returns {Promise<string | undefined>}
 */
async function openClientSession(client) {
  const sessionId = (await command("Target.attachToBrowserTarget"))?.result?.sessionId;
  if (typeof sessionId !== "string") {
    if (bridge.client === client) client.close(1011, "The browser did not open a CDP session");
    return undefined;
  }
  // A client that left meanwhile has its session detached by the reset.
  if (bridge.client !== client) return sessionId;
  bridge.clientSession = sessionId;
  const queued = bridge.queued;
  bridge.queued = [];
  for (const message of queued) forwardClientCommand(client, message);
  return sessionId;
}

/**
 * @param {WebSocket} client
 * @param {Lease | undefined} lease
 */
function attachClient(client, lease) {
  bridge.client = client;
  bridge.clientLease = lease;
  client.on("message", (data) => handleClientMessage(client, data));
  client.on("error", () => {});
  client.once("close", () => detachClient(client));
  bridge.clientSessionReady = openClientSession(client);
}

/**
 * @param {import("node:stream").Duplex} socket
 * @param {number} status
 * @param {string} reason
 * @param {string} body
 */
function refuseUpgrade(socket, status, reason, body) {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/**
 * Accept one websocket client at a time: on the endpoint file's browser path
 * when no relay holds a lease, or on the lease's own path.
 * @param {WebSocketServer} wss
 * @param {http.IncomingMessage} request
 * @param {import("node:stream").Duplex} socket
 * @param {Buffer} head
 */
function handleUpgrade(wss, request, socket, head) {
  socket.on("error", () => {});
  if (bridge.resetting !== undefined) {
    void bridge.resetting.then(() => handleUpgrade(wss, request, socket, head));
    return;
  }
  const lease = bridge.lease;
  const viaLease = lease !== undefined && request.url === lease.path;
  if (!viaLease && request.url !== browserPath) {
    refuseUpgrade(socket, 404, "Not Found", "Unknown CDP endpoint");
    return;
  }
  if (bridge.closed || bridge.client !== undefined || (!viaLease && lease !== undefined)) {
    refuseUpgrade(socket, 409, "Conflict", ALREADY_ATTACHED);
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => attachClient(client, viaLease ? lease : undefined));
}

/** @param {Lease} lease */
function releaseLease(lease) {
  if (bridge.lease !== lease) return;
  bridge.lease = undefined;
  // Terminate, not close: a relay that stopped reading would otherwise hold
  // the slot until the close handshake times out.
  if (bridge.clientLease === lease) bridge.client?.terminate();
}

/**
 * Hand a relay the session's one client slot. The slot is held for as long as
 * the relay keeps this response open, and its websocket must use the returned
 * path. A second relay gets 409 at once rather than a failed tool call later.
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 */
function attachLease(request, response) {
  if (bridge.lease !== undefined || bridge.client !== undefined) {
    reply(response, 409, { error: ALREADY_ATTACHED });
    return;
  }
  /** @type {Lease} */
  const lease = { path: `/devtools/browser/${randomUUID()}`, response };
  bridge.lease = lease;
  response.writeHead(200, { "Content-Type": "application/json" });
  response.write(`${JSON.stringify({ browserPath: lease.path })}\n`);
  request.socket.once("close", () => releaseLease(lease));
}

/**
 * @param {http.ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
function reply(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  response.end(JSON.stringify(body));
}

/**
 * @param {any} version
 * @returns {http.RequestListener}
 */
function httpHandler(version) {
  const versionBody = {
    Browser: version.product,
    "Protocol-Version": version.protocolVersion,
    "User-Agent": version.userAgent,
    "V8-Version": version.jsVersion,
    "WebKit-Version": version.revision,
  };
  return (request, response) => {
    if (request.method === "GET" && request.url === "/json/version") {
      reply(response, 200, versionBody);
    } else if (request.method === "POST" && request.url === "/close") {
      // Browser.close shuts Chrome down cleanly, so profile cookies flush.
      void command("Browser.close");
      reply(response, 202, {});
    } else if (request.method === "POST" && request.url === "/attach") {
      attachLease(request, response);
    } else {
      reply(response, 404, { error: "Not found" });
    }
  };
}

/** Publish the endpoint atomically: readers see the old file or the new one. */
function writeEndpointFile() {
  const temporary = `${endpointFile}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ socketPath, browserPath })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, endpointFile);
}

function removeEndpoint() {
  for (const file of [endpointFile, socketPath]) {
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      console.error(`Failed to remove ${file}:`, error instanceof Error ? error.message : String(error));
    }
  }
}

async function startBridge() {
  const version = (await command("Browser.getVersion"))?.result;
  if (version === undefined) throw new Error("the browser did not answer Browser.getVersion");
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });
  const server = http.createServer(httpHandler(version));
  server.on("upgrade", (request, socket, head) => handleUpgrade(wss, request, socket, head));
  bridge.server = server;
  fs.rmSync(socketPath, { force: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(undefined));
  });
  // The parent directory is 0700 already; the socket itself is 0600 too.
  fs.chmodSync(socketPath, 0o600);
  if (bridge.closed) {
    // Chrome went away while the socket was opening.
    server.close();
    removeEndpoint();
    return;
  }
  writeEndpointFile();
}

/** Chrome's pipe closed: Chrome is gone or going. End every client. */
function closeBridge() {
  if (bridge.closed) return;
  bridge.closed = true;
  for (const pending of inflight.values()) pending.resolve?.(undefined);
  inflight.clear();
  bridge.client?.terminate();
  bridge.lease?.response.end();
  bridge.server?.close();
  bridge.server?.closeAllConnections();
  removeEndpoint();
}

fromChrome.on("data", readChromeChunk);
fromChrome.once("close", closeBridge);
startBridge().catch((error) => {
  console.error("Failed to serve the CDP socket:", error instanceof Error ? error.message : String(error));
  child.kill("SIGTERM");
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {});
}
const timer = setInterval(() => {
  if (childExited && !hasLiveGroupMembers()) {
    clearInterval(timer);
    closeBridge();
    process.exit(childCode);
  }
}, 50);
