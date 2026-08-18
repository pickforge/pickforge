import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureCliBuilt } from "./build-once.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = path.join(repoRoot, "packages", "cli", "dist", "picklab-mcp.js");
const TIMEOUT_MS = 5_000;

interface RpcResponse {
  id: number;
  result?: Record<string, any>;
  error?: { code?: number; message?: string; data?: unknown };
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", resolve));
}

async function runWire(messages: readonly Record<string, unknown>[]): Promise<{
  responses: RpcResponse[];
  stderr: string;
  elapsedMs: number;
}> {
  const started = Date.now();
  const child = spawn(process.execPath, [entry], { cwd: repoRoot });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
  >();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  lines.on("line", (line) => {
    try {
      const response = JSON.parse(line) as RpcResponse;
      pending.get(response.id)?.resolve(response);
    } catch (error) {
      const parseError = error instanceof Error ? error : new Error(String(error));
      for (const waiter of pending.values()) waiter.reject(parseError);
    }
  });

  const withTimeout = async <T>(promise: Promise<T>, message: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  try {
    const responses: RpcResponse[] = [];
    for (const message of messages) {
      const responsePromise =
        typeof message.id === "number"
          ? new Promise<RpcResponse>((resolve, reject) =>
              pending.set(message.id as number, { resolve, reject }),
            )
          : undefined;
      child.stdin.write(`${JSON.stringify(message)}\n`);
      if (responsePromise !== undefined) {
        const response = await withTimeout(
          responsePromise,
          `MCP response ${message.id} timed out`,
        );
        pending.delete(message.id as number);
        responses.push(response);
      }
    }
    child.stdin.end();
    const status = await withTimeout(
      waitForExit(child),
      "MCP process did not exit after EOF",
    );
    expect(status).toBe(0);
    return { responses, stderr, elapsedMs: Date.now() - started };
  } catch (error) {
    child.kill();
    await waitForExit(child);
    throw error;
  } finally {
    pending.clear();
    lines.close();
    if (child.exitCode === null) {
      child.kill();
      await waitForExit(child);
    }
  }
}

function request(id: number, method: string, params: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method, params };
}

function legacyMessages(protocolVersion: string): Record<string, unknown>[] {
  return [
    request(1, "initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "protocol-fixture", version: protocolVersion },
    }),
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    request(2, "tools/list", {}),
    request(3, "resources/list", {}),
    request(4, "prompts/list", {}),
    request(5, "tools/call", { name: "artifact_list", arguments: {} }),
  ];
}

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "modern-fixture", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
};

beforeAll(ensureCliBuilt);

describe("MCP stdio protocol fixtures (not proprietary client binaries)", () => {
  it.each([
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
  ])("serves supported legacy revision %s", async (protocolVersion) => {
    const { responses, stderr, elapsedMs } = await runWire(
      legacyMessages(protocolVersion),
    );
    expect(responses).toHaveLength(5);
    expect(responses.every((response) => response.error === undefined)).toBe(true);
    expect(responses[0]?.result?.protocolVersion).toBe(protocolVersion);
    expect(responses[1]?.result?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "request_user_input" })]),
    );
    expect(responses[2]?.result?.resources.length).toBeGreaterThan(0);
    expect(responses[3]?.result?.prompts.length).toBeGreaterThan(0);
    expect(responses[4]?.result?.content).toBeDefined();
    expect(stderr).toContain("listening on stdio");
    expect(elapsedMs).toBeLessThan(TIMEOUT_MS);
  });

  it("counter-offers the latest legacy revision for an unsupported version", async () => {
    const { responses } = await runWire([
      request(1, "initialize", {
        protocolVersion: "2023-01-01",
        capabilities: {},
        clientInfo: { name: "unsupported-protocol-fixture", version: "1" },
      }),
    ]);
    expect(responses[0]?.error).toBeUndefined();
    expect(responses[0]?.result?.protocolVersion).toBe("2025-11-25");
  });

  it("serves modern discovery while keeping elicitation and Tasks boundaries explicit", async () => {
    const withMeta = (params: Record<string, unknown>) => ({ ...params, _meta: modernMeta });
    const { responses, stderr } = await runWire([
      request(1, "server/discover", withMeta({})),
      request(2, "tools/list", withMeta({})),
      request(3, "resources/list", withMeta({})),
      request(4, "prompts/list", withMeta({})),
      request(5, "tools/call", withMeta({
        name: "request_user_input",
        arguments: { question: "Which AVD should I use?" },
      })),
      request(6, "tasks/list", withMeta({})),
    ]);
    expect(responses).toHaveLength(6);
    expect(responses[0]?.result?.supportedVersions).toContain("2026-07-28");
    expect(responses[1]?.result?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "request_user_input" })]),
    );
    expect(responses[2]?.result?.resources.length).toBeGreaterThan(0);
    expect(responses[3]?.result?.prompts.length).toBeGreaterThan(0);
    expect(responses[4]?.result?.isError).toBe(true);
    expect(JSON.stringify(responses[4]?.result)).toMatch(/Modern MCP.*Relay.*retry/s);
    expect(responses[5]?.error).toMatchObject({ code: -32601 });
    expect(stderr).toContain("listening on stdio");
  });

  it("exits cleanly when the real transport self-closes with stdin still open", async () => {
    const child = spawn(process.execPath, [entry], { cwd: repoRoot });
    child.stdin.on("error", () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child.stdin.write(Buffer.alloc(11 * 1024 * 1024, "x"));
      const status = await Promise.race([
        waitForExit(child),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("MCP process did not exit after transport self-close")),
            TIMEOUT_MS,
          );
        }),
      ]);
      expect(status).toBe(0);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      await waitForExit(child);
    }
  });
});
