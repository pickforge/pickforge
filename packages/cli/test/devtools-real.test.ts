import { spawn } from "node:child_process";
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
  attachCdpClient,
  createBrowserSession,
  destroyBrowserSession,
  detectChromeBinary,
  resolveDevtoolsMcpExecutable,
  resolveLiveBrowserSession,
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

/** Serve one HTML page on loopback so a second Chrome shows known content. */
async function servePage(html: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test HTTP server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function cliEnvFor(home: string): Record<string, string> {
  const cliEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) cliEnv[key] = value;
  }
  cliEnv.PICKFORGE_HOME = home;
  return cliEnv;
}

function relayTransport(projectDir: string, home: string): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "browser", "devtools-mcp"],
    cwd: projectDir,
    env: cliEnvFor(home),
    stderr: "pipe",
  });
}

/** Close a relay client and wait until its CLI process is gone. */
async function closeRelay(client: Client, transport: StdioClientTransport): Promise<void> {
  const pid = transport.pid;
  await client.close().catch(() => {});
  if (pid === null) return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(50);
  }
  throw new Error(`Relay process ${pid} did not exit`);
}

/** Run a relay that should fail before it serves MCP, and capture stderr. */
async function runFailingRelay(
  projectDir: string,
  home: string,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [cliPath, "browser", "devtools-mcp"], {
    cwd: projectDir,
    env: cliEnvFor(home),
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [code] = (await once(child, "exit")) as [number | null];
    return { code, stderr };
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
  }
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
    "serves one relay at a time and lets the next relay see the same page",
    { timeout: 120_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-relay-single-"));
      temporaryDirectories.push(root);
      const projectDir = path.join(root, "project");
      const home = path.join(root, "home");
      for (const dir of [projectDir, home]) fs.mkdirSync(dir, { recursive: true });
      const page = await servePage("<!doctype html><title>Pickforge Reconnect</title><h1>Reconnect Ready</h1>");
      const registryEnv = { PICKFORGE_HOME: home };
      const session = await createBrowserSession({ projectDir, registryEnv, env: process.env });
      let transport = relayTransport(projectDir, home);
      let client = new Client({ name: "pickforge-lab-relay-first", version: "0.0.0" });
      try {
        await client.connect(transport);
        const navigation = await client.callTool({
          name: "navigate_page",
          arguments: { type: "url", url: page.url },
        });
        expect(navigation.isError).not.toBe(true);
        const pages = await client.callTool({ name: "list_pages", arguments: {} });
        expect(pages.isError).not.toBe(true);
        expect(JSON.stringify(pages)).toContain(page.url);

        const second = await runFailingRelay(projectDir, home);
        expect(second.code).toBe(1);
        expect(second.stderr).toContain(
          `Browser session ${session.id} is already attached to another DevTools relay`,
        );
        // The refused relay left the first one attached.
        const stillAttached = await client.callTool({ name: "list_pages", arguments: {} });
        expect(JSON.stringify(stillAttached)).toContain(page.url);

        await closeRelay(client, transport);
        transport = relayTransport(projectDir, home);
        client = new Client({ name: "pickforge-lab-relay-second", version: "0.0.0" });
        await client.connect(transport);
        const reconnected = await client.callTool({ name: "list_pages", arguments: {} });
        expect(reconnected.isError).not.toBe(true);
        expect(JSON.stringify(reconnected)).toContain(page.url);
        const snapshot = await client.callTool({ name: "take_snapshot", arguments: {} });
        expect(JSON.stringify(snapshot)).toContain("Reconnect Ready");
      } finally {
        await closeRelay(client, transport).catch(() => {});
        await destroyBrowserSession(session.id, registryEnv).catch(() => {});
        await page.close();
      }
    },
  );

  it(
    "fails every tool call after its session ends",
    { timeout: 120_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-relay-ended-"));
      temporaryDirectories.push(root);
      const projectDir = path.join(root, "project");
      const home = path.join(root, "home");
      for (const dir of [projectDir, home]) fs.mkdirSync(dir, { recursive: true });
      const registryEnv = { PICKFORGE_HOME: home };
      const session = await createBrowserSession({ projectDir, registryEnv, env: process.env });
      const transport = relayTransport(projectDir, home);
      const client = new Client({ name: "pickforge-lab-relay-session-end", version: "0.0.0" });
      try {
        await client.connect(transport);
        const before = await client.callTool({ name: "list_pages", arguments: {} });
        expect(before.isError).not.toBe(true);

        await destroyBrowserSession(session.id, registryEnv);

        for (const name of ["list_pages", "take_snapshot"]) {
          const outcome = await client.callTool({ name, arguments: {} }).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          expect(outcome).toMatchObject({ error: { code: SESSION_ENDED_ERROR_CODE } });
        }
      } finally {
        await client.close().catch(() => {});
        await destroyBrowserSession(session.id, registryEnv).catch(() => {});
      }
    },
  );

  it(
    "pins the upstream child to its own session socket so a later session is unreachable",
    { timeout: 120_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-relay-pinned-"));
      temporaryDirectories.push(root);
      const projectDir = path.join(root, "project");
      const home = path.join(root, "home");
      for (const dir of [projectDir, home]) fs.mkdirSync(dir, { recursive: true });
      const page = await servePage("<!doctype html><title>Other Chrome</title><h1>Other Chrome Content</h1>");
      const registryEnv = { PICKFORGE_HOME: home };
      const own = await createBrowserSession({ projectDir, registryEnv, env: process.env });
      let other: Awaited<ReturnType<typeof createBrowserSession>> | undefined;
      const live = await resolveLiveBrowserSession({ projectDir, env: registryEnv });
      const lease = await attachCdpClient(live.cdpEndpoint);
      const input = new PassThrough();
      const output = new PassThrough();
      const diagnostics = new PassThrough();
      diagnostics.resume();
      const session: LiveBrowserSession = { ...live, browserEndpoint: lease.browserEndpoint };
      expect(session.browserEndpoint).toMatch(/^ws\+unix:\//);
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

        await destroyBrowserSession(own.id, registryEnv);
        expect(fs.existsSync(live.cdpEndpoint.socketPath)).toBe(false);
        other = await createBrowserSession({ projectDir, registryEnv, env: process.env, startUrl: page.url });

        const after = await client.request("tools/call", { name: "take_snapshot", arguments: {} });
        expect(JSON.stringify(after)).not.toContain("Other Chrome");
        expect(after).toMatchObject({ result: { isError: true } });
      } finally {
        input.end();
        await relay.catch(() => {});
        lease.release();
        await destroyBrowserSession(own.id, registryEnv).catch(() => {});
        if (other !== undefined) await destroyBrowserSession(other.id, registryEnv).catch(() => {});
        await page.close();
      }
    },
  );
});
