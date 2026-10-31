import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireHumanLease,
  getSession,
  isPidAlive,
  isProcessGroupAlive,
  listProcessGroupMembers,
  readPickforgeEnv,
  releaseHumanLease,
  type EnvLike,
} from "@pickforge/lab-core";
import { findOnPath } from "@pickforge/lab-desktop-linux";
import {
  browserRuntimeLayout,
  cdpWebSocketUrl,
  createBrowserSession,
  destroyBrowserSession,
  detectChromeBinary,
  enterPlainBrowser,
  getBrowserSessionStatus,
  restoreCdpBrowser,
  readBrowserSessionCdpEndpoint,
  type BrowserSessionHandle,
} from "../src/index.js";
import { readDevToolsBrowserVersion } from "../src/devtools.js";

const hasXvfb = findOnPath("Xvfb") !== null;
const hasChrome = detectChromeBinary() !== null;
const ready = hasXvfb && hasChrome;
const TEST_TIMEOUT_MS = 60_000;
// The first Chrome launch on a fresh CI runner has taken up to 39 s, and three
// times it passed the 45 s product budget. In those failures Chrome published
// its DevTools port, but the HTTP endpoint did not answer. Every later launch
// took about 1 s. The cause is not confirmed. Pay that cost once, with room to
// spare, so each test's startup budget measures a warm start.
const WARM_UP_CDP_TIMEOUT_MS = 120_000;
const WARM_UP_HOOK_TIMEOUT_MS = 150_000;
const SECRET = "pickforge-lab-integration-secret-should-not-leak";

let tmp: string;
let home: string;
let projectDir: string;
let registryEnv: EnvLike;
let spawnEnv: EnvLike;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-browser-int-"));
  home = path.join(tmp, "home");
  projectDir = path.join(tmp, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  registryEnv = { PICKFORGE_HOME: home };
  // Carry the real environment (so PICKFORGE_CHROME_NO_SANDBOX from constrained CI
  // is honored) plus a planted secret that must never reach the browser.
  spawnEnv = { ...process.env, SECRET_TOKEN: SECRET };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Send one browser-level CDP command through the session's own socket. */
async function browserCdp(session: BrowserSessionHandle, method: string, params = {}): Promise<any> {
  const endpoint = await readBrowserSessionCdpEndpoint(session.id, registryEnv);
  if (endpoint === undefined) throw new Error(`Session ${session.id} has no CDP endpoint`);
  const socket = new WebSocket(cdpWebSocketUrl(endpoint.socketPath, endpoint.browserPath));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error(`CDP ${method} timed out`)); }, 5_000);
    const finish = (error?: Error, result?: unknown) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve(result);
    };
    socket.addEventListener("error", () => finish(new Error(`CDP ${method} failed`)), { once: true });
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })), { once: true });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      finish(message.error ? new Error(message.error.message) : undefined, message.result);
    });
  });
}

interface CdpClient {
  send(method: string, params?: object): Promise<any>;
  close(): Promise<void>;
}

/** Open one websocket client on the session's socket for several commands. */
async function openCdpClient(session: BrowserSessionHandle): Promise<CdpClient> {
  const endpoint = await readBrowserSessionCdpEndpoint(session.id, registryEnv);
  if (endpoint === undefined) throw new Error(`Session ${session.id} has no CDP endpoint`);
  const socket = new WebSocket(cdpWebSocketUrl(endpoint.socketPath, endpoint.browserPath));
  const replies = new Map<number, (message: any) => void>();
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    replies.get(message.id)?.(message);
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 1;
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 10_000);
        replies.set(id, (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async close() {
      socket.close();
      if (socket.readyState !== WebSocket.CLOSED) await new Promise((resolve) => socket.once("close", resolve));
    },
  };
}

/** Socket inodes that any process of the group holds open. */
function groupSocketInodes(pgid: number): Set<string> {
  const inodes = new Set<string>();
  for (const pid of listProcessGroupMembers(pgid)) {
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (match?.[1] !== undefined) inodes.add(match[1]);
      } catch {
        // The fd closed while we listed it.
      }
    }
  }
  return inodes;
}

/** Loopback and wildcard TCP ports that any process of the group listens on. */
function listeningTcpPorts(pgid: number): number[] {
  const inodes = groupSocketInodes(pgid);
  const ports: number[] = [];
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of fs.readFileSync(table, "utf8").split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      // fields: sl, local address, remote address, state, ..., inode at 9.
      if (fields[3] !== "0A" || fields[9] === undefined || !inodes.has(fields[9])) continue;
      ports.push(Number.parseInt(fields[1]!.split(":")[1]!, 16));
    }
  }
  return ports;
}

/** The Chrome browser process of a session: the group member without --type. */
function chromeBrowserArgv(session: BrowserSessionHandle): string[] | undefined {
  for (const pid of listProcessGroupMembers(session.browserPid)) {
    if (pid === session.browserPid) continue;
    let argv: string[];
    try {
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    } catch {
      continue;
    }
    if (argv.includes(`--user-data-dir=${session.profileDir}`) && !argv.some((arg) => arg.startsWith("--type="))) {
      return argv;
    }
  }
  return undefined;
}

async function pageUrls(client: CdpClient): Promise<string[]> {
  const { targetInfos } = await client.send("Target.getTargets");
  return (targetInfos as Array<{ type: string; url: string }>)
    .filter((info) => info.type === "page")
    .map((info) => info.url);
}

/** A loopback page server, so the tabs have web URLs to reopen. */
async function startPageServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<title>page</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function answersJsonVersion(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

// The "no silent skip" guard: in CI (PICKFORGE_REQUIRE_BROWSER=1) the browser and
// Xvfb prerequisites must actually be present, so this suite cannot pass by
// silently skipping. Always runs.
describe("browser integration prerequisites", () => {
  it("has the browser prerequisites when they are required", () => {
    if (readPickforgeEnv(process.env, "REQUIRE_BROWSER") === "1") {
      expect({ hasXvfb, hasChrome }).toEqual({ hasXvfb: true, hasChrome: true });
    } else {
      expect(true).toBe(true);
    }
  });
});

describe.skipIf(!ready)("real headed Chrome under Xvfb", () => {
  beforeAll(async () => {
    const warmTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-browser-warm-"));
    const warmHome = path.join(warmTmp, "home");
    const warmProject = path.join(warmTmp, "project");
    fs.mkdirSync(warmHome, { recursive: true });
    fs.mkdirSync(warmProject, { recursive: true });
    const warmEnv = { PICKFORGE_HOME: warmHome };
    try {
      const session = await createBrowserSession({
        projectDir: warmProject,
        registryEnv: warmEnv,
        env: { ...process.env },
        cdpTimeoutMs: WARM_UP_CDP_TIMEOUT_MS,
      });
      await destroyBrowserSession(session.id, warmEnv);
    } catch (error) {
      // Chrome or Xvfb may still be alive, and a record can be unreadable, so
      // keep the temporary home for inspection and a manual teardown.
      throw new Error(`Chrome warm-up failed; kept ${warmTmp} for inspection`, {
        cause: error,
      });
    }
    fs.rmSync(warmTmp, { recursive: true, force: true });
  }, WARM_UP_HOOK_TIMEOUT_MS);

  it("persists a real Chrome login cookie across teardown and recovers after a crash", { timeout: 120_000 }, async () => {
    const opts = { projectDir, registryEnv, env: spawnEnv, profile: "ops" };
    const sessions: BrowserSessionHandle[] = [];
    try {
      const first = await createBrowserSession(opts);
      sessions.push(first);
      await browserCdp(first, "Storage.setCookies", { cookies: [{
        name: "pickforge_test", value: "persisted", domain: "example.test", path: "/",
        expires: Math.floor(Date.now() / 1000) + 3600,
      }] });
      await destroyBrowserSession(first.id, registryEnv);
      expect(fs.existsSync(first.profileDir)).toBe(true);
      const second = await createBrowserSession(opts);
      sessions.push(second);
      expect((await browserCdp(second, "Storage.getCookies")).cookies).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "pickforge_test", value: "persisted" }),
      ]));
      await expect(createBrowserSession(opts)).rejects.toThrow(second.id);
      process.kill(-second.browserPid, "SIGKILL");
      // The profile claim counts the whole process group, which can outlive its leader under load.
      await vi.waitFor(() => expect(isProcessGroupAlive(second.browserPid)).toBe(false), { timeout: 10_000 });
      expect(fs.lstatSync(path.join(second.profileDir, "SingletonLock")).isSymbolicLink()).toBe(true);
      const third = await createBrowserSession(opts);
      sessions.push(third);
      expect(third.profileDir).toBe(first.profileDir);
      expect((await browserCdp(third, "Storage.getCookies")).cookies).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "pickforge_test", value: "persisted" }),
      ]));
    } finally {
      for (const session of sessions) await destroyBrowserSession(session.id, registryEnv).catch(() => {});
    }
  });

  it(
    "hands a named profile to a plain Chrome for a takeover and restores it under CDP",
    { timeout: 120_000 },
    async () => {
      const pages = await startPageServer();
      const session = await createBrowserSession({ projectDir, registryEnv, env: spawnEnv, profile: "ops" });
      try {
        const urls = [`${pages.origin}/one`, `${pages.origin}/two`];
        const before = await openCdpClient(session);
        try {
          await before.send("Storage.setCookies", { cookies: [{
            name: "pickforge_handoff", value: "kept", domain: "example.test", path: "/",
            expires: Math.floor(Date.now() / 1000) + 3600,
          }] });
          for (const url of urls) await before.send("Target.createTarget", { url });
          await vi.waitFor(async () => expect(await pageUrls(before)).toEqual(expect.arrayContaining(urls)), {
            timeout: 10_000,
          });
        } finally {
          await before.close();
        }
        const lease = await acquireHumanLease(session.id, registryEnv);
        try {
          expect(await enterPlainBrowser(session.id, registryEnv)).toBe(true);
          expect((await readBrowserSessionCdpEndpoint(session.id, registryEnv))?.mode).toBe("plain");
          const plain = await vi.waitFor(() => {
            const argv = chromeBrowserArgv(session);
            if (argv === undefined) throw new Error("no plain Chrome yet");
            return argv;
          }, { timeout: 10_000 });
          expect(plain.some((arg) => arg.startsWith("--remote-debugging-"))).toBe(false);
          expect(plain).toContain("--password-store=basic");
          expect(plain).toEqual(expect.arrayContaining(urls));
          expect((await getBrowserSessionStatus(session.id, registryEnv)).alive).toBe(true);

          expect(await restoreCdpBrowser(session.id, registryEnv)).toBe(true);
        } finally {
          await releaseHumanLease(session.id, lease.leaseId, registryEnv);
        }
        expect((await readBrowserSessionCdpEndpoint(session.id, registryEnv))?.mode).toBe("cdp");
        expect(chromeBrowserArgv(session)).toContain("--remote-debugging-pipe");
        const after = await vi.waitFor(() => openCdpClient(session), { timeout: 10_000, interval: 100 });
        try {
          expect((await after.send("Browser.getVersion")).product).toMatch(/Chrome/);
          expect((await after.send("Storage.getCookies")).cookies).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "pickforge_handoff", value: "kept" }),
          ]));
          await vi.waitFor(async () => expect(await pageUrls(after)).toEqual(expect.arrayContaining(urls)), {
            timeout: 10_000,
          });
        } finally {
          await after.close();
        }
        expect((await getBrowserSessionStatus(session.id, registryEnv)).alive).toBe(true);
        // A session that ended is no longer restored.
        await destroyBrowserSession(session.id, registryEnv);
        expect(await restoreCdpBrowser(session.id, registryEnv)).toBe(false);
      } finally {
        await destroyBrowserSession(session.id, registryEnv).catch(() => {});
        await pages.close();
      }
    },
  );

  it(
    "starts from a deeply nested home without exceeding Chrome socket limits",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const longHome = path.join(
        tmp,
        "nested-pickforge-home-aaaaaaaaaaaa",
        "nested-release-evidence-bbbbbbbbbbbb",
        "nested-browser-runtime-cccccccccccc",
      );
      fs.mkdirSync(longHome, { recursive: true });
      const longEnv = { PICKFORGE_HOME: longHome };
      const session = await createBrowserSession({
        projectDir,
        registryEnv: longEnv,
        env: spawnEnv,
      });
      const layout = browserRuntimeLayout(session.logDir);
      try {
        const environ = fs.readFileSync(
          `/proc/${session.browserPid}/environ`,
          "utf8",
        );
        expect(environ.split("\0")).toContain(`TMPDIR=${layout.chromeTmpDir}`);
        expect(fs.realpathSync(layout.chromeTmpDir)).toBe(layout.tmpDir);
        // Chrome's process singleton directory (com.google.Chrome.* or
        // org.chromium.Chromium.*) must land physically inside the session's
        // own temp directory, not loose under /tmp.
        expect(
          fs.readdirSync(layout.tmpDir).filter((name) => /Chrom/i.test(name)),
        ).not.toHaveLength(0);
      } finally {
        await destroyBrowserSession(session.id, longEnv).catch(() => {});
      }
      expect(fs.existsSync(layout.chromeTmpDir)).toBe(false);
      expect(fs.existsSync(path.join(session.logDir, "chrome.log"))).toBe(true);
      expect(fs.existsSync(path.join(session.logDir, "stopped.json"))).toBe(true);
    },
  );

  it(
    "launches an isolated session, serves CDP only on its private socket, and scrubs secrets",
    // Real Xvfb + real Chrome startup is timing-sensitive on a saturated host;
    // retry absorbs transient display/startup nondeterminism.
    { timeout: TEST_TIMEOUT_MS, retry: 2 },
    async () => {
      const session = await createBrowserSession({
        projectDir,
        registryEnv,
        env: spawnEnv,
        width: 1024,
        height: 768,
      });
      try {
        const status = await getBrowserSessionStatus(session.id, registryEnv);
        expect(status.xvfbAlive).toBe(true);
        expect(status.displayAlive).toBe(true);
        expect(status.browserAlive).toBe(true);
        expect(status.alive).toBe(true);

        // CDP answers only on the supervisor's 0600 socket in the 0700
        // session temp directory, and Chrome itself listens on no TCP port
        // that answers DevTools.
        const layout = browserRuntimeLayout(session.logDir);
        expect(fs.statSync(layout.cdpSocketPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(layout.cdpEndpointFile).mode & 0o777).toBe(0o600);
        expect(fs.statSync(layout.tmpDir).mode & 0o777).toBe(0o700);
        expect(await readDevToolsBrowserVersion(layout.cdpSocketPath)).toMatch(/^[\w.]+\/[\d.]+$/);
        const ports = listeningTcpPorts(session.browserPid);
        for (const port of ports) expect(await answersJsonVersion(port), `port ${port}`).toBe(false);
        const argv = fs.readFileSync(`/proc/${session.browserPid}/cmdline`, "utf8").split("\0");
        expect(argv.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(false);
        expect(argv).toContain("--remote-debugging-pipe");

        // The capability websocket URL must never be persisted.
        const raw = fs.readFileSync(
          path.join(home, "sessions", `${session.id}.json`),
          "utf8",
        );
        expect(raw).not.toContain("/devtools/browser/");
        expect(raw).not.toContain("webSocketDebuggerUrl");

        // The browser build is captured once at startup so evidence runs can
        // record it without touching the network.
        const record = await getSession(session.id, registryEnv);
        expect(record?.browser?.browserVersion).toMatch(/^[\w.]+\/[\d.]+$/);

        // The planted secret must not be in the browser's own environment,
        // while the isolated display and HOME must be.
        const environ = fs.readFileSync(
          `/proc/${session.browserPid}/environ`,
          "utf8",
        );
        const vars = environ.split("\0").filter((v) => v !== "");
        expect(vars.some((v) => v.includes(SECRET))).toBe(false);
        expect(vars).toContain(`DISPLAY=${session.display}`);
        expect(vars).toContain(`HOME=${path.join(session.logDir, "home")}`);

        expect(fs.existsSync(session.profileDir)).toBe(true);
      } finally {
        await destroyBrowserSession(session.id, registryEnv).catch(() => {});
      }

      // Destroy left nothing behind.
      expect(listProcessGroupMembers(session.browserPid)).toEqual([]);
      expect(isPidAlive(session.browserPid)).toBe(false);
      expect(isPidAlive(session.xvfbPid)).toBe(false);
      expect(fs.existsSync(session.profileDir)).toBe(false);
      expect(await getSession(session.id, registryEnv)).toBeUndefined();
    },
  );

  it(
    "gives two concurrent sessions distinct displays, CDP sockets, and profiles",
    { timeout: TEST_TIMEOUT_MS, retry: 2 },
    async () => {
      const settled = await Promise.allSettled([
        createBrowserSession({ projectDir, registryEnv, env: spawnEnv }),
        createBrowserSession({ projectDir, registryEnv, env: spawnEnv }),
      ]);
      const sessions = settled
        .filter(
          (r): r is PromiseFulfilledResult<BrowserSessionHandle> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);
      try {
        expect(
          settled
            .filter((r): r is PromiseRejectedResult => r.status === "rejected")
            .map((r) => String(r.reason)),
        ).toEqual([]);
        const [a, b] = sessions as [BrowserSessionHandle, BrowserSessionHandle];
        expect(a.display).not.toBe(b.display);
        expect(browserRuntimeLayout(a.logDir).cdpSocketPath).not.toBe(
          browserRuntimeLayout(b.logDir).cdpSocketPath,
        );
        expect(a.profileDir).not.toBe(b.profileDir);
      } finally {
        for (const s of sessions) {
          await destroyBrowserSession(s.id, registryEnv).catch(() => {});
        }
      }
    },
  );

  it(
    "gives each CDP client its own browser session, which Chrome ends when the client leaves",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const session = await createBrowserSession({ projectDir, registryEnv, env: spawnEnv });
      try {
        const first = await openCdpClient(session);
        const { browserContextId } = await first.send("Target.createBrowserContext", { disposeOnDetach: true });
        expect((await first.send("Target.getBrowserContexts")).browserContextIds).toContain(browserContextId);
        await first.send("Tracing.start");
        await first.close();

        // The supervisor waits for the reset before it accepts the next client.
        const second = await vi.waitFor(() => openCdpClient(session), { timeout: 10_000, interval: 100 });
        try {
          expect((await second.send("Target.getBrowserContexts")).browserContextIds).not.toContain(browserContextId);
          await expect(second.send("Tracing.start")).resolves.toEqual({});
          await second.send("Tracing.end");
        } finally {
          await second.close();
        }
      } finally {
        await destroyBrowserSession(session.id, registryEnv).catch(() => {});
      }
    },
  );

  it(
    "ends Chrome when its supervisor is killed, so no browser outlives the pipe",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const session = await createBrowserSession({ projectDir, registryEnv, env: spawnEnv });
      const layout = browserRuntimeLayout(session.logDir);
      try {
        const chrome = listProcessGroupMembers(session.browserPid).filter((pid) => pid !== session.browserPid);
        expect(chrome.length).toBeGreaterThan(0);
        // Only the supervisor; Chrome sees its CDP pipe close.
        process.kill(session.browserPid, "SIGKILL");
        await vi.waitFor(() => expect(listProcessGroupMembers(session.browserPid)).toEqual([]), {
          timeout: 15_000,
          interval: 100,
        });
        for (const pid of chrome) expect(isPidAlive(pid)).toBe(false);
        expect((await getBrowserSessionStatus(session.id, registryEnv)).browserAlive).toBe(false);
      } finally {
        await destroyBrowserSession(session.id, registryEnv).catch(() => {});
      }
      expect(await getSession(session.id, registryEnv)).toBeUndefined();
      expect(fs.existsSync(layout.tmpDir)).toBe(false);
      expect(isPidAlive(session.xvfbPid)).toBe(false);
    },
  );
});
