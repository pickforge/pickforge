import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { HUMAN_LEASE_FILE, runCommand } from "@pickforge/lab-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CdpAlreadyAttachedError,
  attachCdpClient,
  cdpWebSocketUrl,
  probeCdpEndpoint,
  readCdpEndpoint,
  readDevToolsBrowserVersion,
  requestCdpSupervisorMode,
  waitForCdpEndpoint,
  type CdpEndpoint,
} from "../src/devtools.js";
import {
  buildSupervisedBrowserCommand,
  resolveSupervisorScript,
} from "../src/supervisor.js";

/** The supervisor's MAX_PENDING_COMMANDS. */
const MAX_PENDING_COMMANDS = 1024;
const temporaryDirectories: string[] = [];
const supervisors: ChildProcess[] = [];

afterEach(() => {
  for (const child of supervisors.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-supervisor-"));
  temporaryDirectories.push(dir);
  return dir;
}

function cdpPaths(dir: string) {
  return { endpointFile: path.join(dir, "cdp-endpoint"), socketPath: path.join(dir, "cdp.sock") };
}

/**
 * A scripted browser on the CDP pipe. It records every command it reads on
 * fd 3 in `commands.jsonl` and answers on fd 4, in order, as Chrome does. Its
 * `Browser.getVersion` reply arrives in two writes, and `Test.joined` gets an
 * event and its reply in one write, so the supervisor must split and join NUL
 * frames itself. `Target.attachToBrowserTarget` opens sessions B1, B2 and so
 * on, and `Target.attachToTarget` opens T1, T2 and so on. `Test.hang` is never
 * answered. `Browser.close` exits, and `Target.getTargets` lists `pages.json`.
 *
 * Each start appends its pid and argv to `launches.jsonl`. Like Chrome, it
 * opens the pipe only with `--remote-debugging-pipe`. Without it, it is a
 * plain browser: it opens no pipe, exits 0
 * on SIGTERM and logs that in `sigterm.log`, and exits 1 at once when
 * `plain-fails` exists.
 */
function writePipeBrowser(dir: string): string {
  const script = path.join(dir, "pipe-browser.cjs");
  fs.writeFileSync(
    script,
    [
      'const fs = require("node:fs");',
      'const net = require("node:net");',
      'const path = require("node:path");',
      'const log = path.join(__dirname, "commands.jsonl");',
      'fs.appendFileSync(path.join(__dirname, "launches.jsonl"), JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + "\\n");',
      'if (!process.argv.includes("--remote-debugging-pipe")) {',
      '  if (fs.existsSync(path.join(__dirname, "plain-fails"))) process.exit(1);',
      '  process.on("SIGTERM", () => { fs.appendFileSync(path.join(__dirname, "sigterm.log"), process.pid + "\\n"); process.exit(0); });',
      "  setInterval(() => {}, 1000);",
      "} else {",
      "const input = new net.Socket({ fd: 3, readable: true, writable: false });",
      "const output = new net.Socket({ fd: 4, readable: false, writable: true });",
      'const frame = (message) => JSON.stringify(message) + "\\0";',
      "let browserSessions = 0;",
      "let targetSessions = 0;",
      "async function handle(message) {",
      '  fs.appendFileSync(log, JSON.stringify(message) + "\\n");',
      "  const on = message.sessionId ? { sessionId: message.sessionId } : {};",
      "  const reply = { id: message.id, result: {}, ...on };",
      '  if (message.method === "Browser.getVersion") {',
      '    const text = frame({ id: message.id, result: { product: "Chrome/1.2.3", protocolVersion: "1.3", revision: "@r", userAgent: "Pipe", jsVersion: "1" } });',
      "    output.write(text.slice(0, 7));",
      "    setTimeout(() => output.write(text.slice(7)), 20);",
      '  } else if (message.method === "Test.joined") {',
      '    output.write(frame({ method: "Test.event", params: { n: 1 }, ...on }) + frame(reply));',
      '  } else if (message.method === "Test.events") {',
      '    output.write(frame({ method: "Test.root" }) + frame({ method: "Test.other", sessionId: "OTHER" }) + frame({ method: "Test.own", ...on }) + frame(reply));',
      '  } else if (message.method === "Test.hang") {',
      "    // Never answered, like an await of a promise that never settles.",
      '  } else if (message.method === "Target.attachToBrowserTarget") {',
      "    const sessionId = `B${++browserSessions}`;",
      '    output.write(frame({ ...reply, result: { sessionId } }) + frame({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: {}, waitingForDebugger: false }, ...on }));',
      '  } else if (message.method === "Target.attachToTarget") {',
      "    await new Promise((resolve) => setTimeout(resolve, message.params.delayMs ?? 0));",
      '    output.write(frame({ ...reply, result: { sessionId: `T${++targetSessions}` } }));',
      '  } else if (message.method === "Target.setAutoAttach" && message.params.autoAttach) {',
      '    output.write(frame(reply) + frame({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: {}, waitingForDebugger: true }, ...on }));',
      '  } else if (message.method === "Target.detachFromTarget") {',
      '    output.write(frame(reply) + frame({ method: "Target.detachedFromTarget", params: { sessionId: message.params.sessionId }, ...on }));',
      '  } else if (message.method === "Test.exit") {',
      "    process.exit(3);",
      '  } else if (message.method === "Browser.close") {',
      "    output.write(frame(reply));",
      "    setTimeout(() => process.exit(0), 10);",
      '  } else if (message.method === "Target.getTargets") {',
      '    const pages = path.join(__dirname, "pages.json");',
      "    const targetInfos = fs.existsSync(pages) ? JSON.parse(fs.readFileSync(pages, \"utf8\")) : [];",
      "    output.write(frame({ ...reply, result: { targetInfos } }));",
      "  } else {",
      "    output.write(frame(reply));",
      "  }",
      "}",
      'let buffered = "";',
      "let queue = Promise.resolve();",
      'input.setEncoding("utf8");',
      'input.on("data", (chunk) => {',
      "  buffered += chunk;",
      "  let end;",
      '  while ((end = buffered.indexOf("\\0")) !== -1) {',
      "    const message = JSON.parse(buffered.slice(0, end));",
      "    queue = queue.then(() => handle(message));",
      "    buffered = buffered.slice(end + 1);",
      "  }",
      "});",
      'input.on("end", () => process.exit(0));',
      "setInterval(() => {}, 1000);",
      "}",
    ].join("\n"),
  );
  return script;
}

interface Bridge {
  dir: string;
  child: ChildProcess;
  endpoint: CdpEndpoint;
  commands(): Array<{ id: number; method: string; params?: Record<string, unknown>; sessionId?: string }>;
}

async function startBridge(
  browserArgs: (dir: string) => string[] = () => ["--remote-debugging-pipe"],
): Promise<Bridge> {
  const dir = temporaryDirectory();
  const script = writePipeBrowser(dir);
  const paths = cdpPaths(dir);
  const command = buildSupervisedBrowserCommand(process.execPath, process.execPath, [script, ...browserArgs(dir)], paths);
  const child = spawn(command.command, command.args, { detached: true, stdio: ["ignore", "ignore", "inherit"] });
  supervisors.push(child);
  const waited = await waitForCdpEndpoint({
    endpointFile: paths.endpointFile,
    timeoutMs: 10_000,
    isAlive: () => child.exitCode === null,
  });
  if (!waited.ok) throw new Error(`bridge did not start: ${JSON.stringify(waited)}`);
  return {
    dir,
    child,
    endpoint: waited.endpoint,
    commands: () =>
      fs.readFileSync(path.join(dir, "commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
}

interface Client {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  next(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

async function connect(url: string): Promise<Client> {
  const socket = new WebSocket(url);
  const messages: Array<Record<string, unknown>> = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
  await once(socket, "open");
  return {
    socket,
    messages,
    async next(predicate) {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const found = messages.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`no matching message in ${JSON.stringify(messages)}`);
        await delay(10);
      }
    },
  };
}

async function closeClient(client: Client): Promise<void> {
  client.socket.close();
  await once(client.socket, "close");
}

function upgradeStatus(url: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("unexpected-response", (_request, response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.once("end", () => resolve({ status: response.statusCode, body }));
    });
    socket.once("open", () => reject(new Error("second client was accepted")));
    socket.once("error", () => {});
  });
}

describe("buildSupervisedBrowserCommand", () => {
  it("runs the supervisor script with its CDP paths ahead of the browser argv", () => {
    const command = buildSupervisedBrowserCommand(
      "/usr/bin/node",
      "/usr/bin/chromium",
      ["--remote-debugging-pipe", "about:blank"],
      { endpointFile: "/s/cdp-endpoint", socketPath: "/tmp/a/cdp.sock" },
      "/x/supervisor-main.js",
    );

    expect(command).toEqual({
      command: "/usr/bin/node",
      args: [
        "/x/supervisor-main.js",
        "/s/cdp-endpoint",
        "/tmp/a/cdp.sock",
        "/usr/bin/chromium",
        "--remote-debugging-pipe",
        "about:blank",
      ],
    });
    expect(resolveSupervisorScript()).toBe(
      path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "supervisor-main.js"),
    );
  });

  it("redacts split capability URLs while preserving stderr diagnostics and stdout", async () => {
    const tmp = temporaryDirectory();
    const browser = path.join(tmp, "browser.cjs");
    fs.writeFileSync(
      browser,
      [
        'process.stdout.write("browser stdout\\n");',
        'process.stderr.write("ordinary diagnostic\\nDevTools listening on ws://127.0.0.1:45123/devtools/browser/");',
        "setImmediate(() => {",
        '  process.stderr.write("secret-guid\\ntrailing diagnostic");',
        "});",
      ].join("\n"),
    );
    const command = buildSupervisedBrowserCommand(
      process.execPath,
      process.execPath,
      [browser],
      cdpPaths(tmp),
    );
    const result = await runCommand(command.command, command.args);

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("browser stdout\n");
    expect(result.stderr).toContain("ordinary diagnostic");
    expect(result.stderr).toContain("[redacted DevTools capability URL]");
    expect(result.stderr).toContain("trailing diagnostic");
    expect(result.stderr).not.toContain("secret-guid");
    expect(result.stderr).not.toContain("/devtools/browser/");
  });

  it("bounds unbounded newline-free stderr instead of buffering it all", async () => {
    const tmp = temporaryDirectory();
    const browser = path.join(tmp, "browser.cjs");
    fs.writeFileSync(
      browser,
      [
        'const fs = require("fs");',
        'fs.writeSync(2, "HEAD_MARKER_ABC");',
        'fs.writeSync(2, "a".repeat(5 * 1024 * 1024));',
        'fs.writeSync(2, "TAIL_MARKER_XYZ");',
        "process.exit(0);",
      ].join("\n"),
    );
    const command = buildSupervisedBrowserCommand(
      process.execPath,
      process.execPath,
      [browser],
      cdpPaths(tmp),
    );
    const result = await runCommand(command.command, command.args);

    expect(result.ok).toBe(true);
    expect(result.stderr).toContain("TAIL_MARKER_XYZ");
    expect(result.stderr).not.toContain("HEAD_MARKER_ABC");
    expect(result.stderr.length).toBeLessThan(200 * 1024);
  });

  it("rejects missing executable and CDP paths", () => {
    const paths = { endpointFile: "/s/cdp-endpoint", socketPath: "/s/cdp.sock" };
    expect(() =>
      buildSupervisedBrowserCommand("", "/usr/bin/chromium", [], paths),
    ).toThrow(/Node.js executable/);
    expect(() =>
      buildSupervisedBrowserCommand("/usr/bin/node", "", [], paths),
    ).toThrow(/browser binary/);
    expect(() =>
      buildSupervisedBrowserCommand("/usr/bin/node", "/usr/bin/chromium", [], { ...paths, socketPath: "" }),
    ).toThrow(/CDP endpoint and socket/);
  });
});

describe("browser supervisor CDP bridge", () => {
  it("publishes a private endpoint and serves /json/version from its cache", async () => {
    const bridge = await startBridge();
    const { endpointFile, socketPath } = cdpPaths(bridge.dir);

    expect(bridge.endpoint.socketPath).toBe(socketPath);
    expect(bridge.endpoint.browserPath).toMatch(/^\/devtools\/browser\/[0-9a-f-]{36}$/);
    expect(fs.statSync(endpointFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(socketPath).isSocket()).toBe(true);
    expect(await probeCdpEndpoint(socketPath)).toBe(true);
    expect(await readDevToolsBrowserVersion(socketPath)).toBe("Chrome/1.2.3");
    expect(await readDevToolsBrowserVersion(socketPath)).toBe("Chrome/1.2.3");
    // The reply was split across two pipe writes, and later probes never
    // reach the browser.
    expect(bridge.commands().map(({ method }) => method)).toEqual(["Browser.getVersion"]);
  });

  it("joins split frames, splits joined ones, and rewrites command ids both ways", async () => {
    const bridge = await startBridge();
    const client = await connect(cdpWebSocketUrl(bridge.endpoint.socketPath, bridge.endpoint.browserPath));
    // id 1 is also the id of the supervisor's own Browser.getVersion.
    client.socket.send(JSON.stringify({ id: 1, method: "Test.joined" }));
    client.socket.send(JSON.stringify({ id: 2, method: "Target.attachToTarget", params: { targetId: "page" } }));
    await client.next((message) => message.id === 2);
    client.socket.send(JSON.stringify({ id: 1, method: "Test.echo", sessionId: "T1" }));

    await client.next((message) => message.id === 1 && message.sessionId === "T1");
    expect(client.messages).toEqual([
      { method: "Test.event", params: { n: 1 } },
      { id: 1, result: {} },
      { id: 2, result: { sessionId: "T1" } },
      { id: 1, result: {}, sessionId: "T1" },
    ]);
    const forwarded = bridge.commands().slice(2);
    expect(forwarded.map(({ method }) => method)).toEqual(["Test.joined", "Target.attachToTarget", "Test.echo"]);
    expect(new Set(bridge.commands().map(({ id }) => id)).size).toBe(5);
  });

  it("runs a client's top-level commands in its own browser session and hides that session", async () => {
    const bridge = await startBridge();
    const client = await connect(cdpWebSocketUrl(bridge.endpoint.socketPath, bridge.endpoint.browserPath));
    client.socket.send(JSON.stringify({ id: 1, method: "Test.events" }));

    await client.next((message) => message.id === 1);
    // Root events and events of sessions the client does not own stay out.
    expect(client.messages).toEqual([{ method: "Test.own" }, { id: 1, result: {} }]);
    expect(bridge.commands().slice(1).map(({ method, sessionId }) => ({ method, sessionId }))).toEqual([
      { method: "Target.attachToBrowserTarget", sessionId: undefined },
      { method: "Test.events", sessionId: "B1" },
    ]);

    // An empty session id would address the root session.
    const closed = once(client.socket, "close");
    client.socket.send(JSON.stringify({ id: 2, method: "Test.echo", sessionId: "" }));
    const [code, reason] = (await closed) as [number, Buffer];
    expect({ code, reason: reason.toString() }).toEqual({ code: 1008, reason: "Invalid CDP message" });
    expect(bridge.commands().map(({ method }) => method)).not.toContain("Test.echo");
  });

  it("refuses an unknown session id of up to 128 characters and closes the client on a longer one", async () => {
    const bridge = await startBridge();
    const client = await connect(cdpWebSocketUrl(bridge.endpoint.socketPath, bridge.endpoint.browserPath));
    const longest = "X".repeat(128);
    client.socket.send(JSON.stringify({ id: 1, method: "Test.echo", sessionId: longest }));
    expect(await client.next((message) => message.id === 1)).toMatchObject({
      sessionId: longest,
      error: { code: -32001 },
    });

    // A refusal echoes the id, so a longer one is not accepted at all.
    const closed = once(client.socket, "close");
    client.socket.send(JSON.stringify({ id: 2, method: "Test.echo", sessionId: `${longest}X` }));
    const [code, reason] = (await closed) as [number, Buffer];
    expect({ code, reason: reason.toString() }).toEqual({ code: 1008, reason: "Invalid CDP message" });
    expect(bridge.commands().map(({ method }) => method)).not.toContain("Test.echo");
  });

  it("answers a command for a session the client does not own without forwarding it", async () => {
    const bridge = await startBridge();
    const url = cdpWebSocketUrl(bridge.endpoint.socketPath, bridge.endpoint.browserPath);
    const first = await connect(url);
    first.socket.send(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "page" } }));
    await first.next((message) => message.id === 1);
    await closeClient(first);

    // B1 and T1 were the first client's sessions, B2 is the second client's
    // own browser session, which it sees as the root, and OTHER was never attached.
    const second = await connect(url);
    for (const [id, sessionId] of [[1, "B1"], [2, "T1"], [3, "OTHER"]] as const) {
      second.socket.send(JSON.stringify({ id, method: "Test.echo", sessionId }));
    }
    second.socket.send(JSON.stringify({ id: 4, method: "Test.echo" }));
    await second.next((message) => message.id === 4);
    second.socket.send(JSON.stringify({ id: 5, method: "Test.echo", sessionId: "B2" }));
    await second.next((message) => message.id === 5);
    const error = { code: -32001, message: "Session with given id not found." };
    expect(second.messages).toEqual([
      { id: 1, sessionId: "B1", error },
      { id: 2, sessionId: "T1", error },
      { id: 3, sessionId: "OTHER", error },
      { id: 4, result: {} },
      { id: 5, sessionId: "B2", error },
    ]);
    const echoes = bridge.commands().filter(({ method }) => method === "Test.echo");
    expect(echoes.map(({ sessionId }) => sessionId)).toEqual(["B2"]);
  });

  it("serves one client at a time and refuses a second websocket or relay lease", async () => {
    const bridge = await startBridge();
    const url = cdpWebSocketUrl(bridge.endpoint.socketPath, bridge.endpoint.browserPath);
    const first = await connect(url);

    const refused = await upgradeStatus(url);
    expect(refused.status).toBe(409);
    expect(refused.body).toContain("already attached");
    await expect(attachCdpClient(bridge.endpoint)).rejects.toBeInstanceOf(CdpAlreadyAttachedError);
    expect((await upgradeStatus(cdpWebSocketUrl(bridge.endpoint.socketPath, "/devtools/browser/other"))).status).toBe(404);

    await closeClient(first);
    const lease = await attachCdpClient(bridge.endpoint);
    try {
      // While a relay holds the slot, only its own lease path is served.
      expect((await upgradeStatus(url)).status).toBe(409);
      await expect(attachCdpClient(bridge.endpoint)).rejects.toThrow("already attached");
      const leased = await connect(lease.browserEndpoint);
      leased.socket.send(JSON.stringify({ id: 5, method: "Test.echo" }));
      await leased.next((message) => message.id === 5);
      lease.release();
      // Ending the lease ends its client.
      await once(leased.socket, "close");
    } finally {
      lease.release();
    }
    const again = await attachCdpClient(bridge.endpoint);
    again.release();
  });

  it("frees the slot at once when a lease ends while its client stopped reading", async () => {
    const bridge = await startBridge();
    const lease = await attachCdpClient(bridge.endpoint);
    const stuck = await connect(lease.browserEndpoint);
    // A live peer that reads nothing never answers a close handshake.
    stuck.socket.pause();
    try {
      const started = Date.now();
      lease.release();
      let next: Awaited<ReturnType<typeof attachCdpClient>> | undefined;
      while (next === undefined) {
        try {
          next = await attachCdpClient(bridge.endpoint);
        } catch (error) {
          if (!(error instanceof CdpAlreadyAttachedError) || Date.now() - started > 10_000) throw error;
          await delay(50);
        }
      }
      next.release();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      stuck.socket.terminate();
    }
  });

  it("detaches a disconnected client's browser session before the next client attaches", async () => {
    const bridge = await startBridge();
    const url = cdpWebSocketUrl(bridge.endpoint.socketPath, bridge.endpoint.browserPath);
    const first = await connect(url);
    first.socket.send(JSON.stringify({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    }));
    // The auto-attached session belongs to the client, so its event arrives.
    expect(await first.next((message) => message.method === "Target.attachedToTarget")).toMatchObject({
      params: { sessionId: "S1" },
    });
    expect(first.messages.some((message) => "sessionId" in message)).toBe(false);
    await closeClient(first);

    const second = await connect(url);
    second.socket.send(JSON.stringify({ id: 1, method: "Test.echo" }));
    await second.next((message) => message.id === 1);
    const commands = bridge.commands().map(({ method, params, sessionId }) => ({ method, params, sessionId }));
    const reset = commands.slice(commands.findIndex(({ method }) => method === "Target.setAutoAttach") + 1);
    // Chrome ends the first client's session and everything below it.
    expect(reset).toEqual([
      { method: "Target.detachFromTarget", params: { sessionId: "B1" }, sessionId: undefined },
      { method: "Target.attachToBrowserTarget", params: {}, sessionId: undefined },
      { method: "Test.echo", params: undefined, sessionId: "B2" },
    ]);
    // The second client sees nothing of the first client's sessions.
    expect(second.messages).toEqual([{ id: 1, result: {} }]);
  });

  it("detaches a session whose attach reply arrives after its client left", async () => {
    const bridge = await startBridge();
    const url = cdpWebSocketUrl(bridge.endpoint.socketPath, bridge.endpoint.browserPath);
    const first = await connect(url);
    first.socket.send(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "page", delayMs: 300 } }));
    await expect.poll(() => bridge.commands().map(({ method }) => method)).toContain("Target.attachToTarget");
    await closeClient(first);

    const second = await connect(url);
    second.socket.send(JSON.stringify({ id: 1, method: "Test.echo" }));
    await second.next((message) => message.id === 1);
    expect(bridge.commands()).toContainEqual(
      expect.objectContaining({ method: "Target.detachFromTarget", params: { sessionId: "T1" }, sessionId: "B1" }),
    );
    expect(second.messages).toEqual([{ id: 1, result: {} }]);
  });

  it("caps a client's pending commands and drops them when it leaves", async () => {
    const bridge = await startBridge();
    const url = cdpWebSocketUrl(bridge.endpoint.socketPath, bridge.endpoint.browserPath);
    const hangs = () => bridge.commands().filter(({ method }) => method === "Test.hang").length;
    const first = await connect(url);
    for (let id = 1; id <= MAX_PENDING_COMMANDS; id += 1) first.socket.send(JSON.stringify({ id, method: "Test.hang" }));
    await expect.poll(hangs, { timeout: 10_000 }).toBe(MAX_PENDING_COMMANDS);
    await closeClient(first);

    // The first client's unanswered commands no longer count.
    const second = await connect(url);
    const closed = once(second.socket, "close");
    for (let id = 1; id <= MAX_PENDING_COMMANDS; id += 1) second.socket.send(JSON.stringify({ id, method: "Test.hang" }));
    await expect.poll(hangs, { timeout: 10_000 }).toBe(2 * MAX_PENDING_COMMANDS);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    second.socket.send(JSON.stringify({ id: 0, method: "Test.hang" }));
    const [code, reason] = (await closed) as [number, Buffer];
    expect({ code, reason: reason.toString() }).toEqual({
      code: 1008,
      reason: `Too many pending CDP commands (over ${MAX_PENDING_COMMANDS})`,
    });
    expect(hangs()).toBe(2 * MAX_PENDING_COMMANDS);
  });

  it("caps the refusals a client sends faster than it reads", async () => {
    const bridge = await startBridge();
    const client = await connect(cdpWebSocketUrl(bridge.endpoint.socketPath, bridge.endpoint.browserPath));
    client.socket.send(JSON.stringify({ id: 0, method: "Test.echo" }));
    await client.next((message) => message.id === 0);
    const closed = once(client.socket, "close");
    // Refusals come from the bridge, so the pipe does not hold them back.
    client.socket.pause();
    const sessionId = "X".repeat(128);
    for (let id = 1; id <= 50 * MAX_PENDING_COMMANDS; id += 1) {
      client.socket.send(JSON.stringify({ id, method: "Test.echo", sessionId }));
    }
    await expect.poll(() => client.socket.bufferedAmount).toBe(0);
    await delay(200);
    client.socket.resume();

    const stillOpen = delay(2_000).then(() => [0, Buffer.from("still open")]);
    const [code, reason] = (await Promise.race([closed, stillOpen])) as [number, Buffer];
    expect({ code, reason: reason.toString() }).toEqual({
      code: 1008,
      reason: `Too many pending CDP commands (over ${MAX_PENDING_COMMANDS})`,
    });
    expect(client.messages.length).toBeLessThan(50 * MAX_PENDING_COMMANDS);
    expect(bridge.commands().filter(({ method }) => method === "Test.echo")).toHaveLength(1);
  });

  it("closes its client and removes the socket and endpoint file when the browser exits", async () => {
    const bridge = await startBridge();
    const { endpointFile, socketPath } = cdpPaths(bridge.dir);
    const client = await connect(cdpWebSocketUrl(bridge.endpoint.socketPath, bridge.endpoint.browserPath));
    const closed = once(client.socket, "close");
    const exited = once(bridge.child, "exit");
    client.socket.send(JSON.stringify({ id: 1, method: "Test.exit" }));

    await closed;
    expect(await exited).toEqual([3, null]);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(endpointFile)).toBe(false);
  });

  it("answers POST /close by sending Browser.close down the pipe", async () => {
    const bridge = await startBridge();
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request({ socketPath: bridge.endpoint.socketPath, method: "POST", path: "/close" }, resolve);
      request.once("error", reject);
      request.end();
    });
    response.resume();
    expect(response.statusCode).toBe(202);
    await expect.poll(() => bridge.commands().map(({ method }) => method)).toContain("Browser.close");
  });
});

/** The flags buildChromeArgs gives Chrome, cut down, with its start URL last. */
function handoffArgs(dir: string): string[] {
  return [
    `--user-data-dir=${path.join(dir, "profile")}`,
    "--remote-debugging-pipe",
    "--password-store=basic",
    "--use-mock-keychain",
    "about:blank",
  ];
}

interface Launch {
  pid: number;
  argv: string[];
}

function launches(bridge: Bridge): Launch[] {
  return fs
    .readFileSync(path.join(bridge.dir, "launches.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Launch);
}

function lastLaunch(bridge: Bridge): Launch {
  const all = launches(bridge);
  return all[all.length - 1]!;
}

function holdHumanLease(bridge: Bridge, expiresInMs = 60_000): void {
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  fs.writeFileSync(path.join(bridge.dir, HUMAN_LEASE_FILE), `${JSON.stringify({ leaseId: "test", expiresAt })}\n`);
}

function publishedMode(bridge: Bridge): Promise<string | undefined> {
  return readCdpEndpoint(cdpPaths(bridge.dir).endpointFile).then((endpoint) => endpoint?.mode);
}

function postStatus(socketPath: string, requestPath: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method: "POST", path: requestPath }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.once("end", () => resolve({ status: response.statusCode, body }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function startHandoffBridge(): Promise<Bridge> {
  const bridge = await startBridge(handoffArgs);
  holdHumanLease(bridge);
  return bridge;
}

describe("browser supervisor plain handoff", { timeout: 20_000 }, () => {
  it("reads the human lease file that lab-core writes", () => {
    expect(HUMAN_LEASE_FILE).toBe("human.lease.json");
  });

  it("reopens the profile without remote debugging and with its pages, then restores CDP", async () => {
    const bridge = await startHandoffBridge();
    const pages = [
      { type: "page", url: "https://example.com/a" },
      { type: "page", url: "chrome://settings/" },
      { type: "service_worker", url: "https://example.com/sw.js" },
      { type: "page", url: "http://example.org/b?c=d" },
    ];
    fs.writeFileSync(path.join(bridge.dir, "pages.json"), JSON.stringify(pages));
    expect(await publishedMode(bridge)).toBe("cdp");

    expect(await requestCdpSupervisorMode(bridge.endpoint.socketPath, "plain")).toBe("plain");
    const plain = lastLaunch(bridge);
    expect(plain.argv).toEqual([
      `--user-data-dir=${path.join(bridge.dir, "profile")}`,
      "--password-store=basic",
      "--use-mock-keychain",
      "https://example.com/a",
      "http://example.org/b?c=d",
    ]);
    expect(await publishedMode(bridge)).toBe("plain");
    const methods = bridge.commands().map(({ method }) => method);
    expect(methods.slice(-2)).toEqual(["Target.getTargets", "Browser.close"]);
    // The supervisor stays the session's browser process, and its socket stays up.
    expect(bridge.child.exitCode).toBeNull();
    expect(await readDevToolsBrowserVersion(bridge.endpoint.socketPath)).toBe("Chrome/1.2.3");

    expect(await requestCdpSupervisorMode(bridge.endpoint.socketPath, "cdp")).toBe("cdp");
    expect(fs.readFileSync(path.join(bridge.dir, "sigterm.log"), "utf8").trim()).toBe(String(plain.pid));
    expect(lastLaunch(bridge).argv).toEqual([
      `--user-data-dir=${path.join(bridge.dir, "profile")}`,
      "--remote-debugging-pipe",
      "--password-store=basic",
      "--use-mock-keychain",
      "--restore-last-session",
    ]);
    const endpoint = await readCdpEndpoint(cdpPaths(bridge.dir).endpointFile);
    expect(endpoint).toEqual({ ...bridge.endpoint, mode: "cdp" });
    expect(bridge.commands().map(({ method }) => method).slice(-1)).toEqual(["Browser.getVersion"]);
    const client = await connect(cdpWebSocketUrl(bridge.endpoint.socketPath, bridge.endpoint.browserPath));
    client.socket.send(JSON.stringify({ id: 1, method: "Test.echo" }));
    expect(await client.next((message) => message.id === 1)).toEqual({ id: 1, result: {} });
    expect(bridge.child.exitCode).toBeNull();
  });

  it("opens about:blank when no page can be reopened", async () => {
    const bridge = await startHandoffBridge();
    await requestCdpSupervisorMode(bridge.endpoint.socketPath, "plain");
    expect(lastLaunch(bridge).argv.slice(-2)).toEqual(["--use-mock-keychain", "about:blank"]);
  });

  it("keeps a relay lease across both relaunches and holds its websocket until CDP is back", async () => {
    const bridge = await startHandoffBridge();
    const lease = await attachCdpClient(bridge.endpoint);
    try {
      const leased = await connect(lease.browserEndpoint);
      const dropped = once(leased.socket, "close");
      await requestCdpSupervisorMode(bridge.endpoint.socketPath, "plain");
      await dropped;
      // The slot is still the relay's.
      await expect(attachCdpClient(bridge.endpoint)).rejects.toBeInstanceOf(CdpAlreadyAttachedError);

      const waiting = new WebSocket(lease.browserEndpoint);
      let opened = false;
      const open = once(waiting, "open").then(() => (opened = true));
      waiting.on("error", () => {});
      await delay(300);
      expect(opened).toBe(false);

      await requestCdpSupervisorMode(bridge.endpoint.socketPath, "cdp");
      await open;
      const messages: Array<Record<string, unknown>> = [];
      waiting.on("message", (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
      waiting.send(JSON.stringify({ id: 7, method: "Test.echo" }));
      await expect.poll(() => messages).toEqual([{ id: 7, result: {} }]);
      waiting.close();
    } finally {
      lease.release();
    }
  });

  it("does nothing for a switch to the mode it is in and runs concurrent switches once", async () => {
    const bridge = await startHandoffBridge();
    expect(await requestCdpSupervisorMode(bridge.endpoint.socketPath, "cdp")).toBe("cdp");
    expect(launches(bridge)).toHaveLength(1);

    const both = await Promise.all([
      requestCdpSupervisorMode(bridge.endpoint.socketPath, "plain"),
      requestCdpSupervisorMode(bridge.endpoint.socketPath, "plain"),
    ]);
    expect(both).toEqual(["plain", "plain"]);
    expect(launches(bridge)).toHaveLength(2);

    const back = await Promise.all([
      requestCdpSupervisorMode(bridge.endpoint.socketPath, "cdp"),
      requestCdpSupervisorMode(bridge.endpoint.socketPath, "cdp"),
    ]);
    expect(back).toEqual(["cdp", "cdp"]);
    expect(launches(bridge)).toHaveLength(3);
    expect(bridge.child.exitCode).toBeNull();
  });

  it("ends the plain browser and itself on POST /close", async () => {
    const bridge = await startHandoffBridge();
    const { endpointFile, socketPath } = cdpPaths(bridge.dir);
    await requestCdpSupervisorMode(bridge.endpoint.socketPath, "plain");
    const plain = lastLaunch(bridge);
    const exited = once(bridge.child, "exit");

    expect((await postStatus(bridge.endpoint.socketPath, "/close")).status).toBe(202);
    await exited;
    expect(fs.readFileSync(path.join(bridge.dir, "sigterm.log"), "utf8").trim()).toBe(String(plain.pid));
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(endpointFile)).toBe(false);
  });

  it("stays up when the person closes the plain browser, and reopens the last session on /cdp", async () => {
    const bridge = await startHandoffBridge();
    await requestCdpSupervisorMode(bridge.endpoint.socketPath, "plain");
    process.kill(lastLaunch(bridge).pid, "SIGTERM");

    await expect.poll(() => publishedMode(bridge)).toBe("plain-idle");
    await delay(200);
    expect(bridge.child.exitCode).toBeNull();
    expect(await requestCdpSupervisorMode(bridge.endpoint.socketPath, "plain")).toBe("plain-idle");

    expect(await requestCdpSupervisorMode(bridge.endpoint.socketPath, "cdp")).toBe("cdp");
    expect(lastLaunch(bridge).argv).toContain("--restore-last-session");
    expect(await publishedMode(bridge)).toBe("cdp");
  });

  it("reopens CDP and answers an error when the plain browser does not start", async () => {
    const bridge = await startHandoffBridge();
    fs.writeFileSync(path.join(bridge.dir, "plain-fails"), "");

    const answer = await postStatus(bridge.endpoint.socketPath, "/plain");
    expect(answer.status).toBe(500);
    expect(JSON.parse(answer.body)).toEqual({
      error: "The plain browser exited during startup; the browser is back under CDP",
      mode: "cdp",
    });
    await expect(requestCdpSupervisorMode(bridge.endpoint.socketPath, "plain")).rejects.toThrow(
      "could not switch to plain: The plain browser exited during startup",
    );
    expect(lastLaunch(bridge).argv).toContain("--remote-debugging-pipe");
    expect(await publishedMode(bridge)).toBe("cdp");
    expect(bridge.child.exitCode).toBeNull();
  });

  it("returns to CDP by itself once the human lease is gone or expired", async () => {
    const bridge = await startHandoffBridge();
    await requestCdpSupervisorMode(bridge.endpoint.socketPath, "plain");
    // A lease within the grace past its expiry still holds.
    holdHumanLease(bridge, -1_000);
    await delay(1_500);
    expect(await publishedMode(bridge)).toBe("plain");

    holdHumanLease(bridge, -10_000);
    await expect.poll(() => publishedMode(bridge), { timeout: 10_000 }).toBe("cdp");
    expect(lastLaunch(bridge).argv).toContain("--restore-last-session");

    holdHumanLease(bridge);
    await requestCdpSupervisorMode(bridge.endpoint.socketPath, "plain");
    fs.rmSync(path.join(bridge.dir, HUMAN_LEASE_FILE));
    await expect.poll(() => publishedMode(bridge), { timeout: 10_000 }).toBe("cdp");
    expect(bridge.child.exitCode).toBeNull();
  });
});

describe("readCdpEndpoint", () => {
  const valid = { socketPath: "/tmp/pickforge-browser-1/abc/cdp.sock", browserPath: "/devtools/browser/0b4a3f0e-1f6c-4c2e-9a77-2d2f6f1b9e10" };

  it("reads a private endpoint file and treats a missing one as not published", async () => {
    const dir = temporaryDirectory();
    const file = path.join(dir, "cdp-endpoint");
    await expect(readCdpEndpoint(file)).resolves.toBeUndefined();
    fs.writeFileSync(file, JSON.stringify(valid), { mode: 0o600 });
    await expect(readCdpEndpoint(file)).resolves.toEqual(valid);
    fs.writeFileSync(file, JSON.stringify({ ...valid, mode: "plain-idle" }), { mode: 0o600 });
    await expect(readCdpEndpoint(file)).resolves.toEqual({ ...valid, mode: "plain-idle" });
  });

  it("refuses a group-readable file, a symlink, and malformed content", async () => {
    const dir = temporaryDirectory();
    const file = path.join(dir, "cdp-endpoint");
    fs.writeFileSync(file, JSON.stringify(valid), { mode: 0o640 });
    fs.chmodSync(file, 0o640);
    await expect(readCdpEndpoint(file)).rejects.toThrow("mode 0600");

    const target = path.join(dir, "elsewhere");
    fs.writeFileSync(target, JSON.stringify(valid), { mode: 0o600 });
    fs.rmSync(file);
    fs.symlinkSync(target, file);
    await expect(readCdpEndpoint(file)).rejects.toThrow();

    for (const content of [
      "45123\n/devtools/browser/abc\n",
      JSON.stringify({ ...valid, socketPath: "relative/cdp.sock" }),
      JSON.stringify({ ...valid, browserPath: "/json/version" }),
      JSON.stringify({ ...valid, mode: "headless" }),
    ]) {
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, content, { mode: 0o600 });
      await expect(readCdpEndpoint(file)).rejects.toThrow("Invalid CDP endpoint file");
    }
  });
});
