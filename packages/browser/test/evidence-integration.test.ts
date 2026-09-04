import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  destroySessionRecord,
  listRuns,
  readActions,
  resolveRunStorage,
  type EnvLike,
  type SessionRecord,
} from "@pickforge/lab-core";
import {
  runDevtoolsMcpRelay,
  type DevtoolsMcpExecutable,
  type LiveBrowserSession,
  type RelaySignalSource,
} from "../src/index.js";
import { createDevtoolsEvidenceRecorder } from "../src/devtools-evidence.js";

const TYPED_PASSWORD = "typed-password-4821";
const QUERY_TOKEN = "query-token-5932";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwaWNrbGFiIn0.signature-value";
const CDP_GUID = "01234567-89ab-cdef-0123-456789abcdef";
const OTP = "739204";

let root: string;
let projectDir: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pickforge-lab-evidence-integration-"),
  );
  projectDir = path.join(root, "project");
  await fs.promises.mkdir(projectDir);
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

class Signals extends EventEmitter implements RelaySignalSource {
  override on(
    signal: "SIGINT" | "SIGTERM" | "SIGHUP",
    listener: () => void,
  ): this {
    return super.on(signal, listener);
  }

  override off(
    signal: "SIGINT" | "SIGTERM" | "SIGHUP",
    listener: () => void,
  ): this {
    return super.off(signal, listener);
  }
}

function session(sessionId: string): LiveBrowserSession {
  const record: SessionRecord = {
    id: sessionId,
    type: "browser",
    createdAt: "2026-07-13T00:00:00.000Z",
    status: "running",
    projectDir,
    desktop: { display: ":91", xvfbPid: 11 },
    browser: {
      browserPid: 12,
      browserStartTimeTicks: 13,
      binaryPath: "/fake/chrome",
      profileMode: "ephemeral",
      profileDir: "/fake/profile",
      cdpPort: 9222,
    },
  };
  return { record, cdpPort: 9222, browserUrl: "http://127.0.0.1:9222" };
}

function executable(script: string): DevtoolsMcpExecutable {
  return {
    packageJsonPath: path.join(root, "package.json"),
    packageRoot: root,
    binPath: script,
    version: "1.5.0",
  };
}

function sink(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
}

async function recursiveText(dir: string): Promise<string> {
  const chunks: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(current, {
      withFileTypes: true,
    })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        chunks.push(await fs.promises.readFile(full, "utf8"));
      }
    }
  };
  await walk(dir);
  return chunks.join("\n");
}

describe("browser evidence integration", () => {
  it("turns a failed relay flow into a useful secret-free HTML report", async () => {
    const script = path.join(root, "failed-flow.mjs");
    await fs.promises.writeFile(
      script,
      [
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => {',
        '  for (const line of input.trim().split("\\n")) {',
        "    const request = JSON.parse(line);",
        "    const result = request.id === 1",
        "      ? { content: [] }",
        "      : {",
        "          isError: true,",
        `          content: [{ type: "text", text: "Authorization: Bearer ${JWT}; otp=${OTP}; /devtools/browser/${CDP_GUID}" }],`,
        "          structuredContent: {",
        "            networkRequests: [{",
        '              method: "GET",',
        `              url: "https://example.com/fail?token=${QUERY_TOKEN}",`,
        '              status: 503, resourceType: "fetch", durationMs: 42,',
        `              error: "token=${QUERY_TOKEN}",`,
        `              requestHeaders: { authorization: "Bearer ${JWT}" },`,
        `              responseBody: "otp=${OTP}"`,
        "            }]",
        "          }",
        "        };",
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");',
        "  }",
        "});",
      ].join("\n"),
      "utf8",
    );
    const registryEnv: EnvLike = {
      PICKFORGE_HOME: path.join(root, "pickforge-home"),
    };
    const sessionId = (
      await createSession({ type: "browser", projectDir }, registryEnv)
    ).id;
    const evidence = await createDevtoolsEvidenceRecorder({
      projectDir,
      sessionId,
      env: registryEnv,
    });
    expect(evidence).toBeDefined();
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "fill",
          arguments: { uid: "1_1", value: TYPED_PASSWORD },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "navigate_page",
          arguments: {
            type: "url",
            url: `https://example.com/fail?token=${QUERY_TOKEN}`,
          },
        },
      },
    ];
    const output: Buffer[] = [];

    await expect(
      runDevtoolsMcpRelay({
        session: session(sessionId),
        executable: executable(script),
        input: Readable.from(
          requests.map((request) => `${JSON.stringify(request)}\n`),
        ),
        output: sink(output),
        diagnostics: sink([]),
        hooks: {
          beforeForward: evidence!.beforeForward,
          afterResponse: evidence!.afterResponse,
        },
        signalSource: new Signals(),
        shutdownTimeoutMs: 100,
      }),
    ).resolves.toEqual({ code: 0, signal: null });
    expect(Buffer.concat(output).toString()).toContain(QUERY_TOKEN);

    await destroySessionRecord(sessionId, registryEnv, "failed");
    const [finalized] = await listRuns(projectDir, registryEnv);
    expect(finalized).toBeDefined();
    const runDir = path.join(
      (await resolveRunStorage(projectDir, registryEnv)).runsDir,
      finalized!.runId,
    );
    const reportPath = path.join(runDir, "report.html");
    const records = await readActions(runDir);
    const html = await fs.promises.readFile(reportPath, "utf8");

    expect(records).toHaveLength(3);
    expect(html).toContain("chrome_devtools/fill");
    expect(html).toContain("chrome_devtools/navigate_page");
    expect(html).toContain("network_failure");
    expect(html).toContain("https://example.com/fail");
    expect(html).toContain("503");
    expect(html).toContain("DevTools tool failed");
    expect(finalized!.status).toBe("failed");

    const stored = await recursiveText(runDir);
    for (const secret of [TYPED_PASSWORD, QUERY_TOKEN, JWT, CDP_GUID, OTP]) {
      expect(stored).not.toContain(secret);
    }
  });
});
