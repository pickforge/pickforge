import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseDevToolsActivePort,
  readDevToolsActivePort,
  waitForDevToolsPort,
  probeDevToolsHttp,
} from "../src/devtools.js";
import { writeFakeChrome } from "./fakes.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-devtools-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("parseDevToolsActivePort", () => {
  it("reads the port from the first line and ignores the websocket GUID", () => {
    expect(
      parseDevToolsActivePort("45123\n/devtools/browser/abc-123\n"),
    ).toBe(45123);
  });

  it("rejects empty, partial, non-numeric, or out-of-range content", () => {
    expect(parseDevToolsActivePort("")).toBeUndefined();
    expect(parseDevToolsActivePort("45123")).toBeUndefined();
    expect(parseDevToolsActivePort("not-a-port\n")).toBeUndefined();
    expect(parseDevToolsActivePort("0\n")).toBeUndefined();
    expect(parseDevToolsActivePort("70000\n")).toBeUndefined();
  });
});

describe("readDevToolsActivePort", () => {
  it("returns undefined when the file is missing", () => {
    expect(readDevToolsActivePort(tmp)).toBeUndefined();
  });

  it("reads the port once the file exists", () => {
    fs.writeFileSync(
      path.join(tmp, "DevToolsActivePort"),
      "33221\n/devtools/browser/xyz\n",
    );
    expect(readDevToolsActivePort(tmp)).toBe(33221);
  });
});

describe("waitForDevToolsPort", () => {
  it("resolves with the port as soon as it appears", async () => {
    setTimeout(() => {
      fs.writeFileSync(path.join(tmp, "DevToolsActivePort"), "5555\n/x\n");
    }, 50);
    const result = await waitForDevToolsPort({
      profileDir: tmp,
      timeoutMs: 2000,
      isAlive: () => true,
      isReady: async (port) => port === 5555,
      pollIntervalMs: 10,
    });
    expect(result).toEqual({ ok: true, port: 5555 });
  });

  it("stops waiting when creation is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await waitForDevToolsPort({
      profileDir: tmp,
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
    const result = await waitForDevToolsPort({
      profileDir: tmp,
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
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Probe server did not expose a TCP port");
    }
    fs.writeFileSync(
      path.join(tmp, "DevToolsActivePort"),
      `${address.port}\n/x\n`,
    );
    try {
      const result = await waitForDevToolsPort({
        profileDir: tmp,
        timeoutMs: 2000,
        isAlive: () => true,
        signal: controller.signal,
        pollIntervalMs: 10,
      });
      expect(result).toEqual({ ok: false, reason: "aborted" });
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });

  it("fails with 'exited' when the process dies before publishing a port", async () => {
    const result = await waitForDevToolsPort({
      profileDir: tmp,
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

  it("rejects a published port without claiming an unrun readiness probe", async () => {
    fs.writeFileSync(path.join(tmp, "DevToolsActivePort"), "6006\n/x\n");
    const result = await waitForDevToolsPort({
      profileDir: tmp,
      timeoutMs: 2000,
      isAlive: () => false,
      pollIntervalMs: 10,
    });
    expect(result).toMatchObject({ ok: false, reason: "exited" });
    if (result.ok || result.reason === "aborted") {
      throw new Error("Expected exited diagnostics");
    }
    expect(result.diagnostics).toContain(
      "published port 6006, then the Chrome process exited",
    );
    expect(result.diagnostics).not.toContain("HTTP endpoint");
    expect(result.diagnostics).not.toContain("did not become ready");
  });

  it("returns durable timeout diagnostics for an invalid port file", async () => {
    const profileDir = path.join(tmp, "profile");
    const logPath = path.join(tmp, "daemon.log");
    fs.mkdirSync(profileDir);
    fs.writeFileSync(path.join(profileDir, "DevToolsActivePort"), "45123");
    fs.writeFileSync(logPath, "cold Chrome marker\n");

    const result = await waitForDevToolsPort({
      profileDir,
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
      "file exists but does not contain a valid port before timeout",
    );
    expect(result.diagnostics).toContain("cold Chrome marker");
  });

  it("reports endpoint readiness only after timeout probes ran", async () => {
    fs.writeFileSync(path.join(tmp, "DevToolsActivePort"), "6007\n/x\n");
    let probes = 0;

    const result = await waitForDevToolsPort({
      profileDir: tmp,
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
      "published port 6007, but its HTTP endpoint did not become ready before timeout",
    );
  });
});

describe("probeDevToolsHttp", () => {
  it("does not follow redirects away from the direct loopback endpoint", async () => {
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
        .writeHead(302, {
          Location: `http://127.0.0.1:${targetAddress.port}/json/version`,
        })
        .end();
    });
    redirect.listen(0, "127.0.0.1");
    await once(redirect, "listening");
    const redirectAddress = redirect.address();
    if (redirectAddress === null || typeof redirectAddress === "string") {
      throw new Error("Redirect server did not expose a TCP port");
    }

    try {
      expect(await probeDevToolsHttp(redirectAddress.port)).toBe(false);
      expect(targetHits).toBe(0);
    } finally {
      const redirectClosed = once(redirect, "close");
      const targetClosed = once(target, "close");
      redirect.close();
      target.close();
      await Promise.all([redirectClosed, targetClosed]);
    }
  });
});

describe("readiness probing against a real Chrome stand-in", () => {
  /**
   * A readiness probe that times out aborts its fetch, which resets the
   * DevTools connection. Neither the endpoint nor the wait may treat that as a
   * dead browser: on a loaded CI host every probe can abort, and reporting
   * "Chrome exited during startup" from a probe the caller itself cancelled is
   * how pickforge/pickforge#100 failed the built MCP browser lifecycle.
   */
  it("keeps a published endpoint alive and usable across aborted probes", async () => {
    const binDir = path.join(tmp, "bin");
    const profileDir = path.join(tmp, "session", "profile");
    fs.mkdirSync(profileDir, { recursive: true });
    writeFakeChrome(binDir, "ready");
    const chrome = spawn(
      process.execPath,
      [path.join(binDir, "fake-chrome.cjs"), `--user-data-dir=${profileDir}`],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let chromeStderr = "";
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", (chunk: string) => {
      chromeStderr += chunk;
    });
    const isAlive = (): boolean =>
      chrome.exitCode === null && chrome.signalCode === null;

    try {
      const deadline = Date.now() + 10_000;
      let port = readDevToolsActivePort(profileDir);
      while (port === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        port = readDevToolsActivePort(profileDir);
      }
      expect(port).toBeGreaterThan(0);

      // Exactly what an aborted `fetch` does to the endpoint at the TCP level,
      // plus the aborting probe itself.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const socket = connect(port as number, "127.0.0.1");
        try {
          await once(socket, "connect");
        } catch (error) {
          socket.destroy();
          // Let the stand-in's own diagnosis arrive before reporting.
          await new Promise((resolve) => setTimeout(resolve, 200));
          throw new Error(
            `the endpoint stopped accepting connections after ${attempt} ` +
              `aborted probe(s): ${(error as Error).message}\n` +
              `alive: ${String(isAlive())}\n` +
              `stand-in stderr: ${chromeStderr || "(empty)"}`,
          );
        }
        socket.resetAndDestroy();
        // A probe budget this small normally aborts; whether this particular
        // one beat the clock does not matter, only that the endpoint survives.
        await probeDevToolsHttp(port as number, 1);
      }

      const ready = await waitForDevToolsPort({
        profileDir,
        timeoutMs: 10_000,
        isAlive,
      });
      expect(ready).toMatchObject({ ok: true });
      expect(chromeStderr).toBe("");
      expect(isAlive()).toBe(true);
    } finally {
      chrome.kill("SIGKILL");
    }
  }, 30_000);
});
