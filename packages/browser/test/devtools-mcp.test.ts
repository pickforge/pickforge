import fs from "node:fs";
import { spawn, type SpawnOptions } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireHumanLease,
  releaseHumanLease,
  type SessionRecord,
} from "@pickforge/lab-core";
import {
  createDeferred,
  CHROME_DEVTOOLS_MCP_BIN,
  CHROME_DEVTOOLS_MCP_VERSION,
  TAKEOVER_BUSY_ERROR_CODE,
  createTakeoverBusyIntercept,
  resolveDevtoolsMcpExecutable,
  resolveLiveBrowserSession,
  runDevtoolsMcpRelay,
  type BrowserSessionStatus,
  type DevtoolsMcpExecutable,
  type LiveBrowserSession,
  type RelaySignalSource,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
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
  return { record, cdpPort: 9333, browserUrl: "http://127.0.0.1:9333" };
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

describe("resolveLiveBrowserSession", () => {
  it("resolves exactly one live project-local browser and derives loopback URL", async () => {
    const project = path.resolve("/wanted");
    const wanted = browserRecord("brow-aaaaaa11", project);
    const other = browserRecord("brow-bbbbbb22", "/other");
    const dead = browserRecord("brow-cccccc33", project);
    const resolved = await resolveLiveBrowserSession({
      projectDir: project,
      env: {},
      list: async () => [other, dead, wanted],
      status: async (id) => browserStatus(id === wanted.id ? wanted : dead, id === wanted.id, 9444),
    });
    expect(resolved.record.id).toBe(wanted.id);
    expect(resolved.browserUrl).toBe("http://127.0.0.1:9444");
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
      }),
    ).rejects.toThrow("No live browser session for this project");
    await expect(
      resolveLiveBrowserSession({
        projectDir: project,
        env: {},
        list: async () => [one],
        status: async () => browserStatus(one, true, 0),
      }),
    ).rejects.toThrow("No live browser session for this project");
    await expect(
      resolveLiveBrowserSession({
        projectDir: project,
        env: {},
        list: async () => [one, two],
        status: async (id) => browserStatus(id === one.id ? one : two, true),
      }),
    ).rejects.toThrow(`Multiple live browser sessions for this project (${one.id}, ${two.id})`);
  });
});

describe("createTakeoverBusyIntercept", () => {
  it("blocks tools/call while a human lease is active, and only that", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-takeover-intercept-"));
    temporaryDirectories.push(tmp);
    const env = { PICKLAB_HOME: path.join(tmp, "home") };
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
          "PickLab: human control is active; agent input is paused until control returns",
      },
    });

    await releaseHumanLease("brow-aaaaaa11", lease.leaseId, env);
    expect(
      await intercept({ jsonrpc: "2.0", id: 3, method: "tools/call" }),
    ).toBeUndefined();
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
      "--browser-url",
      "http://127.0.0.1:9333",
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
      argv: ["--browser-url", "http://127.0.0.1:9333"],
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
