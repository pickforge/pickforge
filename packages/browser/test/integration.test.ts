import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSession,
  isPidAlive,
  listProcessGroupMembers,
  readPickforgeEnv,
  type EnvLike,
} from "@pickforge/lab-core";
import { findOnPath } from "@pickforge/lab-desktop-linux";
import {
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
