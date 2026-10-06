import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getSession,
  isPidAlive,
  listProcessGroupMembers,
  listSessions,
  readPickforgeEnv,
  REAPER_CLEANUP_PENDING_META_KEY,
  type EnvLike,
} from "@pickforge/lab-core";
import { findOnPath } from "@pickforge/lab-desktop-linux";
import {
  browserRuntimeLayout,
  createBrowserSession,
  destroyBrowserSession,
  detectChromeBinary,
  getBrowserSessionStatus,
  type BrowserSessionHandle,
} from "../src/index.js";

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

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
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
    let failure: unknown;
    try {
      const session = await createBrowserSession({
        projectDir: warmProject,
        registryEnv: warmEnv,
        env: { ...process.env },
        cdpTimeoutMs: WARM_UP_CDP_TIMEOUT_MS,
      });
      await destroyBrowserSession(session.id, warmEnv);
    } catch (error) {
      failure = error;
    }
    // Cleanup is confirmed only when no record keeps a process identity or a
    // pending cleanup mark. Otherwise keep the registry for the reaper and
    // for inspection, because Chrome or Xvfb may still be alive.
    const unconfirmed = await listSessions(warmEnv).then(
      (records) =>
        records.filter(
          (record) =>
            record.desktop !== undefined ||
            record.browser !== undefined ||
            record.meta?.[REAPER_CLEANUP_PENDING_META_KEY] === true,
        ).length > 0,
      () => true,
    );
    if (unconfirmed) {
      throw new Error(
        `Chrome warm-up cleanup was not confirmed; kept ${warmTmp} for inspection`,
        { cause: failure },
      );
    }
    fs.rmSync(warmTmp, { recursive: true, force: true });
    if (failure !== undefined) throw failure;
  }, WARM_UP_HOOK_TIMEOUT_MS);

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
    "launches an isolated session, binds CDP to loopback, and scrubs secrets",
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

        // CDP answers on loopback and reports a loopback websocket URL.
        const version = (await fetchJson(
          `http://127.0.0.1:${session.cdpPort}/json/version`,
        )) as { webSocketDebuggerUrl?: string };
        expect(version.webSocketDebuggerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);

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
    "gives two concurrent sessions distinct displays, ports, and profiles",
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
        expect(a.cdpPort).not.toBe(b.cdpPort);
        expect(a.profileDir).not.toBe(b.profileDir);
      } finally {
        for (const s of sessions) {
          await destroyBrowserSession(s.id, registryEnv).catch(() => {});
        }
      }
    },
  );
});
