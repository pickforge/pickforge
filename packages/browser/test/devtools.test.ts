import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseCdpEndpoint,
  probeCdpEndpoint,
  readDevToolsBrowserVersion,
  waitForCdpEndpoint,
} from "../src/devtools.js";
import { buildSupervisedBrowserCommand } from "../src/supervisor.js";
import { writeFakeChrome } from "./fakes.js";

let tmp: string;
let endpointFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-devtools-"));
  endpointFile = path.join(tmp, "cdp-endpoint");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const BROWSER_PATH = "/devtools/browser/0b4a3f0e-1f6c-4c2e-9a77-2d2f6f1b9e10";

function publish(socketPath: string): void {
  fs.writeFileSync(endpointFile, JSON.stringify({ socketPath, browserPath: BROWSER_PATH }), { mode: 0o600 });
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  server.listen(socketPath);
  await once(server, "listening");
}

async function closeServer(server: Server): Promise<void> {
  const closed = once(server, "close");
  server.close();
  await closed;
}

describe("parseCdpEndpoint", () => {
  it("reads the socket path and the browser path", () => {
    expect(
      parseCdpEndpoint(JSON.stringify({ socketPath: "/tmp/a/cdp.sock", browserPath: BROWSER_PATH })),
    ).toEqual({ socketPath: "/tmp/a/cdp.sock", browserPath: BROWSER_PATH });
  });

  it("rejects empty, partial, legacy, or unsafe content", () => {
    for (const content of [
      "",
      "{",
      "45123\n/devtools/browser/abc-123\n",
      JSON.stringify({ socketPath: "/tmp/a/cdp.sock" }),
      JSON.stringify({ socketPath: "cdp.sock", browserPath: BROWSER_PATH }),
      JSON.stringify({ socketPath: "/tmp/a/cdp.sock", browserPath: "/devtools/browser/../json" }),
    ]) {
      expect(parseCdpEndpoint(content)).toBeUndefined();
    }
  });
});

describe("waitForCdpEndpoint", () => {
  it("resolves with the endpoint as soon as it appears and answers", async () => {
    setTimeout(() => publish("/tmp/a/cdp.sock"), 50);
    const result = await waitForCdpEndpoint({
      endpointFile,
      timeoutMs: 2000,
      isAlive: () => true,
      isReady: async (endpoint) => endpoint.socketPath === "/tmp/a/cdp.sock",
      pollIntervalMs: 10,
    });
    expect(result).toEqual({
      ok: true,
      endpoint: { socketPath: "/tmp/a/cdp.sock", browserPath: BROWSER_PATH },
    });
  });

  it("stops waiting when creation is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await waitForCdpEndpoint({
      endpointFile,
      timeoutMs: 2000,
      isAlive: () => true,
      signal: controller.signal,
      pollIntervalMs: 10,
    });
    expect(result).toEqual({ ok: false, reason: "aborted" });
  });

  it("interrupts the inter-poll wait when creation is aborted", async () => {
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    const result = await waitForCdpEndpoint({
      endpointFile,
      timeoutMs: 60_000,
      isAlive: () => true,
      signal: controller.signal,
      pollIntervalMs: 60_000,
    });
    expect(result).toEqual({ ok: false, reason: "aborted" });
  }, 1000);

  it("returns aborted when cancellation happens during the endpoint probe", async () => {
    const controller = new AbortController();
    const server = createServer(() => controller.abort());
    const socketPath = path.join(tmp, "cdp.sock");
    await listenOnSocket(server, socketPath);
    publish(socketPath);
    try {
      const result = await waitForCdpEndpoint({
        endpointFile,
        timeoutMs: 2000,
        isAlive: () => true,
        signal: controller.signal,
        pollIntervalMs: 10,
      });
      expect(result).toEqual({ ok: false, reason: "aborted" });
    } finally {
      server.closeAllConnections();
      await closeServer(server);
    }
  });

  it("fails with 'exited' when the process dies before publishing an endpoint", async () => {
    const result = await waitForCdpEndpoint({
      endpointFile,
      timeoutMs: 2000,
      isAlive: () => false,
      pollIntervalMs: 10,
    });
    expect(result).toMatchObject({ ok: false, reason: "exited" });
    if (result.ok || result.reason === "aborted") {
      throw new Error("Expected exited diagnostics");
    }
    expect(result.diagnostics).toContain(
      "file was not created before the Chrome process exited",
    );
  });

  it("rejects a published endpoint without claiming an unrun readiness probe", async () => {
    publish("/tmp/a/cdp.sock");
    const result = await waitForCdpEndpoint({
      endpointFile,
      timeoutMs: 2000,
      isAlive: () => false,
      pollIntervalMs: 10,
    });
    expect(result).toMatchObject({ ok: false, reason: "exited" });
    if (result.ok || result.reason === "aborted") {
      throw new Error("Expected exited diagnostics");
    }
    expect(result.diagnostics).toContain(
      "published a CDP socket, then the Chrome process exited",
    );
    expect(result.diagnostics).not.toContain("did not answer");
    expect(result.diagnostics).not.toContain(BROWSER_PATH);
  });

  it("returns durable timeout diagnostics for an invalid endpoint file", async () => {
    const logPath = path.join(tmp, "daemon.log");
    fs.writeFileSync(endpointFile, "45123", { mode: 0o600 });
    fs.writeFileSync(logPath, "cold Chrome marker\n");

    const result = await waitForCdpEndpoint({
      endpointFile,
      logPath,
      timeoutMs: 60,
      isAlive: () => true,
      pollIntervalMs: 10,
    });

    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    if (result.ok || result.reason === "aborted") {
      throw new Error("Expected timeout diagnostics");
    }
    expect(result.diagnostics).toContain(
      "file exists but does not hold a valid endpoint before timeout",
    );
    expect(result.diagnostics).toContain("cold Chrome marker");
  });

  it("says why it refused an unsafe endpoint file in the timeout diagnostics", async () => {
    publish("/tmp/a/cdp.sock");
    fs.chmodSync(endpointFile, 0o640);

    const result = await waitForCdpEndpoint({
      endpointFile,
      timeoutMs: 60,
      isAlive: () => true,
      pollIntervalMs: 10,
    });

    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    if (result.ok || result.reason === "aborted") {
      throw new Error("Expected timeout diagnostics");
    }
    expect(result.diagnostics).toContain(
      "file exists but does not hold a valid endpoint before timeout: " +
        `Refusing unsafe CDP endpoint file ${endpointFile}: must be a regular file of this user with mode 0600`,
    );
    expect(result.diagnostics).not.toContain(BROWSER_PATH);
  });

  it("reports endpoint readiness only after timeout probes ran", async () => {
    publish("/tmp/a/cdp.sock");
    let probes = 0;

    const result = await waitForCdpEndpoint({
      endpointFile,
      timeoutMs: 20,
      isAlive: () => true,
      isReady: () => {
        probes += 1;
        return false;
      },
      pollIntervalMs: 10,
    });

    expect(probes).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    if (result.ok || result.reason === "aborted") {
      throw new Error("Expected timeout diagnostics");
    }
    expect(result.diagnostics).toContain(
      "published a CDP socket, but it did not answer before timeout",
    );
  });
});

describe("probeCdpEndpoint", () => {
  it("does not follow a redirect away from the supervisor's socket", async () => {
    let targetHits = 0;
    const target = createServer((_request, response) => {
      targetHits += 1;
      response.writeHead(200).end("{}");
    });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const targetAddress = target.address();
    if (targetAddress === null || typeof targetAddress === "string") {
      throw new Error("Redirect target did not expose a TCP port");
    }
    const redirect = createServer((_request, response) => {
      response
        .writeHead(302, { Location: `http://127.0.0.1:${targetAddress.port}/json/version` })
        .end();
    });
    const socketPath = path.join(tmp, "cdp.sock");
    await listenOnSocket(redirect, socketPath);
    try {
      expect(await probeCdpEndpoint(socketPath)).toBe(false);
      expect(targetHits).toBe(0);
    } finally {
      await Promise.all([closeServer(redirect), closeServer(target)]);
    }
  });
});

describe("readiness probing against a supervised Chrome stand-in", () => {
  /**
   * A readiness probe that times out aborts its request, which resets the
   * connection. Neither the endpoint nor the wait may treat that as a dead
   * browser: on a loaded CI host every probe can abort, and reporting "Chrome
   * exited during startup" from a probe the caller itself cancelled is how
   * pickforge/pickforge#100 failed the built MCP browser lifecycle.
   */
  it("keeps a published endpoint alive and usable across aborted probes", async () => {
    const binDir = path.join(tmp, "bin");
    const profileDir = path.join(tmp, "session", "profile");
    fs.mkdirSync(profileDir, { recursive: true });
    writeFakeChrome(binDir, "ready");
    const socketPath = path.join(tmp, "cdp.sock");
    const command = buildSupervisedBrowserCommand(
      process.execPath,
      path.join(binDir, "google-chrome-stable"),
      [`--user-data-dir=${profileDir}`],
      { endpointFile, socketPath },
    );
    const chrome = spawn(command.command, command.args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
    let chromeStderr = "";
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", (chunk: string) => {
      chromeStderr += chunk;
    });
    const isAlive = (): boolean =>
      chrome.exitCode === null && chrome.signalCode === null;

    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(endpointFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(endpointFile)).toBe(true);

      // An abrupt hang-up, as an aborted request does, plus the aborting
      // probe itself.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const socket = connect(socketPath);
        try {
          await once(socket, "connect");
        } catch (error) {
          socket.destroy();
          await new Promise((resolve) => setTimeout(resolve, 200));
          throw new Error(
            `the endpoint stopped accepting connections after ${attempt} ` +
              `aborted probe(s): ${(error as Error).message}\n` +
              `alive: ${String(isAlive())}\n` +
              `stand-in stderr: ${chromeStderr || "(empty)"}`,
          );
        }
        socket.destroy();
        // A probe budget this small normally aborts; whether this particular
        // one beat the clock does not matter, only that the endpoint survives.
        await probeCdpEndpoint(socketPath, 1);
      }

      const ready = await waitForCdpEndpoint({ endpointFile, timeoutMs: 10_000, isAlive });
      expect(ready).toMatchObject({ ok: true });
      expect(chromeStderr).toBe("");
      expect(isAlive()).toBe(true);
    } finally {
      if (chrome.pid !== undefined) process.kill(-chrome.pid, "SIGKILL");
    }
  }, 30_000);
});

describe("readDevToolsBrowserVersion", () => {
  async function withVersionEndpoint(
    handler: (response: import("node:http").ServerResponse) => void,
    check: (socketPath: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer((_request, response) => handler(response));
    const socketPath = path.join(tmp, `version-${Math.random().toString(36).slice(2)}.sock`);
    await listenOnSocket(server, socketPath);
    try {
      await check(socketPath);
    } finally {
      await closeServer(server);
    }
  }

  it("reads the Browser build string from /json/version", async () => {
    await withVersionEndpoint(
      (response) =>
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ Browser: " Chrome/131.0.6778.85 " })),
      async (socketPath) => {
        expect(await readDevToolsBrowserVersion(socketPath)).toBe(
          "Chrome/131.0.6778.85",
        );
      },
    );
  });

  it("returns undefined for a missing, malformed, or oversized value", async () => {
    const bodies = [
      JSON.stringify({}),
      JSON.stringify({ Browser: 7 }),
      JSON.stringify({ Browser: "   " }),
      JSON.stringify({ Browser: "Chrome/131<script>" }),
      JSON.stringify({ Browser: `Chrome/${"9".repeat(200)}` }),
      "not json",
    ];
    for (const body of bodies) {
      await withVersionEndpoint(
        (response) => response.writeHead(200).end(body),
        async (socketPath) => {
          expect(await readDevToolsBrowserVersion(socketPath)).toBeUndefined();
        },
      );
    }
  });

  it("returns undefined for a non-200 endpoint and for a dead socket", async () => {
    await withVersionEndpoint(
      (response) => response.writeHead(500).end("{}"),
      async (socketPath) => {
        expect(await readDevToolsBrowserVersion(socketPath)).toBeUndefined();
      },
    );
    let deadSocket = "";
    await withVersionEndpoint(
      (response) => response.writeHead(200).end("{}"),
      async (socketPath) => {
        deadSocket = socketPath;
      },
    );
    expect(await readDevToolsBrowserVersion(deadSocket, 200)).toBeUndefined();
  });
});
