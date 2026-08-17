import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { findOnPath } from "@pickforge/picklab-desktop-linux";
import {
  fakePath,
  writeExecutable,
  writeFakeChrome,
} from "../../browser/test/fakes.js";
import { ensureCliBuilt } from "./build-once.js";

const cliPath = fileURLToPath(new URL("../dist/picklab.js", import.meta.url));
const mcpPath = fileURLToPath(
  new URL("../dist/picklab-mcp.js", import.meta.url),
);
const hasXvfb = findOnPath("Xvfb") !== null;
const PLANTED_SECRET = "picklab-cli-browser-secret";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let root: string;
let projectDir: string;
let env: Record<string, string>;

beforeAll(async () => {
  await ensureCliBuilt();
}, 300_000);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "picklab-cli-browser-"));
  projectDir = path.join(root, "project");
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  writeFakeChrome(binDir, "ready");
  env = {
    HOME: home,
    PICKLAB_HOME: home,
    PATH: fakePath(binDir),
    SECRET_TOKEN: PLANTED_SECRET,
  };
});

afterEach(() => {
  runCli(["session", "destroy", "--all", "--json"]);
  fs.rmSync(root, { recursive: true, force: true });
});

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectDir,
    env,
    shell: false,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseJson(result: CliResult): Record<string, any> {
  try {
    return JSON.parse(result.stdout) as Record<string, any>;
  } catch (error) {
    throw new Error(
      `CLI did not print JSON (${(error as Error).message}); ` +
        `code: ${result.code}; stdout: ${result.stdout}; stderr: ${result.stderr}`,
    );
  }
}

const mcpTextResultSchema = z.object({
  content: z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .min(1),
});

function parseMcpText(result: unknown): unknown {
  const parsed = mcpTextResultSchema.parse(result);
  return JSON.parse(parsed.content[0].text) as unknown;
}

describe.skipIf(!hasXvfb)("built CLI browser lifecycle", () => {
  it(
    "creates, reports, lists, and destroys a browser session from the bundled CLI",
    async () => {
      const createdResult = await runCli([
        "session",
        "create",
        "--type",
        "browser",
        "--width",
        "960",
        "--height",
        "640",
        "--json",
      ]);
      expect(createdResult.code).toBe(0);
      const created = parseJson(createdResult);
      expect(created.ok).toBe(true);
      expect(created.sessions).toHaveLength(1);
      const session = created.sessions[0] as Record<string, any>;
      expect(session.id).toMatch(/^brow-[0-9a-f]+$/);
      expect(session.type).toBe("browser");
      expect(session.display).toMatch(/^:\d+$/);
      expect(session.cdpPort).toBeGreaterThan(0);

      const chromeEnv = JSON.parse(
        fs.readFileSync(
          path.join(session.profileDir as string, "fake-chrome-env.json"),
          "utf8",
        ),
      ) as Record<string, string>;
      expect(chromeEnv.SECRET_TOKEN).toBeUndefined();

      const statusResult = await runCli([
        "session",
        "status",
        session.id as string,
        "--json",
      ]);
      expect(statusResult.code).toBe(0);
      const status = parseJson(statusResult).sessions[0] as Record<string, any>;
      expect(status.status).toBe("running");
      expect(status.desktop.xvfbAlive).toBe(true);
      expect(status.desktop.displayAlive).toBe(true);
      expect(status.browser.browserAlive).toBe(true);
      expect(status.browser.cdpPort).toBe(session.cdpPort);
      expect(status.viewer).toEqual({
        endpoint: null,
        ready: false,
        readOnly: false,
      });

      const textStatus = await runCli([
        "session",
        "status",
        session.id as string,
      ]);
      expect(textStatus.code).toBe(0);
      expect(textStatus.stdout).toContain("browser=alive");
      expect(textStatus.stdout).toContain(`cdp=${session.cdpPort}`);

      const all = parseJson(
        await runCli(["session", "status", "--json"]),
      ).sessions as Array<Record<string, any>>;
      expect(all.map((entry) => entry.id)).toContain(session.id);

      const profileDir = session.profileDir as string;
      const destroyed = await runCli([
        "session",
        "destroy",
        "--all",
        "--json",
      ]);
      expect(destroyed.code).toBe(0);
      expect(parseJson(destroyed).destroyed).toEqual([session.id]);
      expect(fs.existsSync(profileDir)).toBe(false);
    },
    60_000,
  );

  it(
    "creates a browser session with an asynchronous read-only viewer",
    async () => {
      const binDir = path.join(root, "bin");
      writeExecutable(
        path.join(binDir, "x11vnc"),
        `#!${process.execPath}\n` +
          'const net = require("node:net");\n' +
          "const args = process.argv.slice(2);\n" +
          'const port = Number(args[args.indexOf("-rfbport") + 1]);\n' +
          "const server = net.createServer((socket) => socket.end());\n" +
          'server.listen(port, "127.0.0.1");\n' +
          'process.on("SIGTERM", () => server.close(() => process.exit(0)));\n',
      );
      writeExecutable(
        path.join(binDir, "remote-viewer"),
        `#!${process.execPath}\nprocess.stdout.write("ignored viewer output\\n");\n`,
      );
      env.DISPLAY = ":0";

      const createdResult = await runCli([
        "session",
        "create",
        "--type",
        "browser",
        "--viewer",
        "--json",
      ]);
      expect(createdResult.code).toBe(0);
      const created = parseJson(createdResult);
      const session = created.sessions[0] as Record<string, any>;
      expect(session.type).toBe("browser");
      expect(created.viewer).toMatchObject({
        sessionId: session.id,
        opened: true,
      });

      const status = parseJson(
        await runCli(["session", "status", session.id as string, "--json"]),
      ).sessions[0] as Record<string, any>;
      expect(status.browser.browserAlive).toBe(true);
      expect(status.desktop.vncAlive).toBe(true);
      expect(status.viewer).toMatchObject({
        ready: true,
        readOnly: true,
      });
    },
    60_000,
  );

  it(
    "relays the exact upstream DevTools MCP tool catalog over the built CLI",
    async () => {
      const created = parseJson(
        await runCli([
          "session",
          "create",
          "--type",
          "browser",
          "--json",
        ]),
      );
      expect(created.ok).toBe(true);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, "browser", "devtools-mcp"],
        cwd: projectDir,
        env,
        stderr: "pipe",
      });
      const client = new Client({
        name: "picklab-devtools-relay-smoke",
        version: "0.0.0",
      });
      await client.connect(transport);
      try {
        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        expect(names).toEqual(
          expect.arrayContaining([
            "navigate_page",
            "take_snapshot",
            "list_console_messages",
            "list_network_requests",
          ]),
        );
      } finally {
        await client.close();
      }
    },
    60_000,
  );
});

describe.skipIf(!hasXvfb)("built MCP browser lifecycle", () => {
  it(
    "creates, reports, and destroys a browser session through the bundled MCP bin",
    async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [mcpPath],
        cwd: projectDir,
        env,
        stderr: "pipe",
      });
      const client = new Client({
        name: "picklab-built-browser-test",
        version: "0.0.0",
      });
      await client.connect(transport);
      try {
        const createdResult = await client.callTool({
          name: "session_create",
          arguments: { type: "browser", width: 920, height: 620 },
        });
        const created = z
          .object({
            ok: z.literal(true),
            sessions: z
              .array(
                z.object({
                  id: z.string(),
                  type: z.literal("browser"),
                  cdpPort: z.number().positive(),
                  profileDir: z.string(),
                }),
              )
              .min(1),
          })
          .parse(parseMcpText(createdResult));
        const session = created.sessions[0];

        const statusResult = await client.callTool({
          name: "session_status",
          arguments: { sessionId: session.id },
        });
        const status = z
          .object({
            sessions: z
              .array(
                z.object({
                  status: z.string(),
                  browser: z.object({
                    browserAlive: z.boolean(),
                    cdpPort: z.number(),
                  }),
                }),
              )
              .min(1),
          })
          .parse(parseMcpText(statusResult)).sessions[0];
        expect(status.status).toBe("running");
        expect(status.browser.browserAlive).toBe(true);
        expect(status.browser.cdpPort).toBe(session.cdpPort);

        const destroyedResult = await client.callTool({
          name: "session_destroy",
          arguments: { all: true },
        });
        const destroyed = z
          .object({
            ok: z.literal(true),
            destroyed: z.array(z.string()),
          })
          .parse(parseMcpText(destroyedResult));
        expect(destroyed.destroyed).toEqual([session.id]);
        expect(fs.existsSync(session.profileDir)).toBe(false);
      } finally {
        await client.close();
      }
    },
    60_000,
  );
});
