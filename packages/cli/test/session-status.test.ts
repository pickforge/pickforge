import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureCliBuilt } from "./build-once.js";

const cliPath = fileURLToPath(new URL("../dist/pickforge-lab.js", import.meta.url));
const DEAD_PID = 4_194_304;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let root: string;
let home: string;

beforeAll(async () => {
  await ensureCliBuilt();
}, 300_000);

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-cli-status-"));
  home = path.join(root, "home");
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [cliPath, ...args], {
      env: {
        HOME: home,
        PICKFORGE_HOME: home,
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
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

async function writeDesktopSessionRecord(): Promise<string> {
  const id = "desk-000001";
  const dir = path.join(home, "sessions");
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, `${id}.json`),
    `${JSON.stringify(
      {
        id,
        type: "desktop",
        createdAt: "2026-07-04T00:00:00.000Z",
        status: "running",
        projectDir: root,
        desktop: { display: ":987", xvfbPid: DEAD_PID },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return id;
}

describe("pickforge-lab session status", () => {
  it("reports dead when a running desktop session pid is gone", async () => {
    const id = await writeDesktopSessionRecord();

    const json = await runCli(["session", "status", id, "--json"]);
    expect(json.code).toBe(0);
    const report = parseJson(json);
    expect(report.sessions[0].status).toBe("dead");
    expect(report.sessions[0].desktop.xvfbAlive).toBe(false);

    const text = await runCli(["session", "status", id]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`${id}  desktop  dead`);
    expect(text.stdout).toContain("xvfb=dead");
  });
});
