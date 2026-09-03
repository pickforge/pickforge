import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createBrowserSession,
  destroyBrowserSession,
} from "@pickforge/lab-browser";
import { findOnPath } from "@pickforge/lab-desktop-linux";
import { fakePath, writeFakeChrome } from "../../browser/test/fakes.js";
import { ensureCliBuilt } from "./build-once.js";

const cliPath = fileURLToPath(new URL("../dist/pickforge-lab.js", import.meta.url));
const cliPackageDir = path.dirname(path.dirname(cliPath));
const hasXvfb = findOnPath("Xvfb") !== null;
const cleanupPaths: string[] = [];

beforeAll(async () => {
  await ensureCliBuilt();
}, 300_000);

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await delay(10);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Timed out waiting for ${filePath}`);
  }
}

describe.skipIf(!hasXvfb)("built browser relay command exit", () => {
  it(
    "exits 137 after external-signal escalation while stdin remains open",
    { timeout: 15_000 },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-cli-exit-"));
      cleanupPaths.push(root);
      const projectDir = path.join(root, "project");
      const home = path.join(root, "home");
      const binDir = path.join(root, "bin");
      const readyPath = path.join(root, "upstream-ready");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      writeFakeChrome(binDir, "ready");

      const session = await createBrowserSession({
        projectDir,
        registryEnv: { PICKLAB_HOME: home },
        env: { ...process.env, PATH: fakePath(binDir) },
      });

      const isolatedRoot = fs.mkdtempSync(
        path.join(cliPackageDir, ".relay-exit-test-"),
      );
      cleanupPaths.push(isolatedRoot);
      fs.copyFileSync(
        path.join(cliPackageDir, "package.json"),
        path.join(isolatedRoot, "package.json"),
      );
      const isolatedDist = path.join(isolatedRoot, "dist");
      fs.cpSync(path.dirname(cliPath), isolatedDist, { recursive: true });
      const packageRoot = path.join(
        isolatedRoot,
        "node_modules",
        "chrome-devtools-mcp",
      );
      const upstreamBin = path.join(
        packageRoot,
        "build",
        "src",
        "bin",
        "chrome-devtools-mcp.js",
      );
      fs.mkdirSync(path.dirname(upstreamBin), { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "chrome-devtools-mcp",
          version: "1.5.0",
          type: "module",
          bin: {
            "chrome-devtools-mcp": "./build/src/bin/chrome-devtools-mcp.js",
          },
        }),
      );
      fs.writeFileSync(
        upstreamBin,
        [
          'import fs from "node:fs";',
          'import net from "node:net";',
          'process.on("SIGTERM", () => {});',
          'net.createServer().listen(0, "127.0.0.1");',
          'fs.writeFileSync(process.env.READY_PATH, "ready");',
          "process.stdin.resume();",
        ].join("\n"),
      );

      const child = spawn(
        process.execPath,
        [path.join(isolatedDist, "picklab.js"), "browser", "devtools-mcp"],
        {
          cwd: projectDir,
          env: {
            ...process.env,
            PICKLAB_HOME: home,
            PATH: fakePath(binDir),
            READY_PATH: readyPath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const closed = once(child, "close");
      try {
        await Promise.race([
          waitForFile(readyPath),
          closed.then(([code, signal]) => {
            throw new Error(
              `relay exited before upstream readiness: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
            );
          }),
        ]);
        child.kill("SIGTERM");
        const [code, signal] = await closed;
        expect({ code, signal, stderr }).toEqual({
          code: 137,
          signal: null,
          stderr: "",
        });
      } finally {
        child.kill("SIGKILL");
        await destroyBrowserSession(session.id, { PICKLAB_HOME: home }).catch(
          () => {},
        );
      }
    },
  );
});
