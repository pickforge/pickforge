import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureCliBuilt } from "./build-once.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = path.join(repoRoot, "packages", "cli", "dist", "picklab-mcp.js");

interface RpcResponse {
  id: number;
  result?: Record<string, any>;
  error?: unknown;
}

async function runWire(messages: readonly Record<string, unknown>[]): Promise<{
  responses: RpcResponse[];
  stderr: string;
  elapsedMs: number;
}> {
  const started = Date.now();
  const child = spawn(process.execPath, [entry], { cwd: repoRoot });
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const responses: RpcResponse[] = [];
  for (const message of messages) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    if ("id" in message) {
      const [line] = await Promise.race([
        new Promise<string[]>((resolve) => lines.once("line", (value) => resolve([value]))),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("MCP response timed out")), 5_000),
        ),
      ]);
      responses.push(JSON.parse(line) as RpcResponse);
    }
  }
  child.stdin.end();
  const status = await Promise.race([
    new Promise<number | null>((resolve) => child.once("exit", resolve)),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("MCP process did not exit after EOF")), 5_000),
    ),
  ]);
  expect(status).toBe(0);
  return { responses, stderr, elapsedMs: Date.now() - started };
}

function request(id: number, method: string, params: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method, params };
}

function legacyMessages(clientName: string): Record<string, unknown>[] {
  return [
    request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: clientName, version: "fixture" },
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

describe("MCP stdio wire conformance fixtures", () => {
  it.each(["claude-code", "codex", "pi", "generic-mcp-client"])(
    "serves the legacy initialize path for %s",
    async (clientName) => {
      const { responses, stderr, elapsedMs } = await runWire(
        legacyMessages(clientName),
      );
      expect(responses).toHaveLength(5);
      expect(responses.every((response) => response.error === undefined)).toBe(
        true,
      );
      expect(responses[0]?.result?.protocolVersion).toBe("2025-11-25");
      expect(responses[1]?.result?.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "request_user_input" }),
        ]),
      );
      expect(responses[2]?.result?.resources.length).toBeGreaterThan(0);
      expect(responses[3]?.result?.prompts.length).toBeGreaterThan(0);
      expect(responses[4]?.result?.content).toBeDefined();
      expect(stderr).toContain("listening on stdio");
      expect(elapsedMs).toBeLessThan(5_000);
    },
  );

  it("serves pinned modern discovery and per-request metadata", async () => {
    const withMeta = (params: Record<string, unknown>) => ({
      ...params,
      _meta: modernMeta,
    });
    const { responses, stderr } = await runWire([
      request(1, "server/discover", withMeta({})),
      request(2, "tools/list", withMeta({})),
      request(3, "resources/list", withMeta({})),
      request(4, "prompts/list", withMeta({})),
      request(
        5,
        "tools/call",
        withMeta({
          name: "request_user_input",
          arguments: { question: "Which AVD should I use?" },
        }),
      ),
    ]);
    expect(responses).toHaveLength(5);
    expect(responses[0]?.result?.supportedVersions).toContain("2026-07-28");
    expect(responses[1]?.result?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "request_user_input" }),
      ]),
    );
    expect(responses[2]?.result?.resources.length).toBeGreaterThan(0);
    expect(responses[3]?.result?.prompts.length).toBeGreaterThan(0);
    expect(responses[4]?.result?.isError).toBe(true);
    expect(JSON.stringify(responses[4]?.result)).toContain("Relay the question");
    expect(stderr).toContain("listening on stdio");
  });
});
