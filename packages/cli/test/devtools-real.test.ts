import { once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readPickforgeEnv } from "@pickforge/lab-core";
import { findOnPath } from "@pickforge/lab-desktop-linux";
import {
  createBrowserSession,
  destroyBrowserSession,
  detectChromeBinary,
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
});
