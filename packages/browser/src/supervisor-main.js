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
 * During a human takeover (#380) Google refuses sign-in in any Chrome with
 * remote debugging. POST /plain closes the CDP Chrome and opens the same
 * profile in a plain Chrome without the pipe; POST /cdp closes it cleanly and
 * reopens the profile under CDP with its last tabs. The socket, the endpoint
 * file and a relay's lease stay across both relaunches; only the websocket
 * client is dropped, and new ones wait until CDP is back.
 *
 * This file runs as plain JavaScript under Node: the browser package starts it
 * from source in tests, and the CLI build copies it next to its bundle.
 *
 * argv: <endpoint file> <socket path> <browser binary> [browser args...]
 * The last browser arg is the start URL, as buildChromeArgs puts it.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
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
/** @typedef {"cdp" | "plain" | "plain-idle" | "relaunching"} Mode */
/**
 * One CDP child's DevTools pipe.
 * @typedef {object} Pipe
 * @property {Writable} toChrome
 * @property {Readable} fromChrome
 */
/**
 * One browser child.
 * @typedef {object} Browser
 * @property {import("node:child_process").ChildProcess} process
 * @property {Pipe | undefined} pipe Set for a CDP child only.
 * @property {boolean} exited
 * @property {number} code
 * @property {Promise<void>} exit Resolves once the child exited.
 */

const [endpointFile, socketPath, binary, ...args] = process.argv.slice(2);
if (!endpointFile || !socketPath || !binary) process.exit(127);

/** Largest CDP message accepted from Chrome; the same limit as puppeteer. */
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
/** Stop reading Chrome's pipe while this much waits for a slow client. */
const CLIENT_HIGH_WATER_BYTES = 16 * 1024 * 1024;
const RESET_TIMEOUT_MS = 5_000;
/** Most commands a client may have waiting for Chrome's reply. */
const MAX_PENDING_COMMANDS = 1024;
/** Chrome's session ids are 32 hex digits, so a longer one names no session. */
const MAX_SESSION_ID_LENGTH = 128;
const MAX_STDERR_BUFFER_BYTES = 64 * 1024;
const ALREADY_ATTACHED = "A CDP client is already attached to this browser session";
const ATTACH_METHODS = new Set(["Target.attachToTarget", "Target.attachToBrowserTarget"]);
const browserPath = `/devtools/browser/${randomUUID()}`;
/** Tests shorten the stop and CDP start budgets with this variable. */
const testBudgetMs = Number(process.env.PICKFORGE_SUPERVISOR_TEST_BUDGET_MS);
/** How long a closing browser may take before it is killed. */
const STOP_TIMEOUT_MS = testBudgetMs > 0 ? testBudgetMs : 15_000;
/** How long a relaunch waits for the old browser's helpers to exit. */
const GROUP_DRAIN_TIMEOUT_MS = 5_000;
/** A plain browser that exits this soon did not start. */
const PLAIN_START_GRACE_MS = 1_000;
/** How long a relaunched CDP browser may take to answer Browser.getVersion. */
const CDP_START_TIMEOUT_MS = testBudgetMs > 0 ? testBudgetMs : 45_000;
const LEASE_POLL_MS = 1_000;
/** HUMAN_LEASE_FILE of @pickforge/lab-core, in the session directory. */
const humanLeaseFile = path.join(path.dirname(endpointFile), "human.lease.json");

/**
 * The state, process group and start ticks (fields 3, 5 and 22) of
 * `/proc/<pid>/stat`, or undefined when it cannot be read or parsed.
 * @param {number} pid
 * @returns {{ state: string, pgrp: number, startTicks: number } | undefined}
 */
function readProcStat(pid) {
  let content;
  try {
    content = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  // The command name may hold spaces and parentheses; fields follow the last ")".
  const close = content.lastIndexOf(")");
  if (close === -1) return undefined;
  const fields = content.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const pgrp = Number(fields[2]);
  const startTicks = Number(fields[19]);
  if (state === undefined || !Number.isFinite(pgrp) || !Number.isFinite(startTicks)) return undefined;
  return { state, pgrp, startTicks };
}

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
    const stat = readProcStat(pid);
    if (stat !== undefined && stat.state !== "Z" && stat.pgrp === process.pid) return true;
  }
  return false;
}

/**
 * identityIsAlive of @pickforge/lab-core: a zombie or a start ticks mismatch
 * is dead. An unreadable stat falls back to a signal probe, where only ESRCH
 * is dead.
 * @param {number} pid
 * @param {number | undefined} startTicks
 */
function identityIsAlive(pid, startTicks) {
  const stat = startTicks === undefined ? undefined : readProcStat(pid);
  if (stat !== undefined) return stat.state !== "Z" && stat.startTicks === startTicks;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * Forward a browser's stderr line by line with DevTools capability URLs
 * redacted.
 * @param {Readable} stream
 */
function forwardBrowserStderr(stream) {
  let buffered = "";
  /** @param {string} line */
  const forward = (line) => {
    process.stderr.write(
      line.replace(
        /ws:\/\/[^\s]+\/devtools\/browser\/[^\s]+/g,
        "[redacted DevTools capability URL]",
      ),
    );
  };
  const flush = (final = false) => {
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      forward(buffered.slice(0, newline + 1));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
    if (final && buffered !== "") {
      forward(buffered);
      buffered = "";
    }
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    flush();
    // No newline arrived to flush a complete line; bound the buffer so an
    // unbounded stream of newline-free stderr can never grow it forever.
    if (buffered.length > MAX_STDERR_BUFFER_BYTES) {
      buffered = buffered.slice(-MAX_STDERR_BUFFER_BYTES);
    }
  });
  stream.once("end", () => flush(true));
}

/**
 * Start a browser child. A CDP child gets the DevTools pipe on fds 3 and 4;
 * a plain one gets no pipe at all.
 * @param {string[]} argv
 * @param {boolean} withPipe
 * @returns {Browser}
 */
function spawnBrowser(argv, withPipe) {
  const child = spawn(binary, argv, {
    env: process.env,
    shell: false,
    stdio: withPipe ? ["inherit", "inherit", "pipe", "pipe", "pipe"] : ["inherit", "inherit", "pipe"],
  });
  /** @type {Browser} */
  const started = { process: child, pipe: undefined, exited: false, code: 1, exit: Promise.resolve() };
  started.exit = new Promise((resolve) => {
    /** @param {number} code */
    const done = (code) => {
      if (started.exited) return;
      started.exited = true;
      started.code = code;
      resolve();
      browserExited(started);
    };
    child.once("error", (error) => {
      console.error("Failed to launch browser:", error.message);
      done(127);
    });
    child.once("exit", (code) => done(code ?? 1));
  });
  forwardBrowserStderr(/** @type {Readable} */ (child.stderr));
  if (withPipe) started.pipe = openPipe(child);
  return started;
}

/** @type {Mode} */
let mode = "cdp";
/** @type {Browser | undefined} The current browser child. */
let browser;
/** @type {Pipe | undefined} The current CDP child's pipe. */
let pipe;
/** True while a relaunch runs; its child exits are planned. */
let transitioning = false;
/** Set by /close and by a failed relaunch: the supervisor is ending. */
let closing = false;
/** Relaunches run one at a time on this chain. */
let transitions = Promise.resolve();
/** @type {Array<() => void>} Websocket upgrades that wait for CDP. */
let cdpWaiters = [];
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

/**
 * Write a message to the current CDP child. Returns false when the pipe wants
 * the writer to wait for `drain`.
 * @param {object} message
 */
function writeToChrome(message) {
  return pipe === undefined ? true : pipe.toChrome.write(`${JSON.stringify(message)}\0`);
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
    if (bridge.closed || pipe === undefined) {
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
  const source = pipe;
  client.send(text, () => {
    if (bridge.client !== client || client.bufferedAmount < CLIENT_HIGH_WATER_BYTES) {
      source?.fromChrome.resume();
    }
  });
  if (client.bufferedAmount >= CLIENT_HIGH_WATER_BYTES) source?.fromChrome.pause();
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

/**
 * Split a pipe's byte stream into NUL-terminated CDP messages. Each pipe gets
 * its own reader, so a message cut off by a relaunch never joins the next.
 * @returns {(chunk: Buffer) => void}
 */
function frameReader() {
  /** @type {Buffer[]} */
  let parts = [];
  let bytes = 0;
  let discarding = false;
  /** @param {Buffer} part */
  const append = (part) => {
    if (part.length === 0 || discarding) return;
    if (bytes + part.length > MAX_MESSAGE_BYTES) {
      discarding = true;
      parts = [];
      bytes = 0;
      return;
    }
    parts.push(part);
    bytes += part.length;
  };
  const finish = () => {
    if (discarding) {
      discarding = false;
      console.error(`Dropped a CDP message over ${MAX_MESSAGE_BYTES} bytes from the browser`);
      // The client now waits for a reply that never comes; end its connection.
      bridge.client?.close(1009, "CDP message too large");
      return;
    }
    const text = Buffer.concat(parts, bytes).toString("utf8");
    parts = [];
    bytes = 0;
    if (text !== "") handleChromeMessage(text);
  };
  return (chunk) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(0, start);
      append(chunk.subarray(start, end === -1 ? chunk.length : end));
      if (end === -1) return;
      finish();
      start = end + 1;
    }
  };
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Pipe}
 */
function openPipe(child) {
  /** @type {Pipe} */
  const opened = {
    toChrome: /** @type {Writable} */ (child.stdio[3]),
    fromChrome: /** @type {Readable} */ (child.stdio[4]),
  };
  // Chrome's own end of the pipe closing is reported on the read side.
  opened.toChrome.on("error", () => {});
  opened.fromChrome.on("data", frameReader());
  opened.fromChrome.once("close", () => pipeClosed(opened));
  return opened;
}

/**
 * A CDP child's pipe closed: that Chrome is gone or going. Its commands get no
 * reply and its client is dropped. Unless a relaunch planned this, every
 * client is ended for good.
 * @param {Pipe} closed
 */
function pipeClosed(closed) {
  if (pipe !== closed) return;
  pipe = undefined;
  bridge.waitingForDrain = false;
  for (const pending of inflight.values()) pending.resolve?.(undefined);
  inflight.clear();
  bridge.client?.terminate();
  if (!transitioning) closeBridge();
}

/**
 * An empty session id would address Chrome's root session. A refusal echoes
 * the id, so its length is bounded too.
 * @param {unknown} sessionId
 */
function isClientSessionId(sessionId) {
  if (sessionId === undefined) return true;
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= MAX_SESSION_ID_LENGTH;
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
  if (writeToChrome(message) || bridge.waitingForDrain || pipe === undefined) return;
  bridge.waitingForDrain = true;
  client.pause();
  pipe.toChrome.once("drain", () => {
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
  pipe?.fromChrome.resume();
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
  serveUpgrade(wss, request, socket, head);
}

/**
 * While the browser is not under CDP, or a detached client's state is being
 * reset, an upgrade waits.
 * @returns {Promise<unknown> | undefined}
 */
function upgradeWait() {
  if (bridge.closed) return undefined;
  if (mode !== "cdp") return new Promise((resolve) => cdpWaiters.push(() => resolve(undefined)));
  return bridge.resetting;
}

/**
 * @param {WebSocketServer} wss
 * @param {http.IncomingMessage} request
 * @param {import("node:stream").Duplex} socket
 * @param {Buffer} head
 */
function serveUpgrade(wss, request, socket, head) {
  const wait = upgradeWait();
  if (wait !== undefined) {
    void wait.then(() => serveUpgrade(wss, request, socket, head));
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
 * Ask a browser to shut down cleanly, so profile cookies flush. Chrome under
 * CDP gets Browser.close on its own pipe; a plain one gets SIGTERM.
 * @param {Browser} target
 */
function askToStop(target) {
  if (target.exited) return;
  if (target.pipe === undefined) target.process.kill("SIGTERM");
  else target.pipe.toChrome.write(`${JSON.stringify({ id: nextId++, method: "Browser.close" })}\0`);
}

function stopCurrentBrowser() {
  if (browser !== undefined) askToStop(browser);
}

/** POST /close: the session is ending. A relaunch in flight ends with it. */
function closeBrowser() {
  closing = true;
  if (!transitioning) stopCurrentBrowser();
}

/**
 * POST /plain and POST /cdp answer once the browser runs in that mode.
 * @param {http.ServerResponse} response
 * @param {"plain" | "cdp"} target
 */
async function answerModeRequest(response, target) {
  try {
    reply(response, 200, { mode: await requestMode(target) });
  } catch (error) {
    reply(response, 500, { error: error instanceof Error ? error.message : String(error), mode });
  }
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
  /** @type {Map<string, http.RequestListener>} */
  const postRoutes = new Map([
    ["/close", (_request, response) => {
      closeBrowser();
      reply(response, 202, {});
    }],
    ["/attach", attachLease],
    ["/plain", (_request, response) => void answerModeRequest(response, "plain")],
    ["/cdp", (_request, response) => void answerModeRequest(response, "cdp")],
  ]);
  return (request, response) => {
    const route = request.method === "POST" ? postRoutes.get(request.url ?? "") : undefined;
    if (request.method === "GET" && request.url === "/json/version") {
      reply(response, 200, versionBody);
    } else if (route === undefined) {
      reply(response, 404, { error: "Not found" });
    } else {
      route(request, response);
    }
  };
}

/**
 * Publish the endpoint atomically: readers see the old file or the new one.
 * `mode` tells a reader whether the browser is under CDP.
 */
function writeEndpointFile() {
  const temporary = `${endpointFile}.${process.pid}.tmp`;
  fs.rmSync(temporary, { force: true });
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ socketPath, browserPath, mode })}\n`);
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

/** The browser is gone for good. End every client and the socket. */
function closeBridge() {
  if (bridge.closed) return;
  bridge.closed = true;
  for (const pending of inflight.values()) pending.resolve?.(undefined);
  inflight.clear();
  bridge.client?.terminate();
  bridge.lease?.response.end();
  bridge.server?.close();
  bridge.server?.closeAllConnections();
  releaseCdpWaiters();
  removeEndpoint();
}

function releaseCdpWaiters() {
  const waiters = cdpWaiters;
  cdpWaiters = [];
  for (const wake of waiters) wake();
}

/**
 * Enter a mode and republish the endpoint file with it. Upgrades that waited
 * for CDP go on once it is back.
 * @param {Mode} next
 */
function setMode(next) {
  mode = next;
  if (next === "cdp") releaseCdpWaiters();
  if (bridge.server === undefined || bridge.closed) return;
  try {
    writeEndpointFile();
  } catch (error) {
    console.error("Failed to publish the CDP endpoint:", error instanceof Error ? error.message : String(error));
  }
}

/** @param {Browser} exited */
function browserExited(exited) {
  // The person closed the plain browser. Stay up for the return to CDP.
  if (exited === browser && mode === "plain" && !transitioning && !closing) setMode("plain-idle");
}

/** Drop the websocket client. A relay's lease stays, so it can reconnect. */
function dropClient() {
  const client = bridge.client;
  if (client === undefined) return;
  client.terminate();
  detachClient(client);
}

/**
 * @param {Browser} target
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function exitsWithin(target, timeoutMs) {
  return Promise.race([target.exit.then(() => true), delay(timeoutMs).then(() => false)]);
}

/**
 * Stop a browser, and kill it if it does not exit within the stop budget.
 * @param {Browser} target
 * @param {(target: Browser) => void} ask How to ask it to exit.
 */
async function stopWithin(target, ask) {
  if (target.exited) return;
  ask(target);
  if (await exitsWithin(target, STOP_TIMEOUT_MS)) return;
  target.process.kill("SIGKILL");
  await target.exit;
}

/**
 * Stop a browser for a relaunch: ask it to close, kill it if it hangs, then
 * give its helper processes a moment to leave the group. A profile can be
 * open in only one Chrome at a time.
 * @param {Browser} target
 */
async function stopForRelaunch(target) {
  await stopWithin(target, askToStop);
  const deadline = Date.now() + GROUP_DRAIN_TIMEOUT_MS;
  while (hasLiveGroupMembers() && Date.now() < deadline) await delay(50);
}

/** @returns {string[]} The browser flags without the start URL. */
function browserFlags() {
  const last = args.at(-1);
  return last === undefined || last.startsWith("-") ? args : args.slice(0, -1);
}

/**
 * The plain browser's argv: every flag but remote debugging. It reopens the
 * tabs that Browser.close saved, so no page URL shows in its command line.
 */
function plainArgs() {
  const flags = browserFlags().filter((arg) => !arg.startsWith("--remote-debugging-"));
  return [...flags, "--restore-last-session"];
}

async function enterPlain() {
  dropClient();
  if (browser !== undefined) await stopForRelaunch(browser);
  const plain = spawnBrowser(plainArgs(), false);
  browser = plain;
  if (!(await exitsWithin(plain, PLAIN_START_GRACE_MS))) {
    setMode("plain");
    return;
  }
  console.error("The plain browser exited during startup; reopening it under CDP");
  await enterCdp();
  throw new Error("The plain browser exited during startup; the browser is back under CDP");
}

/**
 * Reopen the profile under CDP with the tabs of its last session. The start
 * URL is left out: Chrome would open it as one more tab.
 */
async function enterCdp() {
  if (browser !== undefined) await stopForRelaunch(browser);
  const next = spawnBrowser([...browserFlags(), "--restore-last-session"], true);
  browser = next;
  pipe = next.pipe;
  const answer = await Promise.race([command("Browser.getVersion"), delay(CDP_START_TIMEOUT_MS)]);
  if (answer?.result === undefined) {
    // The supervisor ends once this browser is gone. Until then upgrades
    // wait, so a browser that ignores SIGTERM is killed.
    closing = true;
    await stopWithin(next, (target) => target.process.kill("SIGTERM"));
    throw new Error("The browser did not answer Browser.getVersion after its relaunch");
  }
  setMode("cdp");
}

/**
 * @param {"plain" | "cdp"} target
 * @returns {Promise<Mode>}
 */
async function switchMode(target) {
  if (closing || bridge.closed) throw new Error("The browser session is closing");
  if (mode === target || (target === "plain" && mode === "plain-idle")) return mode;
  transitioning = true;
  setMode("relaunching");
  try {
    if (target === "plain") await enterPlain();
    else await enterCdp();
    return mode;
  } finally {
    transitioning = false;
    settleAfterRelaunch();
  }
}

/** Apply what happened while a relaunch ran: a /close, or a plain exit. */
function settleAfterRelaunch() {
  if (closing) stopCurrentBrowser();
  else if (mode === "plain" && browser?.exited === true) setMode("plain-idle");
}

/**
 * Queue a switch behind any relaunch in flight. A switch to the mode the
 * browser is already in does nothing.
 * @param {"plain" | "cdp"} target
 * @returns {Promise<Mode>}
 */
function requestMode(target) {
  const run = transitions.then(() => switchMode(target));
  transitions = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * The fields of a human lease that its staleness depends on, or undefined for
 * a file that parseHumanLease of @pickforge/lab-core rejects. Core lets agent
 * input go on under such a lease, so it holds nothing here either.
 * @param {string} raw
 * @returns {{ ownerPid: number, ownerStartTicks: number | undefined, expiresAt: string } | undefined}
 */
function parseHumanLease(raw) {
  let lease;
  try {
    lease = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof lease !== "object" || lease === null) return undefined;
  const strings = ["leaseId", "sessionId", "createdAt", "expiresAt"];
  const numbers = ["ownerPid", "ttlMs", "heartbeatMs"];
  if (!strings.every((key) => typeof lease[key] === "string")) return undefined;
  if (!numbers.every((key) => typeof lease[key] === "number")) return undefined;
  if (lease.inputTransport !== undefined && lease.inputTransport !== "x11vnc" && lease.inputTransport !== "viewer") {
    return undefined;
  }
  if (!validOptionalIdentity(lease.viewerPid, 1) || !validOptionalIdentity(lease.viewerStartTicks, 0)) return undefined;
  const ownerStartTicks = typeof lease.ownerStartTicks === "number" ? lease.ownerStartTicks : undefined;
  return { ownerPid: lease.ownerPid, ownerStartTicks, expiresAt: lease.expiresAt };
}

/**
 * @param {unknown} value
 * @param {number} minimum
 */
function validOptionalIdentity(value, minimum) {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum);
}

/**
 * Whether a person still holds the session's human lease. This is
 * isHumanLeaseStale of @pickforge/lab-core with no grace: agent input
 * resumes the moment the lease is stale, so CDP must come back then too.
 */
function humanLeaseHeld() {
  let raw;
  try {
    raw = fs.readFileSync(humanLeaseFile, "utf8");
  } catch {
    return false;
  }
  const lease = parseHumanLease(raw);
  if (lease === undefined || !identityIsAlive(lease.ownerPid, lease.ownerStartTicks)) return false;
  return !(Date.now() > Date.parse(lease.expiresAt));
}

/**
 * A takeover that ended without POST /cdp, such as one whose owner crashed,
 * must not leave the session without CDP.
 */
function checkHumanLease() {
  if ((mode !== "plain" && mode !== "plain-idle") || transitioning || closing) return;
  if (humanLeaseHeld()) return;
  console.error("The human lease ended; reopening the browser under CDP");
  requestMode("cdp").catch((error) => {
    console.error("Failed to reopen the browser under CDP:", error instanceof Error ? error.message : String(error));
  });
}

browser = spawnBrowser(args, true);
pipe = browser.pipe;
startBridge().catch((error) => {
  console.error("Failed to serve the CDP socket:", error instanceof Error ? error.message : String(error));
  browser?.process.kill("SIGTERM");
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {});
}
setInterval(checkHumanLease, LEASE_POLL_MS);

/** Exit once the browser is gone for good: not between relaunches, not while plain. */
function readyToExit() {
  if (transitioning || browser === undefined || !browser.exited) return false;
  if (mode !== "cdp" && !closing) return false;
  return !hasLiveGroupMembers();
}

const timer = setInterval(() => {
  if (!readyToExit()) return;
  clearInterval(timer);
  closeBridge();
  process.exit(browser?.code ?? 1);
}, 50);
