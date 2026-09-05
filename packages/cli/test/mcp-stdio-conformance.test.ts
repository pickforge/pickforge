import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureCliBuilt } from "./build-once.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = path.join(repoRoot, "packages", "cli", "dist", "pickforge-mcp.js");
const TIMEOUT_MS = 5_000;
const MODERN_PROTOCOL_REVISION = "2026-07-28";
const PLANTED_TOKEN = `ghp_${"a".repeat(36)}`;
const LEGACY_PROTOCOL_REVISIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

const EXPECTED_TOOLS = [
  "android_back",
  "android_get_ui_tree",
  "android_home",
  "android_install_apk",
  "android_launch_app",
  "android_logcat",
  "android_run_adb",
  "android_screenshot",
  "android_start",
  "android_tap",
  "android_type",
  "artifact_list",
  "artifact_report",
  "desktop_click",
  "desktop_double_click",
  "desktop_drag",
  "desktop_exec",
  "desktop_key",
  "desktop_launch",
  "desktop_move",
  "desktop_screenshot",
  "desktop_scroll",
  "desktop_type",
  "request_user_input",
  "session_create",
  "session_destroy",
  "session_status",
  "takeover_status",
] as const;

interface RpcFrame {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: unknown };
}

interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    sleep(TIMEOUT_MS).then(() => {
      throw new Error(`${label} timed out after ${TIMEOUT_MS}ms`);
    }),
  ]);
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<ExitStatus> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function request(
  id: number,
  method: string,
  params: Record<string, unknown>,
): RpcFrame {
  return { jsonrpc: "2.0", id, method, params };
}

function parseFrame(line: string): RpcFrame {
  const parsed: unknown = JSON.parse(line);
  const validated = JSONRPCMessageSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Invalid MCP stdout frame: ${validated.error.message}`);
  }
  return validated.data as RpcFrame;
}

function makeIsolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  const state = path.join(root, "pickforge-home");
  const project = path.join(root, "project");
  const temp = path.join(root, "tmp");
  for (const dir of [home, state, project, temp]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return {
    ...process.env,
    HOME: home,
    TMPDIR: temp,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    PICKFORGE_HOME: state,
    PICKFORGE_PROJECT_DIR: project,
    PICKFORGE_TELEMETRY: "0",
  };
}

class WireProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly projectDir: string;
  stderr = "";
  private readonly lines: readline.Interface;
  private readonly iterator: AsyncIterator<string>;
  private disposed = false;

  constructor(readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-mcp-wire-"))) {
    const env = makeIsolatedEnvironment(root);
    this.projectDir = env.PICKFORGE_PROJECT_DIR as string;
    this.child = spawn(process.execPath, [entry], {
      cwd: this.projectDir,
      env,
      stdio: "pipe",
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.iterator = this.lines[Symbol.asyncIterator]();
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.child.stdin.on("error", () => {});
    activeProcesses.add(this);
  }

  send(frame: RpcFrame): void {
    this.sendRaw(`${JSON.stringify(frame)}\n`);
  }

  sendRaw(raw: string | Buffer): void {
    this.child.stdin.write(raw);
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async readFrame(): Promise<RpcFrame> {
    const next = await withTimeout(this.iterator.next(), "MCP stdout frame");
    if (next.done === true) throw new Error("MCP stdout closed before a response");
    return parseFrame(next.value);
  }

  async call(
    frame: RpcFrame,
    respond?: (frame: RpcFrame) => Record<string, unknown>,
  ): Promise<RpcFrame> {
    this.send(frame);
    for (;;) {
      const incoming = await this.readFrame();
      if (incoming.method !== undefined && incoming.id !== undefined) {
        if (respond === undefined) {
          throw new Error(`Unexpected server request: ${incoming.method}`);
        }
        this.send({
          jsonrpc: "2.0",
          id: incoming.id,
          result: respond(incoming),
        });
        continue;
      }
      if (incoming.id === frame.id) return incoming;
    }
  }

  async waitUntilReady(): Promise<void> {
    await withTimeout(
      (async () => {
        while (!this.stderr.includes("listening on stdio")) await sleep(10);
      })(),
      "MCP readiness",
    );
  }

  async finishInput(): Promise<ExitStatus> {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    return withTimeout(waitForExit(this.child), "MCP exit after EOF");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lines.close();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await withTimeout(waitForExit(this.child), "forced MCP exit").catch(
        () => {},
      );
    }
    fs.rmSync(this.root, { recursive: true, force: true });
    activeProcesses.delete(this);
  }
}

const activeProcesses = new Set<WireProcess>();

function legacyInitialize(protocolVersion: string): RpcFrame {
  return request(1, "initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "raw-wire-test", version: protocolVersion },
  });
}

const modernMeta = {
  [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_REVISION,
  [CLIENT_INFO_META_KEY]: { name: "raw-wire-test", version: "1.0.0" },
  [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
};

function modernRequest(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): RpcFrame {
  return request(id, method, { ...params, _meta: modernMeta });
}

function toolNames(frame: RpcFrame): string[] {
  return (frame.result?.tools as Array<{ name: string }>)
    .map(({ name }) => name)
    .sort();
}

function toolReport(frame: RpcFrame): Record<string, unknown> {
  const content = frame.result?.content as Array<{
    type: string;
    text?: string;
  }>;
  const text = content.find(({ type }) => type === "text")?.text;
  if (text === undefined) throw new Error("Tool response has no text content");
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(ensureCliBuilt, 300_000);

afterEach(async () => {
  await Promise.all([...activeProcesses].map((process) => process.dispose()));
});

describe("raw MCP stdio wire", () => {
  it("pins the SDK's complete required legacy revision set", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(LEGACY_PROTOCOL_REVISIONS);
  });

  it.each(LEGACY_PROTOCOL_REVISIONS)(
    "negotiates and serves legacy revision %s",
    async (protocolVersion) => {
      const wire = new WireProcess();
      const initialized = await wire.call(legacyInitialize(protocolVersion));
      wire.notify("notifications/initialized");
      const tools = await wire.call(request(2, "tools/list", {}));
      const artifact = await wire.call(
        request(3, "tools/call", { name: "artifact_list", arguments: {} }),
      );

      expect(initialized.error).toBeUndefined();
      expect(initialized.result?.protocolVersion).toBe(protocolVersion);
      expect(toolNames(tools)).toEqual(EXPECTED_TOOLS);
      expect(artifact.result?.content).toBeDefined();
      expect(await wire.finishInput()).toEqual({ code: 0, signal: null });
      expect(wire.stderr).toContain("listening on stdio");
    },
  );

  it("preserves legacy push elicitation through the v2 compatibility shim", async () => {
    const wire = new WireProcess();
    const initialize = legacyInitialize(LATEST_PROTOCOL_VERSION);
    if (initialize.params !== undefined) {
      initialize.params.capabilities = { elicitation: {} };
    }
    await wire.call(initialize);
    wire.notify("notifications/initialized");

    const result = await wire.call(
      request(2, "tools/call", {
        name: "request_user_input",
        arguments: { question: "Which device should I use?" },
      }),
      (serverRequest) => {
        expect(serverRequest.method).toBe("elicitation/create");
        expect(serverRequest.params?.message).toContain("Which device");
        return { action: "accept", content: { answer: "Pixel 9" } };
      },
    );

    expect(toolReport(result).value).toBe("Pixel 9");
    expect(await wire.finishInput()).toEqual({ code: 0, signal: null });
  });

  it("serves the explicitly opted-in 2026-07-28 era", async () => {
    const wire = new WireProcess();
    const discover = await wire.call(modernRequest(1, "server/discover"));
    const tools = await wire.call(modernRequest(2, "tools/list"));
    const resources = await wire.call(modernRequest(3, "resources/list"));
    const templates = await wire.call(
      modernRequest(4, "resources/templates/list"),
    );
    const prompts = await wire.call(modernRequest(5, "prompts/list"));
    const blocked = await wire.call(
      modernRequest(6, "tools/call", {
        name: "request_user_input",
        arguments: { question: "Which device should I use?" },
      }),
    );
    const answered = await wire.call(
      modernRequest(7, "tools/call", {
        name: "request_user_input",
        arguments: { question: "Which device should I use?" },
        inputResponses: {
          userInput: { action: "accept", content: { answer: "Pixel 9" } },
        },
      }),
    );
    const tasks = await wire.call(modernRequest(8, "tasks/list"));

    expect(discover.result?.supportedVersions).toEqual([
      MODERN_PROTOCOL_REVISION,
    ]);
    expect(toolNames(tools)).toEqual(EXPECTED_TOOLS);
    expect(resources.result?.resources).toEqual([
      expect.objectContaining({ uri: "pickforge://runs" }),
    ]);
    expect(
      (templates.result?.resourceTemplates as Array<{ uriTemplate: string }>).map(
        ({ uriTemplate }) => uriTemplate,
      ),
    ).toHaveLength(6);
    expect(
      (prompts.result?.prompts as Array<{ name: string }>).map(({ name }) => name).sort(),
    ).toEqual([
      "debug-android-apk",
      "run-visual-regression-check",
      "test-flutter-desktop-visually",
    ]);
    expect(blocked.result?.resultType).toBe("input_required");
    expect(blocked.result?.inputRequests).toHaveProperty("userInput");
    expect(toolReport(answered).value).toBe("Pixel 9");
    expect(tasks.error?.code).toBe(-32601);
    expect(await wire.finishInput()).toEqual({ code: 0, signal: null });
  });

  it("counter-offers legacy and rejects unsupported modern revisions", async () => {
    const legacy = new WireProcess();
    const counterOffer = await legacy.call(legacyInitialize("2023-01-01"));
    expect(counterOffer.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(await legacy.finishInput()).toEqual({ code: 0, signal: null });

    const modern = new WireProcess();
    const unsupported = await modern.call(
      request(1, "server/discover", {
        _meta: {
          ...modernMeta,
          [PROTOCOL_VERSION_META_KEY]: "2026-08-01",
        },
      }),
    );
    expect(unsupported.error).toMatchObject({
      code: -32022,
      data: { requested: "2026-08-01", supported: [MODERN_PROTOCOL_REVISION] },
    });
    expect(await modern.finishInput()).toEqual({ code: 0, signal: null });
  });

  it("drops malformed input while keeping stderr bounded and redacted", async () => {
    const wire = new WireProcess();
    wire.sendRaw("not-json\n");
    for (let id = 10; id < 22; id += 1) {
      wire.sendRaw(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/list",
          params: `token=${PLANTED_TOKEN}`,
        })}\n`,
      );
    }
    const initialized = await wire.call(
      legacyInitialize(LATEST_PROTOCOL_VERSION),
    );

    expect(initialized.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(await wire.finishInput()).toEqual({ code: 0, signal: null });
    expect(wire.stderr).not.toContain(PLANTED_TOKEN);
    expect(wire.stderr).toContain("Invalid input");
    expect(wire.stderr).toContain("further errors suppressed");
    expect(Buffer.byteLength(wire.stderr)).toBeLessThan(18_000);
  });
});

describe("MCP process lifecycle", () => {
  it("exits cleanly on EOF before negotiation", async () => {
    const wire = new WireProcess();
    expect(await wire.finishInput()).toEqual({ code: 0, signal: null });
  });

  it("exits after a transport buffer error closes the connection", async () => {
    const wire = new WireProcess();
    wire.sendRaw(Buffer.alloc(11 * 1024 * 1024, "x"));
    const status = await withTimeout(
      waitForExit(wire.child),
      "MCP exit after transport close",
    );

    expect(status).toEqual({ code: 0, signal: null });
    expect(wire.stderr).toMatch(/buffer|max/i);
    expect(Buffer.byteLength(wire.stderr)).toBeLessThan(4_096);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "closes cleanly on %s with stdin open",
    async (signal) => {
      const wire = new WireProcess();
      await wire.waitUntilReady();
      wire.child.kill(signal);

      expect(
        await withTimeout(waitForExit(wire.child), `MCP exit after ${signal}`),
      ).toEqual({ code: 0, signal: null });
    },
  );
});

describe("isolated-home real CLI contract", () => {
  it("discovers and uses the built pickforge-mcp binary without real-home state", async () => {
    const wire = new WireProcess();
    await wire.call(legacyInitialize(LATEST_PROTOCOL_VERSION));
    wire.notify("notifications/initialized");
    const tools = await wire.call(request(2, "tools/list", {}));
    const prompts = await wire.call(request(3, "prompts/list", {}));
    const resources = await wire.call(request(4, "resources/list", {}));
    const artifact = await wire.call(
      request(5, "tools/call", { name: "artifact_list", arguments: {} }),
    );

    expect(toolNames(tools)).toEqual(EXPECTED_TOOLS);
    expect(prompts.result?.prompts).toHaveLength(3);
    expect(resources.result?.resources).toHaveLength(1);
    expect(JSON.stringify(artifact.result)).toContain(wire.projectDir);
    expect(wire.projectDir).toBe(path.join(wire.root, "project"));
    expect(await wire.finishInput()).toEqual({ code: 0, signal: null });
    expect(fs.existsSync(path.join(wire.root, "home"))).toBe(true);
  });
});
