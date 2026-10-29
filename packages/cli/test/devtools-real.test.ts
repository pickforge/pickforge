import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readPickforgeEnv } from "@pickforge/lab-core";
import { findOnPath } from "@pickforge/lab-desktop-linux";
import {
  SESSION_ENDED_ERROR_CODE,
  createBrowserSession,
  destroyBrowserSession,
  detectChromeBinary,
  resolveDevtoolsMcpExecutable,
  runDevtoolsMcpRelay,
  type LiveBrowserSession,
} from "@pickforge/lab-browser";
import { ensureCliBuilt } from "./build-once.js";

const cliPath = fileURLToPath(new URL("../dist/pickforge-lab.js", import.meta.url));
const hasXvfb = findOnPath("Xvfb") !== null;
const hasChrome = detectChromeBinary() !== null;
const ready = hasXvfb && hasChrome;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  await ensureCliBuilt();
}, 300_000);

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const OTHER_CHROME_PAGE =
  "data:text/html,<title>Other Chrome</title><h1>Other Chrome Content</h1>";

interface HeadlessChrome {
  child: ChildProcess;
  port: number;
  endpoint: string;
}

/** Start a headless Chrome with a private profile on a loopback CDP port. */
async function startHeadlessChrome(
  profileDir: string,
  port: number,
  url = "about:blank",
): Promise<HeadlessChrome> {
  const binary = detectChromeBinary();
  if (binary === null) throw new Error("Chrome is not installed");
  const child = spawn(
    binary,
    [
      "--headless=new",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      ...(readPickforgeEnv(process.env, "CHROME_NO_SANDBOX") === "1" ? ["--no-sandbox"] : []),
      url,
    ],
    { detached: true, stdio: "ignore" },
  );
  // Chrome writes DevToolsActivePort only for an ephemeral port.
  const activePort = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const content = fs.existsSync(activePort) ? fs.readFileSync(activePort, "utf8") : "";
    const rawPort = port === 0 ? content.split("\n")[0] : String(port);
    if (rawPort !== undefined && rawPort !== "") {
      const version = await fetch(`http://127.0.0.1:${rawPort}/json/version`)
        .then((response) => response.json() as Promise<{ webSocketDebuggerUrl?: string }>)
        .catch(() => undefined);
      if (version?.webSocketDebuggerUrl !== undefined) {
        return { child, port: Number(rawPort), endpoint: version.webSocketDebuggerUrl };
      }
    }
    await delay(50);
  }
  stopHeadlessChrome(child);
  throw new Error("Headless Chrome did not publish a DevTools port");
}

function stopHeadlessChrome(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function waitForPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const open = await fetch(`http://127.0.0.1:${port}/json/version`).then(
      () => true,
      () => false,
    );
    if (!open) return;
    await delay(50);
  }
  throw new Error(`CDP port ${port} stayed open`);
}

/** Minimal newline-delimited JSON-RPC client over in-process relay streams. */
function ndjsonClient(input: PassThrough, output: PassThrough) {
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === "number") pending.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  return {
    request(method: string, params: unknown): Promise<Record<string, unknown>> {
      const id = nextId++;
      const reply = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return reply;
    },
    notify(method: string): void {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
}

describe("real DevTools relay prerequisites", () => {
  it("fails closed in required-browser environments when prerequisites are missing", () => {
    if (readPickforgeEnv(process.env, "REQUIRE_BROWSER") === "1") {
      expect({ hasXvfb, hasChrome }).toEqual({
        hasXvfb: true,
        hasChrome: true,
      });
    } else {
      expect(true).toBe(true);
    }
  });
});

describe.skipIf(!ready)("real Chrome through the exact upstream relay", () => {
  it(
    "navigates and exposes accessibility, console, and network metadata",
    // Covers bounded Xvfb + Chrome startup without retry-masking a failure.
    { timeout: 120_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-relay-real-"));
      temporaryDirectories.push(root);
      const projectDir = path.join(root, "project");
      const home = path.join(root, "home");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(home, { recursive: true });

      const server = createServer((request, response) => {
        if (request.url === "/data") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"ok":true}');
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<!doctype html><title>Pickforge Relay</title><button>Relay Ready</button>' +
            '<script>console.log("pickforge-lab-relay-console");fetch("/data")</script>',
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Test HTTP server did not bind a TCP port");
      }

      const registryEnv = { PICKFORGE_HOME: home };
      const session = await createBrowserSession({
        projectDir,
        registryEnv,
        env: process.env,
      });
      const cliEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          cliEnv[key] = value;
        }
      }
      cliEnv.PICKFORGE_HOME = home;

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, "browser", "devtools-mcp"],
        cwd: projectDir,
        env: cliEnv,
        stderr: "pipe",
      });
      const client = new Client({
        name: "pickforge-lab-real-devtools-smoke",
        version: "0.0.0",
      });
      try {
        await client.connect(transport);
        const navigation = await client.callTool({
          name: "navigate_page",
          arguments: {
            type: "url",
            url: `http://127.0.0.1:${address.port}/`,
          },
        });
        expect(navigation.isError).not.toBe(true);

        const snapshot = await client.callTool({
          name: "take_snapshot",
          arguments: {},
        });
        expect(JSON.stringify(snapshot)).toContain("Relay Ready");

        const consoleMessages = await client.callTool({
          name: "list_console_messages",
          arguments: {},
        });
        expect(JSON.stringify(consoleMessages)).toContain(
          "pickforge-lab-relay-console",
        );

        const networkRequests = await client.callTool({
          name: "list_network_requests",
          arguments: {},
        });
        expect(JSON.stringify(networkRequests)).toContain("/data");
      } finally {
        await client.close().catch(() => {});
        await destroyBrowserSession(session.id, registryEnv).catch(() => {});
        server.close();
        await once(server, "close");
      }
    },
  );

  it(
    "fails every tool call after its session ends and never reaches another Chrome on the old port",
    { timeout: 120_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-relay-ended-"));
      temporaryDirectories.push(root);
      const projectDir = path.join(root, "project");
      const home = path.join(root, "home");
      const otherProfile = path.join(root, "other-profile");
      for (const dir of [projectDir, home, otherProfile]) fs.mkdirSync(dir, { recursive: true });
      const registryEnv = { PICKFORGE_HOME: home };
      const session = await createBrowserSession({ projectDir, registryEnv, env: process.env });
      const cliEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) cliEnv[key] = value;
      }
      cliEnv.PICKFORGE_HOME = home;
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, "browser", "devtools-mcp"],
        cwd: projectDir,
        env: cliEnv,
        stderr: "pipe",
      });
      const client = new Client({ name: "pickforge-lab-relay-session-end", version: "0.0.0" });
      let other: HeadlessChrome | undefined;
      try {
        await client.connect(transport);
        const before = await client.callTool({ name: "list_pages", arguments: {} });
        expect(before.isError).not.toBe(true);

        await destroyBrowserSession(session.id, registryEnv);
        await waitForPortClosed(session.cdpPort);
        other = await startHeadlessChrome(otherProfile, session.cdpPort, OTHER_CHROME_PAGE);

        for (const name of ["list_pages", "take_snapshot"]) {
          const outcome = await client.callTool({ name, arguments: {} }).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          expect(JSON.stringify(outcome)).not.toContain("Other Chrome");
          expect(outcome).toMatchObject({ error: { code: SESSION_ENDED_ERROR_CODE } });
        }
      } finally {
        await client.close().catch(() => {});
        if (other !== undefined) stopHeadlessChrome(other.child);
        await destroyBrowserSession(session.id, registryEnv).catch(() => {});
      }
    },
  );

  it(
    "pins the upstream child to its own Chrome so a replacement on the same port is unreachable",
    { timeout: 120_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-relay-pinned-"));
      temporaryDirectories.push(root);
      const ownProfile = path.join(root, "own-profile");
      const otherProfile = path.join(root, "other-profile");
      fs.mkdirSync(ownProfile);
      fs.mkdirSync(otherProfile);
      const own = await startHeadlessChrome(ownProfile, 0);
      let other: HeadlessChrome | undefined;
      const input = new PassThrough();
      const output = new PassThrough();
      const diagnostics = new PassThrough();
      diagnostics.resume();
      const session = {
        record: { id: "brow-0000aa44" },
        cdpPort: own.port,
        browserEndpoint: own.endpoint,
      } as LiveBrowserSession;
      // No session gate here: this isolates the child's own reconnect target.
      const relay = runDevtoolsMcpRelay({
        session,
        executable: await resolveDevtoolsMcpExecutable(),
        input,
        output,
        diagnostics,
        cwd: root,
        shutdownTimeoutMs: 5_000,
      });
      const client = ndjsonClient(input, output);
      try {
        await client.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "pickforge-lab-relay-pinned", version: "0.0.0" },
        });
        client.notify("notifications/initialized");
        const before = await client.request("tools/call", { name: "list_pages", arguments: {} });
        expect(JSON.stringify(before)).toContain("about:blank");

        stopHeadlessChrome(own.child);
        await waitForPortClosed(own.port);
        other = await startHeadlessChrome(otherProfile, own.port, OTHER_CHROME_PAGE);

        const after = await client.request("tools/call", { name: "take_snapshot", arguments: {} });
        expect(JSON.stringify(after)).not.toContain("Other Chrome");
        expect(after).toMatchObject({ result: { isError: true } });
      } finally {
        input.end();
        await relay.catch(() => {});
        stopHeadlessChrome(own.child);
        if (other !== undefined) stopHeadlessChrome(other.child);
      }
    },
  );
});
