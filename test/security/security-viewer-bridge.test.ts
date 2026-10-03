import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  readProcessIdentity,
  updateSession,
} from "@pickforge/lab-core";
import {
  prepareViewerLaunch,
  writeViewerLaunchRecord,
} from "@pickforge/lab-desktop-linux";
import type { WebSocket as ViewerWebSocket } from "../../packages/cli/node_modules/@types/ws/index.js";
import {
  startViewerBridge,
  type ViewerBridge,
} from "../../packages/cli/src/viewer/bridge.js";

const { WebSocket } = createRequire(
  new URL("../../packages/cli/package.json", import.meta.url),
)("ws") as typeof import("../../packages/cli/node_modules/@types/ws/index.js");
let testRoot: string;
let registryEnv: NodeJS.ProcessEnv;
let sessionId: string;
let launchId: string;
let token: string;
let bridge: ViewerBridge;
let upstream: net.Server;
const sockets: net.Socket[] = [];
const clients: ViewerWebSocket[] = [];
let controller: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(
    path.join(process.cwd(), ".viewer-security-test-"),
  );
  registryEnv = { ...process.env, PICKFORGE_HOME: testRoot };
  const identity = readProcessIdentity(process.pid)!;
  upstream = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("data", (data) => socket.write(data));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  sessionId = (
    await createSession(
      {
        type: "desktop",
        status: "running",
        projectDir: testRoot,
        desktop: {
          display: ":991",
          vncPid: process.pid,
          vncStartTimeTicks: identity.startTicks,
          vncPort: (upstream.address() as net.AddressInfo).port,
          vncViewOnly: true,
          viewerBridgePid: process.pid,
        },
      },
      registryEnv,
    )
  ).id;
  const launch = await prepareViewerLaunch(sessionId, registryEnv);
  launchId = launch.launchId;
  await writeViewerLaunchRecord(
    {
      launchId,
      sessionId: sessionId,
      createdAt: new Date().toISOString(),
      browser: { kind: "chromium", binary: process.execPath },
      profileDir: launch.profileDir,
      thumbnail: { width: 320, height: 200 },
      expanded: { width: 1280, height: 800 },
    },
    registryEnv,
  );
  await fs.mkdir(path.join(testRoot, "page"));
  await fs.mkdir(path.join(testRoot, "novnc", "core", "nested"), {
    recursive: true,
  });
  await fs.mkdir(path.join(testRoot, "novnc", "vendor"), { recursive: true });
  for (const file of ["index.html", "viewer.js", "viewer.css"]) {
    await fs.writeFile(path.join(testRoot, "page", file), file);
  }
  for (const file of [
    "core/rfb.js",
    "core/nested/module.js",
    "vendor/module.js",
    "core/secret.txt",
  ]) {
    await fs.writeFile(path.join(testRoot, "novnc", file), file);
  }
  await fs.writeFile(path.join(testRoot, "outside.js"), "secret");
  await fs.symlink(
    path.join(testRoot, "outside.js"),
    path.join(testRoot, "novnc", "core", "escape.js"),
  );
  token = randomBytes(32).toString("base64url");
  controller = vi.fn(async () => true);
  bridge = await startViewerBridge({
    sessionId: sessionId,
    token,
    registryEnv: registryEnv,
    assets: {
      pageDir: path.join(testRoot, "page"),
      novncDir: path.join(testRoot, "novnc"),
    },
    windowController: controller,
  });
});

afterEach(async () => {
  for (const webSocket of clients.splice(0)) {
    webSocket.terminate();
  }
  await bridge?.close();
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  vi.restoreAllMocks();
  await fs.rm(testRoot, { recursive: true, force: true });
});

function rawRequest(
  requestPath: string,
  headers: string[] = [],
  method = "GET",
  body = "",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: bridge.port });
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error("HTTP test deadline"));
    });
    let response = "";
    socket.on("data", (data) => {
      response += data.toString();
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(response));
    socket.on("connect", () =>
      socket.write(
        `${method} ${requestPath} HTTP/1.1\r\n${headers.join("\r\n")}\r\n${headers.some((header) => header.startsWith("Connection:")) ? "" : "Connection: close\r\n"}${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ""}\r\n${body}`,
      ),
    );
  });
}

function host(): string {
  return `Host: 127.0.0.1:${bridge.port}`;
}

function origin(): string {
  return `Origin: http://127.0.0.1:${bridge.port}`;
}

function api(): string {
  return `/api/launches/${launchId}/window`;
}

function apiHeaders(): string[] {
  return [
    host(),
    origin(),
    `Authorization: Bearer ${token}`,
    "Content-Type: application/json",
  ];
}

function websocket(
  query = `token=${token}`,
  headers: Record<string, string> = {},
  route = "/websockify",
  protocols?: string[],
): ViewerWebSocket {
  const webSocket = new WebSocket(
    `ws://127.0.0.1:${bridge.port}${route}?${query}`,
    protocols,
    {
      headers: { Origin: `http://127.0.0.1:${bridge.port}`, ...headers },
      handshakeTimeout: 2000,
    },
  );
  clients.push(webSocket);
  webSocket.on("error", () => {});
  return webSocket;
}

async function rejection(webSocket: ViewerWebSocket): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    webSocket.once("unexpected-response", (_req, response) => {
      response.resume();
      webSocket.terminate();
      resolve(response.statusCode!);
    });
    webSocket.once("open", () => reject(new Error("Unexpected upgrade")));
    webSocket.once("error", (error) => reject(error));
  });
}

describe("viewer HTTP boundary", () => {
  it("binds only IPv4 loopback and serves token-free GET and HEAD assets with exact headers", async () => {
    const response = await rawRequest(`/viewer/${launchId}`, [host()]);
    expect(response).toContain("HTTP/1.1 200");
    expect(response).toContain("index.html");
    const expectedHeaders = {
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; " +
        `connect-src 'self' ws://127.0.0.1:${bridge.port}; object-src 'none'; base-uri 'none'; ` +
        "frame-ancestors 'none'; form-action 'none'; worker-src 'none'",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
    for (const [key, value] of Object.entries(expectedHeaders)) {
      expect(response.toLowerCase()).toContain(
        `${key}: ${value}`.toLowerCase(),
      );
    }
    expect(response).toContain("text/html; charset=utf-8");
    const head = await rawRequest("/viewer-assets/viewer.js", [host()], "HEAD");
    expect(head).toContain("text/javascript; charset=utf-8");
    expect(head.split("\r\n\r\n")[1]).toBe("");
    for (const route of [
      "/viewer-assets/viewer.css",
      "/novnc/core/rfb.js",
      "/novnc/core/nested/module.js",
      "/novnc/vendor/module.js",
    ]) {
      expect(await rawRequest(route, [host()])).toContain("HTTP/1.1 200");
    }
    const listen = await fs.readFile("/proc/net/tcp", "utf8");
    const hex = bridge.port.toString(16).toUpperCase().padStart(4, "0");
    expect(listen).toContain(`0100007F:${hex}`);
    expect(listen).not.toContain(`00000000:${hex}`);
  });
  it.each([
    { headers: [] },
    { headers: ["Host: localhost:123"] },
    { headers: ["Host: evil.example"] },
    { headers: ["Host: 0.0.0.0:123"] },
    { headers: ["Host: 127.0.0.1"] },
  ])("rejects missing or different Host %j", async ({ headers }) => {
    expect(await rawRequest(`/viewer/${launchId}`, headers)).toContain(
      "HTTP/1.1 403",
    );
  });
  it("rejects duplicate exact Host on static requests and upgrades", async () => {
    for (const route of [`/viewer/${launchId}`, `/websockify?token=${token}`]) {
      expect(
        await rawRequest(route, [
          host(),
          host(),
          origin(),
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ]),
      ).toContain("HTTP/1.1 403");
    }
    expect(
      await rawRequest(
        api(),
        [host(), host(), ...apiHeaders().slice(1)],
        "POST",
        '{"mode":"thumbnail"}',
      ),
    ).toContain("HTTP/1.1 403");
  });
  it.each([
    "null",
    "http://localhost:123",
    "https://127.0.0.1",
    "http://evil.example",
  ])("rejects Origin %s on GET, POST and upgrade", async (value) => {
    expect(
      await rawRequest(`/viewer/${launchId}`, [host(), `Origin: ${value}`]),
    ).toContain("HTTP/1.1 403");
    expect(
      await rawRequest(
        api(),
        apiHeaders().map((header) =>
          header.startsWith("Origin:") ? `Origin: ${value}` : header,
        ),
        "POST",
        '{"mode":"expanded"}',
      ),
    ).toContain("HTTP/1.1 403");
    expect(await rejection(websocket(undefined, { Origin: value }))).toBe(403);
  });
  it("requires one exact Origin for POST and upgrade", async () => {
    expect(
      await rawRequest(
        api(),
        apiHeaders().filter((header) => !header.startsWith("Origin:")),
        "POST",
        '{"mode":"expanded"}',
      ),
    ).toContain("HTTP/1.1 403");
    expect(
      await rawRequest(
        api(),
        [...apiHeaders(), origin()],
        "POST",
        '{"mode":"expanded"}',
      ),
    ).toContain("HTTP/1.1 403");
    const response = await rawRequest(`/websockify?token=${token}`, [
      host(),
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ]);
    expect(response).toContain("HTTP/1.1 403");
    expect(
      await rejection(websocket(undefined, { Host: "evil.example" })),
    ).toBe(403);
  });
  it.each([
    "/",
    "/viewer/bad",
    "/viewer-assets/index.html",
    "/viewer-assets/../token",
    "/viewer-assets/viewer.js?x=1",
    "/novnc/core/secret.txt",
    "/novnc/core/escape.js",
    "/novnc/package.json",
    "/novnc/core/../secret.js",
    "/novnc/core/%2e%2e/outside.js",
    "/websockify",
    "/token",
  ])("rejects unlisted path %s", async (route) => {
    const response = await rawRequest(route, [host()]);
    expect(response).toContain("HTTP/1.1 404");
    expect(response.toLowerCase()).toContain("cache-control: no-store");
  });
  it("rejects malformed upgrades and HTTP Expect/CONNECT with security headers", async () => {
    for (const expectValue of ["100-continue", "unrecognized"]) {
      const response = await rawRequest(
        `/viewer/${launchId}`,
        [host(), origin(), `Expect: ${expectValue}`],
        "POST",
      );
      expect(response).toContain("HTTP/1.1 417");
      expect(response).toContain("Cache-Control: no-store");
      expect(response).not.toContain("HTTP/1.1 100");
    }
    const connect = await rawRequest(
      "foreign.example:5900",
      [host()],
      "CONNECT",
    );
    expect(connect).toContain("HTTP/1.1 404");
    expect(connect).toContain("Cache-Control: no-store");
    const bad = await rawRequest(`/websockify?token=${token}`, [
      host(),
      origin(),
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 12",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ]);
    expect(bad).toContain("HTTP/1.1 400");
    expect(bad).toContain("Cache-Control: no-store");
    const malformed = await rawRequest("//[?token=private", [
      host(),
      origin(),
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ]);
    expect(malformed).toContain("HTTP/1.1 403");
  });
  it("requires Host and a single Origin on every upgrade and POST", async () => {
    for (const headers of [[], ["Host: foreign.example"], [host(), host()]]) {
      const response = await rawRequest(`/websockify?token=${token}`, [
        ...headers,
        origin(),
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ]);
      expect(response).toContain("HTTP/1.1 403");
      expect(
        await rawRequest(
          api(),
          [...headers, ...apiHeaders().slice(1)],
          "POST",
          '{"mode":"thumbnail"}',
        ),
      ).toContain("HTTP/1.1 403");
    }
    const duplicate = await rawRequest(`/websockify?token=${token}`, [
      host(),
      origin(),
      origin(),
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ]);
    expect(duplicate).toContain("HTTP/1.1 403");
  });
  it("rejects wrong asset/API methods", async () => {
    expect(
      await rawRequest("/viewer-assets/viewer.js", [host(), origin()], "POST"),
    ).toContain("HTTP/1.1 405");
    expect(await rawRequest(`/viewer/${launchId}`, [host()], "PUT")).toContain(
      "HTTP/1.1 405",
    );
    expect(await rawRequest(api(), [host()])).toContain("HTTP/1.1 405");
  });
});

describe("viewer status API", () => {
  it("accepts exactly one valid Bearer token with optional exact Origin", async () => {
    for (const origins of [[], [origin()]]) {
      const response = await rawRequest("/api/status", [
        host(),
        ...origins,
        `Authorization: Bearer ${token}`,
      ]);
      expect(response).toContain("HTTP/1.1 204");
      expect(response.split("\r\n\r\n")[1]).toBe("");
      expect(response).toContain("Cache-Control: no-store");
      expect(response).toContain("X-Content-Type-Options: nosniff");
      expect(response).toContain("Referrer-Policy: no-referrer");
      expect(response).toContain(
        "Content-Type: application/json; charset=utf-8",
      );
      expect(response).toContain(
        "Content-Security-Policy: default-src 'none';",
      );
    }
  });
  it.each([
    undefined,
    "Bearer wrong",
    `Bearer ${"x".repeat(43)}`,
    "Basic wrong",
    "bearer wrong",
  ])("rejects invalid status authorization %s", async (authorization) => {
    const headers = [host()];
    if (authorization !== undefined) {
      headers.push(`Authorization: ${authorization}`);
    }
    const response = await rawRequest("/api/status", headers);
    expect(response).toContain("HTTP/1.1 401");
    expect(response).toContain("Cache-Control: no-store");
  });
  it("rejects duplicate valid authorization and query-string capabilities", async () => {
    expect(
      await rawRequest("/api/status", [
        host(),
        `Authorization: Bearer ${token}`,
        `Authorization: Bearer ${token}`,
      ]),
    ).toContain("HTTP/1.1 401");
    expect(
      await rawRequest("/api/status", [host(), `Cookie: token=${token}`]),
    ).toContain("HTTP/1.1 401");
    expect(await rawRequest(`/api/status?token=${token}`, [host()])).toContain(
      "HTTP/1.1 404",
    );
  });
  it("rejects missing, duplicate or foreign Host and invalid Origin", async () => {
    for (const headers of [
      [],
      [host(), host()],
      ["Host: localhost:123"],
      ["Host: evil.example"],
      [host(), "Origin: null"],
      [host(), "Origin: http://evil.example"],
      [host(), origin(), origin()],
    ]) {
      expect(
        await rawRequest("/api/status", [
          ...headers,
          `Authorization: Bearer ${token}`,
        ]),
      ).toContain("HTTP/1.1 403");
    }
  });
  it.each(["HEAD", "POST", "PUT", "DELETE", "OPTIONS"])(
    "rejects status method %s",
    async (method) => {
      for (const origins of [[], [origin()]]) {
        expect(
          await rawRequest(
            "/api/status",
            [host(), ...origins, `Authorization: Bearer ${token}`],
            method,
          ),
        ).toContain("HTTP/1.1 405");
      }
    },
  );
});

describe("window API", () => {
  it("applies only this session's validated launch and returns the selected size", async () => {
    const response = await rawRequest(
      api(),
      apiHeaders(),
      "POST",
      '{"mode":"expanded"}',
    );
    expect(response).toContain("HTTP/1.1 200");
    expect(response).toContain(
      '{"applied":true,"size":{"width":1280,"height":800}}',
    );
    expect(controller).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: sessionId }),
      "expanded",
    );
    controller.mockResolvedValue(false);
    expect(
      await rawRequest(api(), apiHeaders(), "POST", '{"mode":"thumbnail"}'),
    ).toContain('"applied":false');
    expect(
      await rawRequest(
        `/api/launches/${"a".repeat(32)}/window`,
        apiHeaders(),
        "POST",
        '{"mode":"thumbnail"}',
      ),
    ).toContain("HTTP/1.1 404");
    const launchDirectory = path.join(
      testRoot,
      "sessions",
      sessionId,
      "viewer",
      "launches",
      launchId,
    );
    const launchRecord = JSON.parse(
      await fs.readFile(path.join(launchDirectory, "launch.json"), "utf8"),
    );
    launchRecord.sessionId = "desk-abcdef";
    await fs.writeFile(
      path.join(launchDirectory, "launch.json"),
      JSON.stringify(launchRecord),
    );
    expect(
      await rawRequest(api(), apiHeaders(), "POST", '{"mode":"thumbnail"}'),
    ).toContain("HTTP/1.1 404");
  });
  it.each([
    undefined,
    "Bearer wrong",
    "Bearer " + "x".repeat(43),
    "Basic wrong",
  ])("rejects API capability %s", async (authorization) => {
    const headers = apiHeaders().filter(
      (header) => !header.startsWith("Authorization:"),
    );
    if (authorization !== undefined) {
      headers.push(`Authorization: ${authorization}`);
    }
    expect(
      await rawRequest(api(), headers, "POST", '{"mode":"expanded"}'),
    ).toContain("HTTP/1.1 401");
    expect(controller).not.toHaveBeenCalled();
  });
  it("rejects duplicate Authorization, wrong content type and bodies over 1 KiB", async () => {
    expect(
      await rawRequest(
        api(),
        [...apiHeaders(), `Authorization: Bearer ${token}`],
        "POST",
        '{"mode":"expanded"}',
      ),
    ).toContain("HTTP/1.1 401");
    expect(
      await rawRequest(
        api(),
        apiHeaders().filter((header) => !header.startsWith("Content-Type:")),
        "POST",
        '{"mode":"expanded"}',
      ),
    ).toContain("HTTP/1.1 415");
    expect(
      await rawRequest(api(), apiHeaders(), "POST", "x".repeat(1025)),
    ).toContain("HTTP/1.1 413");
    const status = await new Promise<number>((resolve) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: bridge.port,
          path: api(),
          method: "POST",
          headers: {
            Origin: `http://127.0.0.1:${bridge.port}`,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.write("x".repeat(1025));
      request.end();
    });
    expect(status).toBe(413);
    expect(controller).not.toHaveBeenCalled();
  });
  it.each([
    "null",
    "[]",
    "{}",
    '{"mode":"control"}',
    '{"mode":"expanded","extra":true}',
    "invalid",
  ])("rejects invalid JSON body %s", async (body) => {
    expect(await rawRequest(api(), apiHeaders(), "POST", body)).toContain(
      "HTTP/1.1 400",
    );
    expect(controller).not.toHaveBeenCalled();
  });
});

describe("WebSocket capability and passive upstream", () => {
  it.each([
    "",
    "token=wrong",
    `token=${"x".repeat(43)}`,
    "token=null",
    "token=a&token=b",
  ])("rejects invalid capability query %s", async (query) => {
    expect(await rejection(websocket(query))).toBe(403);
    expect(sockets).toHaveLength(0);
  });
  it("rejects a duplicated valid token and wrong upgrade paths", async () => {
    expect(await rejection(websocket(`token=${token}&token=${token}`))).toBe(
      403,
    );
    expect(await rejection(websocket(undefined, {}, "/websockify/"))).toBe(403);
    expect(await rejection(websocket(undefined, {}, "/arbitrary"))).toBe(403);
  });
  it("accepts no subprotocol or binary only, with compression disabled and binary echo", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    for (const protocols of [undefined, ["other", "binary"]]) {
      const webSocket = websocket(undefined, {}, undefined, protocols);
      await once(webSocket, "open");
      expect(webSocket.protocol).toBe(protocols ? "binary" : "");
      expect(webSocket.extensions).toBe("");
      const received = once(webSocket, "message");
      webSocket.send(Buffer.from("private frame"));
      const [data, binary] = await received;
      expect(binary).toBe(true);
      expect(data.toString()).toBe("private frame");
      webSocket.close();
      await once(webSocket, "close");
    }
    const unsupported = websocket(undefined, {}, undefined, ["other"]);
    const handshake = new Promise<http.IncomingMessage>((resolve) =>
      unsupported.once("upgrade", resolve),
    );
    const rejected = once(unsupported, "error");
    const closed = new Promise<void>((resolve) =>
      unsupported.once("close", () => resolve()),
    );
    const unsupportedResponse = await handshake;
    expect(unsupportedResponse.statusCode).toBe(101);
    expect(
      unsupportedResponse.headers["sec-websocket-protocol"],
    ).toBeUndefined();
    expect((await rejected)[0].message).toBe("Server sent no subprotocol");
    await closed;
    expect(unsupported.readyState).toBe(WebSocket.CLOSED);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it("rejects text frames, oversized frames and excess concurrent connections", async () => {
    let webSocket = websocket();
    await once(webSocket, "open");
    let closed = once(webSocket, "close");
    webSocket.send("text");
    expect((await closed)[0]).toBe(1003);
    webSocket = websocket();
    await once(webSocket, "open");
    closed = once(webSocket, "close");
    webSocket.send(Buffer.alloc(64 * 1024 + 1));
    expect((await closed)[0]).toBe(1009);
    await vi.waitFor(() =>
      expect(sockets.every((socket) => socket.destroyed)).toBe(true),
    );
    for (let connectionIndex = 0; connectionIndex < 8; connectionIndex++) {
      const next = websocket();
      await once(next, "open");
    }
    expect(await rejection(websocket())).toBe(503);
  });
  it.each([
    [false, 4002],
    [undefined, 4002],
  ] as const)("refuses VNC view-only flag %s", async (vncViewOnly, code) => {
    const desktop = (await import("@pickforge/lab-core").then((coreModule) =>
      coreModule.getSession(sessionId, registryEnv),
    ))!.desktop!;
    await updateSession(
      sessionId,
      { desktop: { ...desktop, vncViewOnly } },
      registryEnv,
    );
    const webSocket = websocket();
    const close = once(webSocket, "close");
    await once(webSocket, "open");
    expect((await close)[0]).toBe(code);
    expect(sockets).toHaveLength(0);
  });
  it.each([
    ["stopped", 4003],
    ["running", 4001],
  ] as const)(
    "maps unusable VNC/session to close code %s",
    async (status, code) => {
      await updateSession(
        sessionId,
        { status, desktop: { display: ":991", viewerBridgePid: process.pid } },
        registryEnv,
      );
      const webSocket = websocket();
      const close = once(webSocket, "close");
      await once(webSocket, "open");
      expect((await close)[0]).toBe(code);
      expect(sockets).toHaveLength(0);
    },
  );
});
