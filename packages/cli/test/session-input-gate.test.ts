import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createSession, getSession, sessionInputClosedName } from "@pickforge/lab-core";
import { withSessionGate } from "../../core/src/session-gate.js";
import { ensureCliBuilt } from "./build-once.js";

const cli = fileURLToPath(new URL("../dist/pickforge-lab.js", import.meta.url));
const mcp = fileURLToPath(new URL("../dist/pickforge-mcp.js", import.meta.url));
let home: string;
let env: Record<string, string>;
beforeAll(ensureCliBuilt, 300_000);
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-built-input-gate-"));
  env = { PATH: process.env.PATH!, HOME: home, PICKFORGE_HOME: home, PICKFORGE_TELEMETRY: "0" };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function runCli(id: string): Promise<{ code: number | null; report: { ok: boolean; errors: string[] } }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "session", "destroy", id, "--json"], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      try { resolve({ code, report: JSON.parse(stdout.trim()) }); }
      catch { reject(new Error(`CLI did not return JSON: ${stderr}`)); }
    });
  });
}

it("the built CLI shares the vitest gate and reports its bounded timeout", async () => {
  const record = await createSession({ type: "desktop", status: "running", projectDir: home, desktop: { display: ":2994" } }, env);
  await withSessionGate(record.id, env, async () => {
    const result = await runCli(record.id);
    expect(result.code).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.errors.join(" ")).toContain("Timed out waiting for session input gate");
    expect(fs.existsSync(path.join(home, "sessions", sessionInputClosedName(record.id)))).toBe(false);
    expect(await getSession(record.id, env)).toMatchObject({ desktop: record.desktop, meta: { reaperCleanupPending: true } });
  });
  expect((await runCli(record.id)).code).toBe(0);
  expect(await getSession(record.id, env)).toBeUndefined();
}, 20_000);

it("the built MCP server shares the vitest gate and recovers after release", async () => {
  const record = await createSession({ type: "desktop", status: "running", projectDir: home, desktop: { display: ":2995" } }, env);
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp], env, cwd: home, stderr: "pipe" });
  const client = new Client({ name: "gate-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    await withSessionGate(record.id, env, async () => {
      const result = await client.callTool({ name: "session_destroy", arguments: { sessionId: record.id } });
      const content = result.content as Array<{ type: string; text?: string }>;
      const report = JSON.parse(content.find((item) => item.type === "text")!.text!);
      expect(report.ok).toBe(false);
      expect(report.errors.join(" ")).toContain("Timed out waiting for session input gate");
      expect(fs.existsSync(path.join(home, "sessions", sessionInputClosedName(record.id)))).toBe(false);
    });
    const result = await client.callTool({ name: "session_destroy", arguments: { sessionId: record.id } });
    expect(result.isError).not.toBe(true);
    expect(await getSession(record.id, env)).toBeUndefined();
  } finally {
    await client.close();
    await transport.close();
  }
}, 20_000);
