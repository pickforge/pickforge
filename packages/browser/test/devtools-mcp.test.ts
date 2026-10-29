import fs from "node:fs";
import { spawn, type SpawnOptions } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PERMITS_DIR,
  acquireHumanLease,
  createSession,
  destroySessionRecord,
  readProcessIdentity,
  releaseHumanLease,
  sessionDataDir,
  stopSessionAgentInput,
  updateSession,
  type SessionRecord,
} from "@pickforge/lab-core";
import {
  createDeferred,
  CHROME_DEVTOOLS_MCP_BIN,
  CHROME_DEVTOOLS_MCP_VERSION,
  SESSION_CHECK_FAILED_ERROR_CODE,
  SESSION_ENDED_ERROR_CODE,
  TAKEOVER_BUSY_ERROR_CODE,
  createDevtoolsPermitGate,
  DEVTOOLS_PERMIT_WATCH_MS,
  createSessionEndedIntercept,
  createTakeoverBusyIntercept,
  resolveDevtoolsMcpExecutable,
  resolveLiveBrowserSession,
  runDevtoolsMcpRelay,
  type BrowserSessionStatus,
  type DevtoolsMcpExecutable,
  type LiveBrowserSession,
  type RelaySignalSource,
} from "../src/index.js";

// A test can pause a lease check of the relay right after its read.
const leaseRead = vi.hoisted(() => ({ after: undefined as ((lease: unknown) => Promise<void>) | undefined }));
vi.mock("@pickforge/lab-core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@pickforge/lab-core")>();
  return {
    ...core,
    checkHumanLeaseBusy: async (...args: Parameters<typeof core.checkHumanLeaseBusy>) => {
      const lease = await core.checkHumanLeaseBusy(...args);
      await leaseRead.after?.(lease);
      return lease;
    },
  };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  leaseRead.after = undefined;
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-devtools-mcp-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await delay(10);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Timed out waiting for ${filePath}`);
  }
}

function writePackage(
  overrides: Record<string, unknown> = {},
): { manifestPath: string; root: string } {
  const root = temporaryDirectory();
  const binPath = path.join(root, CHROME_DEVTOOLS_MCP_BIN);
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, "// fake upstream\n");
  const manifestPath = path.join(root, "package.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      name: "chrome-devtools-mcp",
      version: CHROME_DEVTOOLS_MCP_VERSION,
      bin: { "chrome-devtools-mcp": CHROME_DEVTOOLS_MCP_BIN },
      ...overrides,
    }),
  );
  return { manifestPath, root };
}

function browserRecord(
  id: string,
  projectDir: string,
  status: SessionRecord["status"] = "running",
): SessionRecord {
  return {
    id,
    type: "browser",
    createdAt: "2026-07-12T00:00:00.000Z",
    status,
    projectDir,
    desktop: { display: ":200", xvfbPid: 11 },
    browser: {
      browserPid: 12,
      browserStartTimeTicks: 13,
      binaryPath: "/chrome",
      profileMode: "ephemeral",
      profileDir: "/profile",
      cdpPort: 9222,
    },
  };
}

function browserStatus(
  record: SessionRecord,
  alive: boolean,
  cdpPort = 9222,
): BrowserSessionStatus {
  return {
    record,
    xvfbAlive: alive,
    displayAlive: alive,
    browserAlive: alive,
    alive,
    cdpPort,
  };
}

function collect(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
}

function fakeExecutable(scriptPath: string): DevtoolsMcpExecutable {
  return {
    packageJsonPath: path.join(path.dirname(scriptPath), "package.json"),
    packageRoot: path.dirname(scriptPath),
    binPath: scriptPath,
    version: CHROME_DEVTOOLS_MCP_VERSION,
  };
}

function fakeSession(): LiveBrowserSession {
  const record = browserRecord("brow-abcdef12", "/project");
  return { record, cdpPort: 9333, browserEndpoint: "ws://127.0.0.1:9333/devtools/browser/fake-guid" };
}

class Signals extends EventEmitter implements RelaySignalSource {
  override on(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): this {
    return super.on(signal, listener);
  }

  override off(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): this {
    return super.off(signal, listener);
  }
}

describe("resolveDevtoolsMcpExecutable", () => {
  it("accepts only the installed exact package, version, and declared bin", async () => {
    const actual = await resolveDevtoolsMcpExecutable();
    expect(actual.version).toBe("1.5.0");
    expect(actual.binPath.endsWith("build/src/bin/chrome-devtools-mcp.js")).toBe(true);

    const fixture = writePackage();
    await expect(resolveDevtoolsMcpExecutable(fixture.manifestPath)).resolves.toMatchObject({
      packageRoot: fixture.root,
      version: "1.5.0",
    });
  });

  it.each([
    [{ name: "lookalike" }, "package name"],
    [{ version: "1.5.1" }, "version mismatch"],
    [{ bin: {} }, "Invalid Chrome DevTools MCP bin"],
    [
      { bin: { "chrome-devtools-mcp": "../outside.js" } },
      "Invalid Chrome DevTools MCP bin",
    ],
  ] as const)("rejects a wrong manifest %#", async (overrides, message) => {
    const fixture = writePackage(overrides);
    await expect(resolveDevtoolsMcpExecutable(fixture.manifestPath)).rejects.toThrow(
      message,
    );
  });

  it("rejects an exact lexical bin whose symlink escapes the package", async () => {
    const fixture = writePackage();
    const outside = path.join(temporaryDirectory(), "outside.js");
    fs.writeFileSync(outside, "// outside\n");
    fs.rmSync(path.join(fixture.root, CHROME_DEVTOOLS_MCP_BIN));
    fs.symlinkSync(outside, path.join(fixture.root, CHROME_DEVTOOLS_MCP_BIN));
    await expect(resolveDevtoolsMcpExecutable(fixture.manifestPath)).rejects.toThrow(
      "symlink escapes",
    );
  });
});

const fakeEndpoint = async (record: SessionRecord, cdpPort: number): Promise<URL> =>
  new URL(`ws://127.0.0.1:${cdpPort}/devtools/browser/guid-${record.id}`);

describe("resolveLiveBrowserSession", () => {
  it("resolves exactly one live project-local browser and pins its browser endpoint", async () => {
    const project = path.resolve("/wanted");
    const wanted = browserRecord("brow-aaaaaa11", project);
    const other = browserRecord("brow-bbbbbb22", "/other");
    const dead = browserRecord("brow-cccccc33", project);
    const resolved = await resolveLiveBrowserSession({
      projectDir: project,
      env: {},
      list: async () => [other, dead, wanted],
      status: async (id) => browserStatus(id === wanted.id ? wanted : dead, id === wanted.id, 9444),
      endpoint: fakeEndpoint,
    });
    expect(resolved.record.id).toBe(wanted.id);
    expect(resolved.browserEndpoint).toBe(
      "ws://127.0.0.1:9444/devtools/browser/guid-brow-aaaaaa11",
    );
  });

  it("fails closed when the session's own browser endpoint is unreadable", async () => {
    const project = path.resolve("/wanted");
    const one = browserRecord("brow-aaaaaa11", project);
    for (const endpoint of [
      async () => undefined,
      async () => {
        throw new Error("ENOENT");
      },
    ]) {
      await expect(
        resolveLiveBrowserSession({
          projectDir: project,
          env: {},
          list: async () => [one],
          status: async () => browserStatus(one, true),
          endpoint,
        }),
      ).rejects.toThrow("No live browser session for this project");
    }
  });

  it("fails closed for dead, other-project, missing-port, and ambiguous sessions", async () => {
    const project = "/wanted";
    const one = browserRecord("brow-aaaaaa11", project);
    const two = browserRecord("brow-bbbbbb22", project);
    const other = browserRecord("brow-cccccc33", "/other");
    await expect(
      resolveLiveBrowserSession({
        projectDir: project,
        env: {},
        list: async () => [one, other],
        status: async (id) => browserStatus(id === one.id ? one : other, false),
        endpoint: fakeEndpoint,
      }),
    ).rejects.toThrow("No live browser session for this project");
    await expect(
      resolveLiveBrowserSession({
        projectDir: project,
        env: {},
        list: async () => [one],
        status: async () => browserStatus(one, true, 0),
        endpoint: fakeEndpoint,
      }),
    ).rejects.toThrow("No live browser session for this project");
    await expect(
      resolveLiveBrowserSession({
        projectDir: project,
        env: {},
        list: async () => [one, two],
        status: async (id) => browserStatus(id === one.id ? one : two, true),
        endpoint: fakeEndpoint,
      }),
    ).rejects.toThrow(`Multiple live browser sessions for this project (${one.id}, ${two.id})`);
  });
});

describe("createTakeoverBusyIntercept", () => {
  it("blocks tools/call while a human lease is active, and only that", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-takeover-intercept-"));
    temporaryDirectories.push(tmp);
    const env = { PICKFORGE_HOME: path.join(tmp, "home") };
    fs.mkdirSync(path.join(env.PICKFORGE_HOME, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(env.PICKFORGE_HOME, "sessions", "brow-aaaaaa11.json"), JSON.stringify({ id: "brow-aaaaaa11", status: "running" }));
    const intercept = createTakeoverBusyIntercept("brow-aaaaaa11", env);

    // No lease yet: everything passes through.
    expect(
      await intercept({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    ).toBeUndefined();

    const lease = await acquireHumanLease("brow-aaaaaa11", env);

    // Non-tool-call requests and notifications (no id) are never blocked.
    expect(
      await intercept({ jsonrpc: "2.0", id: "x", method: "tools/list" }),
    ).toBeUndefined();
    expect(
      await intercept({ jsonrpc: "2.0", method: "notifications/cancelled" }),
    ).toBeUndefined();

    const blocked = await intercept({ jsonrpc: "2.0", id: 2, method: "tools/call" });
    expect(blocked).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: TAKEOVER_BUSY_ERROR_CODE,
        message:
          "Pickforge: human control is active; agent input is paused until control returns",
      },
    });

    await releaseHumanLease("brow-aaaaaa11", lease.leaseId, env);
    expect(
      await intercept({ jsonrpc: "2.0", id: 3, method: "tools/call" }),
    ).toBeUndefined();
  });
});

async function liveSession(env: { PICKFORGE_HOME: string }): Promise<LiveBrowserSession> {
  const identity = readProcessIdentity(process.pid);
  if (identity?.startTicks === undefined) throw new Error("own process identity is unavailable");
  const record = await createSession(
    {
      type: "browser",
      projectDir: "/project",
      status: "running",
      browser: {
        browserPid: process.pid,
        browserStartTimeTicks: identity.startTicks,
        binaryPath: "/chrome",
        profileMode: "ephemeral",
        profileDir: "/profile",
        cdpPort: 9222,
      },
    },
    env,
  );
  return {
    record,
    cdpPort: 9222,
    browserEndpoint: "ws://127.0.0.1:9222/devtools/browser/fake-guid",
  };
}

function registryEnv(): { PICKFORGE_HOME: string } {
  return { PICKFORGE_HOME: path.join(temporaryDirectory(), "home") };
}

describe("createSessionEndedIntercept", () => {
  const ended = (id: number) => ({
    jsonrpc: "2.0",
    id,
    error: {
      code: SESSION_ENDED_ERROR_CODE,
      message:
        "Pickforge: the browser session has ended; create a new session and restart the DevTools relay",
    },
  });

  it("passes tool calls while the session and its Chrome are live", async () => {
    const env = registryEnv();
    const intercept = createSessionEndedIntercept(await liveSession(env), env);
    expect(await intercept({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toBeUndefined();
  });

  it("blocks every later tool call once the session record is destroyed", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const intercept = createSessionEndedIntercept(session, env);
    await destroySessionRecord(session.record.id, env);
    expect(await intercept({ jsonrpc: "2.0", id: 2, method: "tools/call" })).toEqual(ended(2));
    // Notifications and non-tool requests still pass, so the client can shut down.
    expect(await intercept({ jsonrpc: "2.0", id: "x", method: "tools/list" })).toBeUndefined();
    expect(await intercept({ jsonrpc: "2.0", method: "notifications/cancelled" })).toBeUndefined();
  });

  it("blocks once teardown closes session input, before the record is removed", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const intercept = createSessionEndedIntercept(session, env);
    await stopSessionAgentInput(session.record.id, env);
    expect(await intercept({ jsonrpc: "2.0", id: 3, method: "tools/call" })).toEqual(ended(3));
  });

  it("stays closed after the session leaves running, even if the record returns", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const intercept = createSessionEndedIntercept(session, env);
    await updateSession(session.record.id, { status: "error" }, env);
    expect(await intercept({ jsonrpc: "2.0", id: 4, method: "tools/call" })).toEqual(ended(4));
    await updateSession(session.record.id, { status: "running" }, env);
    expect(await intercept({ jsonrpc: "2.0", id: 5, method: "tools/call" })).toEqual(ended(5));
  });

  // Root reads the record despite its mode, so the check cannot fail there.
  it.skipIf(process.getuid?.() === 0)("refuses only the call whose session check cannot read the record", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const intercept = createSessionEndedIntercept(session, env);
    const record = path.join(env.PICKFORGE_HOME, "sessions", `${session.record.id}.json`);
    fs.chmodSync(record, 0);
    try {
      expect(await intercept({ jsonrpc: "2.0", id: 8, method: "tools/call" })).toEqual({
        jsonrpc: "2.0",
        id: 8,
        error: {
          code: SESSION_CHECK_FAILED_ERROR_CODE,
          message: "Pickforge: could not check the browser session; try the call again",
        },
      });
    } finally {
      fs.chmodSync(record, 0o600);
    }
    expect(await intercept({ jsonrpc: "2.0", id: 9, method: "tools/call" })).toBeUndefined();
  });

  it("blocks when the session's Chrome is no longer the pinned live process", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const pinned = session.record.browser;
    if (pinned === undefined) throw new Error("missing browser leg");
    const moved = createSessionEndedIntercept(session, env);
    await updateSession(
      session.record.id,
      { browser: { ...pinned, browserStartTimeTicks: pinned.browserStartTimeTicks + 1 } },
      env,
    );
    expect(await moved({ jsonrpc: "2.0", id: 6, method: "tools/call" })).toEqual(ended(6));

    const other = await liveSession(env);
    const dead = createSessionEndedIntercept(
      {
        ...other,
        record: {
          ...other.record,
          browser: { ...pinned, browserStartTimeTicks: pinned.browserStartTimeTicks + 1 },
        },
      },
      env,
    );
    await updateSession(
      other.record.id,
      { browser: { ...pinned, browserStartTimeTicks: pinned.browserStartTimeTicks + 1 } },
      env,
    );
    expect(await dead({ jsonrpc: "2.0", id: 7, method: "tools/call" })).toEqual(ended(7));
  });
});

describe("runDevtoolsMcpRelay", () => {
  it("spawns Node with exact argv/env, relays protocol only, and redacts stderr", async () => {
    const dir = temporaryDirectory();
    const recordPath = path.join(dir, "spawn.json");
    const script = path.join(dir, "fake-upstream.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'fs.writeFileSync(process.env.RECORD_PATH, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));',
        'process.stderr.write("authorization=Bearer super-secret-token\\n");',
        'process.stdin.pipe(process.stdout);',
      ].join("\n"),
    );
    const output: Buffer[] = [];
    const diagnostics: Buffer[] = [];
    const request = '{ "jsonrpc":"2.0", "id":"request-1", "method":"tools/list" }\r\n';
    let spawnedCommand: string | undefined;
    let spawnedArgs: string[] | undefined;
    let spawnedOptions: SpawnOptions | undefined;
    const exit = await runDevtoolsMcpRelay({
      session: fakeSession(),
      executable: fakeExecutable(script),
      input: Readable.from([request]),
      output: collect(output),
      diagnostics: collect(diagnostics),
      env: { PATH: process.env.PATH, RECORD_PATH: recordPath },
      cwd: dir,
      signalSource: new Signals(),
      spawnProcess: (command, args, options) => {
        spawnedCommand = command;
        spawnedArgs = args;
        spawnedOptions = options;
        return spawn(command, args, options);
      },
      shutdownTimeoutMs: 5_000,
    });
    expect(exit).toEqual({ code: 0, signal: null });
    expect(spawnedCommand).toBe(process.execPath);
    expect(spawnedArgs).toEqual([
      script,
      "--wsEndpoint",
      "ws://127.0.0.1:9333/devtools/browser/fake-guid",
    ]);
    expect(spawnedOptions).toMatchObject({
      cwd: dir,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(Buffer.concat(output).toString()).toBe(request);
    expect(Buffer.concat(output).toString()).not.toContain("authorization");
    const diagnosticText = Buffer.concat(diagnostics).toString();
    expect(diagnosticText).toContain("authorization=[REDACTED]");
    expect(diagnosticText).not.toContain("super-secret-token");
    const observed: unknown = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    expect(observed).toMatchObject({
      argv: ["--wsEndpoint", "ws://127.0.0.1:9333/devtools/browser/fake-guid"],
      env: {
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "true",
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "true",
      },
    });
  });

  it("applies before-forward and after-response hooks without changing IDs", async () => {
    const dir = temporaryDirectory();
    const script = path.join(dir, "hook-upstream.mjs");
    fs.writeFileSync(script, 'process.stdin.pipe(process.stdout);\n');
    const output: Buffer[] = [];
    await runDevtoolsMcpRelay({
      session: fakeSession(),
      executable: fakeExecutable(script),
      input: Readable.from(['{"jsonrpc":"2.0","id":7,"method":"tools/call"}\n']),
      output: collect(output),
      diagnostics: collect([]),
      signalSource: new Signals(),
      shutdownTimeoutMs: 5_000,
      hooks: {
        beforeForward: (message) => ({ ...message, params: { before: true } }),
        afterResponse: (message) => ({ ...message, observed: true }),
      },
    });
    expect(JSON.parse(Buffer.concat(output).toString())).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { before: true },
      observed: true,
    });
  });

  it("intercepts a blocked request without ever reaching the child process", async () => {
    const dir = temporaryDirectory();
    const script = path.join(dir, "intercept-upstream.mjs");
    fs.writeFileSync(script, 'process.stdin.pipe(process.stdout);\n');
    const output: Buffer[] = [];
    await runDevtoolsMcpRelay({
      session: fakeSession(),
      executable: fakeExecutable(script),
      input: Readable.from(['{"jsonrpc":"2.0","id":9,"method":"tools/call"}\n']),
      output: collect(output),
      diagnostics: collect([]),
      signalSource: new Signals(),
      shutdownTimeoutMs: 200,
      hooks: {
        intercept: (message) =>
          message.method === "tools/call"
            ? {
                jsonrpc: "2.0",
                id: message.id as number,
                error: { code: TAKEOVER_BUSY_ERROR_CODE, message: "busy" },
              }
            : undefined,
      },
    });
    expect(JSON.parse(Buffer.concat(output).toString())).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: TAKEOVER_BUSY_ERROR_CODE, message: "busy" },
    });
  });

  it("propagates the observed upstream exit code", async () => {
    const dir = temporaryDirectory();
    const script = path.join(dir, "exit-upstream.mjs");
    fs.writeFileSync(script, "process.exit(7);\n");
    await expect(
      runDevtoolsMcpRelay({
        session: fakeSession(),
        executable: fakeExecutable(script),
        input: new PassThrough(),
        output: collect([]),
        diagnostics: collect([]),
        signalSource: new Signals(),
        shutdownTimeoutMs: 20,
      }),
    ).resolves.toEqual({ code: 7, signal: null });
  });

  it("force-kills a stubborn child after error while aborting held stdin", async () => {
    const dir = temporaryDirectory();
    const readyPath = path.join(dir, "child-error-ready");
    const script = path.join(dir, "child-error-upstream.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'import net from "node:net";',
        'process.on("SIGTERM", () => {});',
        'net.createServer().listen(0, "127.0.0.1");',
        'fs.writeFileSync(process.env.READY_PATH, "ready");',
        "process.stdin.resume();",
      ].join("\n"),
    );
    const input = new PassThrough();
    let childPid: number | undefined;
    await expect(
      runDevtoolsMcpRelay({
        session: fakeSession(),
        executable: fakeExecutable(script),
        input,
        output: collect([]),
        diagnostics: collect([]),
        env: { PATH: process.env.PATH, READY_PATH: readyPath },
        signalSource: new Signals(),
        shutdownTimeoutMs: 20,
        spawnProcess: (command, args, options) => {
          const child = spawn(command, args, options);
          childPid = child.pid;
          void waitForFile(readyPath).then(() => {
            child.emit("error", new Error("synthetic child failure"));
          });
          return child;
        },
      }),
    ).rejects.toThrow("child process error: synthetic child failure");
    if (childPid === undefined) {
      throw new Error("child pid was not observed");
    }
    const observedChildPid = childPid;
    expect(() => process.kill(observedChildPid, 0)).toThrow();
  });

  it("rejects a genuine spawn failure without hanging or retaining signal handlers", async () => {
    const signals = new Signals();
    await expect(
      runDevtoolsMcpRelay({
        session: fakeSession(),
        executable: fakeExecutable("/unreachable/upstream.mjs"),
        input: new PassThrough(),
        output: collect([]),
        diagnostics: collect([]),
        cwd: path.join(temporaryDirectory(), "missing"),
        signalSource: signals,
        shutdownTimeoutMs: 20,
      }),
    ).rejects.toThrow("child process error");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      expect(signals.listenerCount(signal)).toBe(0);
    }
  });

  it("drains a pending response write and ignores stdin abort after clean exit", async () => {
    const dir = temporaryDirectory();
    const script = path.join(dir, "pending-write-upstream.mjs");
    fs.writeFileSync(
      script,
      'process.stdout.write(\'{"jsonrpc":"2.0","id":1,"result":{}}\\n\');\n',
    );
    const writeStarted = createDeferred<void>();
    const releaseWrite = createDeferred<void>();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        writeStarted.resolve();
        void releaseWrite.promise.then(() => callback(), callback);
      },
    });
    const run = runDevtoolsMcpRelay({
      session: fakeSession(),
      executable: fakeExecutable(script),
      input: new PassThrough(),
      output,
      diagnostics: collect([]),
      signalSource: new Signals(),
      shutdownTimeoutMs: 20,
    });
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await writeStarted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseWrite.resolve();
    await expect(run).resolves.toEqual({ code: 0, signal: null });
  });

  it("fails closed when a clean upstream exit leaves a partial record", async () => {
    const dir = temporaryDirectory();
    const script = path.join(dir, "partial-clean-upstream.mjs");
    fs.writeFileSync(
      script,
      'process.stdout.write(\'{"jsonrpc":"2.0","id":1\');\n',
    );
    await expect(
      runDevtoolsMcpRelay({
        session: fakeSession(),
        executable: fakeExecutable(script),
        input: new PassThrough(),
        output: collect([]),
        diagnostics: collect([]),
        signalSource: new Signals(),
        shutdownTimeoutMs: 20,
      }),
    ).rejects.toThrow("incomplete JSON-RPC record");
  });

  it("preserves a forced signal exit despite a partial upstream record", async () => {
    const dir = temporaryDirectory();
    const readyPath = path.join(dir, "partial-ready");
    const script = path.join(dir, "partial-signal-upstream.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'process.stdout.write(\'{"jsonrpc":"2.0","id":1\');',
        'fs.writeFileSync(process.env.READY_PATH, "ready");',
        "process.stdin.resume();",
      ].join("\n"),
    );
    const signals = new Signals();
    const run = runDevtoolsMcpRelay({
      session: fakeSession(),
      executable: fakeExecutable(script),
      input: new PassThrough(),
      output: collect([]),
      diagnostics: collect([]),
      env: { PATH: process.env.PATH, READY_PATH: readyPath },
      signalSource: signals,
      shutdownTimeoutMs: 20,
    });
    await waitForFile(readyPath);
    signals.emit("SIGTERM");
    await expect(run).resolves.toEqual({ code: null, signal: "SIGTERM" });
  });

  it("drops a fragmented over-limit diagnostic line without leaking it", async () => {
    const dir = temporaryDirectory();
    const script = path.join(dir, "long-diagnostic-upstream.mjs");
    fs.writeFileSync(
      script,
      [
        'process.stderr.write("secret-");',
        'process.stderr.write("fragment-");',
        'process.stderr.write("overflow\\n");',
      ].join("\n"),
    );
    const diagnostics: Buffer[] = [];
    await expect(
      runDevtoolsMcpRelay({
        session: fakeSession(),
        executable: fakeExecutable(script),
        input: new PassThrough(),
        output: collect([]),
        diagnostics: collect(diagnostics),
        signalSource: new Signals(),
        shutdownTimeoutMs: 20,
        maxDiagnosticLineBytes: 12,
      }),
    ).resolves.toEqual({ code: 0, signal: null });
    const text = Buffer.concat(diagnostics).toString();
    expect(text).toContain("exceeded 12 bytes and was dropped");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("overflow");
  });

  it("fails closed and force-kills a hung upstream after malformed child output", async () => {
    const dir = temporaryDirectory();
    const pidPath = path.join(dir, "pid");
    const script = path.join(dir, "malformed-upstream.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'fs.writeFileSync(process.env.PID_PATH, String(process.pid));',
        'process.on("SIGTERM", () => {});',
        'process.stdout.write("not-json\\n");',
      ].join("\n"),
    );
    const input = new PassThrough();
    const run = runDevtoolsMcpRelay({
      session: fakeSession(),
      executable: fakeExecutable(script),
      input,
      output: collect([]),
      diagnostics: collect([]),
      env: { PATH: process.env.PATH, PID_PATH: pidPath },
      signalSource: new Signals(),
      shutdownTimeoutMs: 20,
    });
    await expect(run).rejects.toThrow("malformed JSON-RPC record");
    const pid = Number(fs.readFileSync(pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("fails closed without forwarding malformed outer input", async () => {
    const dir = temporaryDirectory();
    const script = path.join(dir, "input-upstream.mjs");
    fs.writeFileSync(
      script,
      [
        'process.on("SIGTERM", () => {});',
        "process.stdin.resume();",
      ].join("\n"),
    );
    const output: Buffer[] = [];
    await expect(
      runDevtoolsMcpRelay({
        session: fakeSession(),
        executable: fakeExecutable(script),
        input: Readable.from(["not-json\n"]),
        output: collect(output),
        diagnostics: collect([]),
        signalSource: new Signals(),
        shutdownTimeoutMs: 20,
      }),
    ).rejects.toThrow("malformed JSON-RPC record");
    expect(output).toEqual([]);
  });

  it("closes child stdin on EOF and kills an upstream that refuses to exit", async () => {
    const dir = temporaryDirectory();
    const readyPath = path.join(dir, "ready");
    const script = path.join(dir, "hung-upstream.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'import net from "node:net";',
        'process.on("SIGTERM", () => {});',
        'net.createServer().listen(0, "127.0.0.1");',
        'fs.writeFileSync(process.env.READY_PATH, "ready");',
      ].join("\n"),
    );
    const input = new PassThrough();
    const run = runDevtoolsMcpRelay({
      session: fakeSession(),
      executable: fakeExecutable(script),
      input,
      output: collect([]),
      diagnostics: collect([]),
      env: { PATH: process.env.PATH, READY_PATH: readyPath },
      signalSource: new Signals(),
      shutdownTimeoutMs: 20,
    });
    await waitForFile(readyPath);
    input.end();
    await expect(run).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it("forwards signals and force-kills an upstream that ignores them", async () => {
    const dir = temporaryDirectory();
    const readyPath = path.join(dir, "ready");
    const script = path.join(dir, "signal-upstream.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'process.on("SIGTERM", () => {});',
        'fs.writeFileSync(process.env.READY_PATH, "ready");',
        'process.stdin.resume();',
      ].join("\n"),
    );
    const signals = new Signals();
    const input = new PassThrough();
    const run = runDevtoolsMcpRelay({
      session: fakeSession(),
      executable: fakeExecutable(script),
      input,
      output: collect([]),
      diagnostics: collect([]),
      env: { PATH: process.env.PATH, READY_PATH: readyPath },
      signalSource: signals,
      shutdownTimeoutMs: 20,
    });
    await waitForFile(readyPath);
    signals.emit("SIGTERM");
    await expect(run).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });
});

describe("DevTools relay agent permits", () => {
  interface HeldCallChild {
    script: string;
    env: Record<string, string | undefined>;
    seen: string;
    release: string;
    pid: string;
  }

  // Records each tools/call id. Answers at once, holds the call until the
  // release file exists ("hold"), or exits ("exit").
  function heldCallChild(env: { PICKFORGE_HOME: string }): HeldCallChild {
    const dir = temporaryDirectory();
    const script = path.join(dir, "held-call-upstream.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'import readline from "node:readline";',
        "fs.writeFileSync(process.env.PID_PATH, String(process.pid));",
        "const answer = (id, done) =>",
        '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } }) + "\\n", done);',
        'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
        "  const message = JSON.parse(line);",
        '  if (message.method !== "tools/call") return;',
        '  fs.appendFileSync(process.env.SEEN_PATH, JSON.stringify(message.id) + "\\n");',
        "  if (message.params?.exit) process.exit(3);",
        '  if (message.params?.answerOnTerm) process.once("SIGTERM", () => answer(message.id, () => process.exit(0)));',
        "  if (!message.params?.hold) return answer(message.id);",
        "  const timer = setInterval(() => {",
        "    if (!fs.existsSync(process.env.RELEASE_PATH)) return;",
        "    clearInterval(timer);",
        "    answer(message.id);",
        "  }, 10);",
        "});",
      ].join("\n"),
    );
    const seen = path.join(dir, "seen");
    const release = path.join(dir, "release");
    const pid = path.join(dir, "pid");
    return {
      script,
      seen,
      release,
      pid,
      env: { ...env, PATH: process.env.PATH, SEEN_PATH: seen, RELEASE_PATH: release, PID_PATH: pid },
    };
  }

  function permitCount(id: string, env: { PICKFORGE_HOME: string }): number {
    const dir = path.join(sessionDataDir(id, env), AGENT_PERMITS_DIR);
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  }

  function seenIds(child: HeldCallChild): unknown[] {
    if (!fs.existsSync(child.seen)) return [];
    return fs.readFileSync(child.seen, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  }

  function responses(output: Buffer[]): Record<string, unknown>[] {
    return Buffer.concat(output)
      .toString()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  const call = (id: number | string, params: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params })}\n`;

  // The same gates `runProjectDevtoolsMcp` composes, with the permit gate last.
  function runGatedRelay(
    session: LiveBrowserSession,
    env: { PICKFORGE_HOME: string },
    child: HeldCallChild,
    input: Readable,
    output: Buffer[] | Writable,
    watchMs = DEVTOOLS_PERMIT_WATCH_MS,
  ): Promise<unknown> {
    const ended = createSessionEndedIntercept(session, env);
    const busy = createTakeoverBusyIntercept(session.record.id, env);
    return runDevtoolsMcpRelay({
      session,
      executable: fakeExecutable(child.script),
      input,
      output: Array.isArray(output) ? collect(output) : output,
      diagnostics: collect([]),
      env: child.env,
      signalSource: new Signals(),
      shutdownTimeoutMs: 500,
      hooks: { intercept: async (message) => (await ended(message)) ?? (await busy(message)) },
      permits: createDevtoolsPermitGate(session.record.id, env, watchMs),
    });
  }

  async function waitForSeen(child: HeldCallChild, count: number): Promise<void> {
    await expect.poll(() => seenIds(child).length).toBe(count);
  }

  it("holds a permit for an in-flight call and ends it when teardown closes input", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const child = heldCallChild(env);
    const input = new PassThrough();
    const output: Buffer[] = [];
    let relayExited = false;
    const run = runGatedRelay(session, env, child, input, output).finally(() => {
      relayExited = true;
    });
    input.write(call(1, { hold: true }));
    await waitForSeen(child, 1);
    expect(permitCount(session.record.id, env)).toBe(1);

    const started = Date.now();
    await stopSessionAgentInput(session.record.id, env, 5_000);
    // The drain waited for the child, so the forwarded call can no longer reach Chrome.
    const childPid = Number(fs.readFileSync(child.pid, "utf8"));
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    await run;
    expect(relayExited).toBe(true);
    // Nothing reads the input any more; an open one would keep the process alive.
    expect(input.destroyed).toBe(true);
    expect(responses(output)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: SESSION_ENDED_ERROR_CODE,
          message:
            "Pickforge: the browser session has ended; create a new session and restart the DevTools relay",
        },
      },
    ]);
    expect(permitCount(session.record.id, env)).toBe(0);
  });

  it("keeps the relay when teardown closes input after the last call was answered", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const child = heldCallChild(env);
    const input = new PassThrough();
    const output: Buffer[] = [];
    // A long watch interval puts its last check after teardown.
    const run = runGatedRelay(session, env, child, input, output, 1_000);
    input.write(call(1));
    await expect.poll(() => responses(output).length).toBe(1);
    await stopSessionAgentInput(session.record.id, env, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(input.destroyed).toBe(false);
    input.write(call(2));
    await expect.poll(() => responses(output).length).toBe(2);
    expect(responses(output)[1]).toMatchObject({ id: 2, error: { code: SESSION_ENDED_ERROR_CODE } });
    input.end();
    await run;
  });

  it("lets takeover drain while a call is in flight and still forwards its response", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const child = heldCallChild(env);
    const input = new PassThrough();
    const output: Buffer[] = [];
    const run = runGatedRelay(session, env, child, input, output);
    input.write(call(1, { hold: true }));
    await waitForSeen(child, 1);
    expect(permitCount(session.record.id, env)).toBe(1);

    const lease = await acquireHumanLease(session.record.id, env);
    expect(permitCount(session.record.id, env)).toBe(0);
    fs.writeFileSync(child.release, "");
    await expect.poll(() => responses(output).length).toBe(1);
    expect(responses(output)[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [] } });

    input.write(call(2));
    await expect.poll(() => responses(output).length).toBe(2);
    expect(responses(output)[1]).toMatchObject({ id: 2, error: { code: TAKEOVER_BUSY_ERROR_CODE } });
    expect(seenIds(child)).toEqual([1]);

    await releaseHumanLease(session.record.id, lease.leaseId, env);
    input.end();
    await run;
    expect(permitCount(session.record.id, env)).toBe(0);
  });

  it("refuses calls with stable errors, holds no permit, and forwards nothing", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const child = heldCallChild(env);
    const input = new PassThrough();
    const output: Buffer[] = [];
    // The permit gate alone, without the earlier intercepts, refuses the call.
    const run = runDevtoolsMcpRelay({
      session,
      executable: fakeExecutable(child.script),
      input,
      output: collect(output),
      diagnostics: collect([]),
      env: child.env,
      signalSource: new Signals(),
      shutdownTimeoutMs: 500,
      permits: createDevtoolsPermitGate(session.record.id, env),
    });
    const lease = await acquireHumanLease(session.record.id, env);
    input.write(call(1));
    await expect.poll(() => responses(output).length).toBe(1);
    await releaseHumanLease(session.record.id, lease.leaseId, env);
    await stopSessionAgentInput(session.record.id, env);
    input.write(call(2));
    await expect.poll(() => responses(output).length).toBe(2);
    input.end();
    await run;
    expect(responses(output)).toMatchObject([
      { id: 1, error: { code: TAKEOVER_BUSY_ERROR_CODE } },
      { id: 2, error: { code: SESSION_ENDED_ERROR_CODE } },
    ]);
    expect(seenIds(child)).toEqual([]);
    expect(permitCount(session.record.id, env)).toBe(0);
  });

  it("latches the end for a session that left running and passes other messages", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const gate = createDevtoolsPermitGate(session.record.id, env);
    expect(await gate.intercept({ jsonrpc: "2.0", id: "x", method: "tools/list" })).toBeUndefined();
    expect(await gate.intercept({ jsonrpc: "2.0", method: "notifications/cancelled" })).toBeUndefined();
    expect(permitCount(session.record.id, env)).toBe(0);
    await updateSession(session.record.id, { status: "error" }, env);
    expect(await gate.intercept({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toMatchObject({
      id: 1,
      error: { code: SESSION_ENDED_ERROR_CODE },
    });
    await updateSession(session.record.id, { status: "running" }, env);
    expect(await gate.intercept({ jsonrpc: "2.0", id: 2, method: "tools/call" })).toMatchObject({
      id: 2,
      error: { code: SESSION_ENDED_ERROR_CODE },
    });
    expect(permitCount(session.record.id, env)).toBe(0);
    await gate.close();
  });

  // Root reads the record despite its mode, so the check cannot fail there.
  it.skipIf(process.getuid?.() === 0)("refuses only the call whose permit check cannot read the session", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const gate = createDevtoolsPermitGate(session.record.id, env);
    const record = path.join(env.PICKFORGE_HOME, "sessions", `${session.record.id}.json`);
    fs.chmodSync(record, 0);
    try {
      expect(await gate.intercept({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: SESSION_CHECK_FAILED_ERROR_CODE,
          message: "Pickforge: could not check the browser session; try the call again",
        },
      });
    } finally {
      fs.chmodSync(record, 0o600);
    }
    expect(permitCount(session.record.id, env)).toBe(0);
    expect(await gate.intercept({ jsonrpc: "2.0", id: 2, method: "tools/call" })).toBeUndefined();
    expect(permitCount(session.record.id, env)).toBe(1);
    await gate.close();
    expect(permitCount(session.record.id, env)).toBe(0);
  });

  it("releases one permit per response for a reused id", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const gate = createDevtoolsPermitGate(session.record.id, env);
    expect(await gate.intercept({ jsonrpc: "2.0", id: 5, method: "tools/call" })).toBeUndefined();
    expect(await gate.intercept({ jsonrpc: "2.0", id: 5, method: "tools/call" })).toBeUndefined();
    expect(permitCount(session.record.id, env)).toBe(2);
    // A request from the child with the same id is not a response.
    await gate.release({ jsonrpc: "2.0", id: 5, method: "roots/list" });
    await gate.release({ jsonrpc: "2.0", id: "5", result: {} });
    expect(permitCount(session.record.id, env)).toBe(2);
    await gate.release({ jsonrpc: "2.0", id: 5, result: {} });
    expect(permitCount(session.record.id, env)).toBe(1);
    await gate.release({ jsonrpc: "2.0", id: 5, error: { code: 1, message: "failed" } });
    expect(permitCount(session.record.id, env)).toBe(0);
    await gate.release({ jsonrpc: "2.0", id: 5, result: {} });
    expect(gate.takeUnanswered()).toEqual([]);
    await gate.close();
  });

  it("keeps the permit of a call admitted after a lease the watcher read has ended", async () => {
    const env = registryEnv();
    const id = (await liveSession(env)).record.id;
    const gate = createDevtoolsPermitGate(id, env, 10);
    expect(await gate.intercept({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toBeUndefined();
    // The watcher reads the lease, then waits while the call is answered,
    // takeover ends and a new call is admitted.
    const read = createDeferred<void>();
    const resume = createDeferred<void>();
    leaseRead.after = async (lease) => {
      if (lease === undefined) return;
      leaseRead.after = undefined;
      read.resolve();
      await resume.promise;
    };
    const leased = acquireHumanLease(id, env);
    await read.promise;
    await gate.release({ jsonrpc: "2.0", id: 1, result: {} });
    await releaseHumanLease(id, (await leased).leaseId, env);
    expect(await gate.intercept({ jsonrpc: "2.0", id: 2, method: "tools/call" })).toBeUndefined();
    expect(permitCount(id, env)).toBe(1);
    resume.resolve();
    await delay(50);
    expect(permitCount(id, env)).toBe(1);
    await gate.close();
    expect(permitCount(id, env)).toBe(0);
  });

  it("releases every permit when the child exits with calls unanswered", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const child = heldCallChild(env);
    const input = new PassThrough();
    const run = runGatedRelay(session, env, child, input, []);
    input.write(call(1, { hold: true }));
    input.write(call(2, { hold: true }));
    await waitForSeen(child, 2);
    expect(permitCount(session.record.id, env)).toBe(2);
    input.write(call(3, { exit: true }));
    await expect(run).resolves.toEqual({ code: 3, signal: null });
    expect(permitCount(session.record.id, env)).toBe(0);
    // The client still holds the input open; the relay lets go so it can exit.
    expect(input.destroyed).toBe(true);
  });

  it("releases every permit once the child exits, even when the output cannot drain", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const child = heldCallChild(env);
    const input = new PassThrough();
    // A client that stopped reading: no write to it ever completes.
    const output = new Writable({ highWaterMark: 1, write() {} });
    const run = runGatedRelay(session, env, child, input, output);
    input.write(call(1));
    input.write(call(2, { hold: true }));
    await waitForSeen(child, 2);
    await expect.poll(() => permitCount(session.record.id, env)).toBe(1);
    input.write(call(3, { exit: true }));
    await expect.poll(() => permitCount(session.record.id, env), { timeout: 1_000 }).toBe(0);
    output.destroy();
    await run.catch(() => {});
  });

  it("forwards a response the child sends while teardown stops it, with no end error", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const child = heldCallChild(env);
    const input = new PassThrough();
    const output: Buffer[] = [];
    const run = runGatedRelay(session, env, child, input, output);
    input.write(call(1, { hold: true, answerOnTerm: true }));
    await waitForSeen(child, 1);
    await stopSessionAgentInput(session.record.id, env, 5_000);
    await run;
    expect(responses(output)).toEqual([{ jsonrpc: "2.0", id: 1, result: { content: [] } }]);
    expect(permitCount(session.record.id, env)).toBe(0);
  });

  it("releases every permit when the relay input ends with a call unanswered", async () => {
    const env = registryEnv();
    const session = await liveSession(env);
    const child = heldCallChild(env);
    const input = new PassThrough();
    const run = runGatedRelay(session, env, child, input, []);
    input.write(call(1, { hold: true }));
    await waitForSeen(child, 1);
    expect(permitCount(session.record.id, env)).toBe(1);
    input.end();
    await run;
    expect(permitCount(session.record.id, env)).toBe(0);
  });
});
