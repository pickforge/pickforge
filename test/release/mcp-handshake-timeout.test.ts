// The candidate smoke's MCP handshake is a release gate: a confirmed publish
// waits behind it. It must fail on its own timeout rather than hold the job
// until GitHub kills it, and it must not leave the server it spawned running.
//
// Every server here is a real process speaking (or refusing to speak) stdio
// JSON-RPC on the wire. Nothing is mocked.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HANDSHAKE = path.resolve(import.meta.dirname, "../../scripts/smoke/mcp-handshake.mjs");
const TIMEOUT_MS = 2_000;

let workDir: string;

function writeServer(name: string, body: string): string {
  const script = path.join(workDir, `${name}.mjs`);
  fs.writeFileSync(script, body);
  const launcher = path.join(workDir, name);
  fs.writeFileSync(launcher, `#!/bin/sh\nexec ${process.execPath} ${script}\n`);
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

const READ_LINES = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`;

// Keeps the process alive with no work to do, exactly like a server that has
// stopped answering.
const STAY_ALIVE = `setInterval(() => {}, 1000);`;

function runHandshake(command: string): Promise<{ code: number | null; stderr: string; pid: number }> {
  const child = spawn(
    process.execPath,
    [HANDSHAKE, "--command", command, "--project", workDir, "--out", path.join(workDir, "out.json")],
    { env: { ...process.env, PICKFORGE_MCP_TIMEOUT_MS: String(TIMEOUT_MS) }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ code, stderr, pid: child.pid as number }));
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-mcp-handshake-"));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("candidate smoke MCP handshake", () => {
  it("rejects when the server never answers, instead of hanging", async () => {
    const server = writeServer("never-answers", `process.stdin.resume();\n${STAY_ALIVE}`);
    const started = Date.now();
    const result = await runHandshake(server);
    const elapsed = Date.now() - started;

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`no MCP response within ${TIMEOUT_MS}ms`);
    // The point of the gate: it fails on its own budget, not GitHub's.
    expect(elapsed).toBeLessThan(TIMEOUT_MS * 10);
  });

  it("rejects when the server answers initialize and then hangs", async () => {
    const server = writeServer(
      "half-answers",
      `function handle(message) {
         if (message.method !== "initialize") return;
         process.stdout.write(JSON.stringify({
           jsonrpc: "2.0",
           id: message.id,
           result: { protocolVersion: "2025-03-26", serverInfo: { name: "half", version: "1" } },
         }) + "\\n");
       }
       ${READ_LINES}
       ${STAY_ALIVE}`,
    );
    const result = await runHandshake(server);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`no MCP response within ${TIMEOUT_MS}ms`);
  });

  it("rejects, with the server's stderr, when the server exits mid-handshake", async () => {
    const server = writeServer("dies", `process.stderr.write("server exploded\\n");\nprocess.exit(3);`);
    const result = await runHandshake(server);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("exited (code 3");
    expect(result.stderr).toContain("server exploded");
  });

  it("leaves no server process behind after a timeout", async () => {
    // The server records its own pid so the test can prove that process, and
    // not merely the launcher, is gone once the handshake has failed.
    const pidFile = path.join(workDir, "server.pid");
    const server = writeServer(
      "records-pid",
      `const fs = await import("node:fs");
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       process.stdin.resume();
       ${STAY_ALIVE}`,
    );
    const result = await runHandshake(server);

    expect(result.code).toBe(1);
    const serverPid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(serverPid)).toBe(true);
    expect(isAlive(serverPid)).toBe(false);
  });

  it("succeeds against a server that completes the handshake", async () => {
    const server = writeServer(
      "answers",
      `function handle(message) {
         if (message.method === "initialize") {
           process.stdout.write(JSON.stringify({
             jsonrpc: "2.0",
             id: message.id,
             result: { protocolVersion: "2025-03-26", serverInfo: { name: "answers", version: "9.9.9" } },
           }) + "\\n");
         }
         if (message.method === "tools/list") {
           process.stdout.write(JSON.stringify({
             jsonrpc: "2.0",
             id: message.id,
             result: { tools: [{ name: "second" }, { name: "first" }] },
           }) + "\\n");
         }
       }
       ${READ_LINES}
       ${STAY_ALIVE}`,
    );
    const result = await runHandshake(server);

    expect(result.code).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(workDir, "out.json"), "utf8"));
    expect(report.serverInfo).toEqual({ name: "answers", version: "9.9.9" });
    expect(report.tools).toEqual(["first", "second"]);
  });
});
