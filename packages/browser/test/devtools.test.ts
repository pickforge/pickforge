import { once } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseDevToolsActivePort,
  readDevToolsActivePort,
  waitForDevToolsPort,
  probeDevToolsHttp,
} from "../src/devtools.js";

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

  it("rejects empty, non-numeric, or out-of-range content", () => {
    expect(parseDevToolsActivePort("")).toBeUndefined();
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
    expect(result).toEqual({ ok: false, reason: "exited" });
  });

  it("rejects a published port when the process has already exited", async () => {
    fs.writeFileSync(path.join(tmp, "DevToolsActivePort"), "6006\n/x\n");
    const result = await waitForDevToolsPort({
      profileDir: tmp,
      timeoutMs: 2000,
      isAlive: () => false,
      pollIntervalMs: 10,
    });
    expect(result).toEqual({ ok: false, reason: "exited" });
  });

  it("fails with 'timeout' and prints durable startup diagnostics", async () => {
    const profileDir = path.join(tmp, "profile");
    fs.mkdirSync(profileDir);
    fs.writeFileSync(path.join(tmp, "chrome.log"), "cold Chrome marker\n");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await waitForDevToolsPort({
        profileDir,
        timeoutMs: 60,
        isAlive: () => true,
        pollIntervalMs: 10,
      });
      expect(result).toEqual({ ok: false, reason: "timeout" });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("cold Chrome marker"),
      );
    } finally {
      stderr.mockRestore();
    }
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
