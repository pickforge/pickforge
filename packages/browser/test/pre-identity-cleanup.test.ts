import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REAPER_CLEANUP_PENDING_META_KEY,
  destroySessionRecord,
  isPidAlive,
  listSessions,
  type EnvLike,
} from "@pickforge/lab-core";

// A sentinel Xvfb pid/display, standing in for a real X server: this suite
// only exercises the pre-identity Chrome cleanup path, so Xvfb itself is
// mocked away (no Xvfb binary required, unlike the fake-binary suites in
// session.test.ts).
const FAKE_XVFB_PID = 4_194_301;
const FAKE_DISPLAY = ":244";

vi.mock("@pickforge/lab-desktop-linux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pickforge/lab-desktop-linux")>();
  return {
    ...actual,
    startXvfb: vi.fn(
      async (opts: {
        onSpawn?: (partial: {
          pid: number;
          display: string;
          startTimeTicks: number;
          width: number;
          height: number;
        }) => void | Promise<void>;
      }) => {
        const partial = {
          pid: FAKE_XVFB_PID,
          display: FAKE_DISPLAY,
          startTimeTicks: 456,
          width: 1280,
          height: 800,
        };
        await opts.onSpawn?.(partial);
        return {
          ...partial,
          logPath: "/tmp/fake-browser-pre-identity-xvfb.log",
        };
      },
    ),
  };
});

// Simulate the "pathological /proc identity-read failure" the issue
// describes: the owned Chrome supervisor is alive, but its own identity can
// never be captured.
vi.mock("@pickforge/lab-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pickforge/lab-core")>();
  return {
    ...actual,
    readProcessIdentity: vi.fn(() => undefined),
  };
});

// Wrapped (not replaced) so the default behavior is the real supervisor; only
// the "missing supervisor" test below swaps in a stand-in for the duration of
// a single call.
vi.mock("../src/supervisor.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/supervisor.js")>();
  return {
    ...actual,
    buildSupervisedBrowserCommand: vi.fn(actual.buildSupervisedBrowserCommand),
  };
});

import { createBrowserSession, browserSessionLogDir } from "../src/session.js";
import { buildSupervisedBrowserCommand } from "../src/supervisor.js";
import { writeFakeChrome } from "./fakes.js";

// Generous: a full parallel `bun run test` run can starve these spawned
// processes of CPU for several seconds before they get scheduled at all.
const TEST_TIMEOUT_MS = 30_000;
const MARKER_WAIT_MS = 20_000;
const mockedBuildSupervisedBrowserCommand = vi.mocked(
  buildSupervisedBrowserCommand,
);

// Spawns the given browser binary as a plain (non-detached) child — so it
// shares this script's own process group, exactly like the real supervisor's
// child — then exits immediately without waiting for it or forwarding any
// signal, standing in for a supervisor that crashed right after spawning
// Chrome. Writes the "chrome.pid" marker itself, synchronously, from the
// `spawn()` return value, instead of relying on fake Chrome's own script (see
// fakes.ts) to schedule and self-report it: under a fully parallel `bun run
// test`, waiting on a second process to actually get CPU time to run its own
// startup code before this script exits was measurably flaky, whereas the
// pid is already known the instant `spawn()` returns.
const CRASHING_SUPERVISOR_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const [binary, ...args] = process.argv.slice(1);",
  "let profile = null;",
  "for (const a of args) {",
  '  if (a.startsWith("--user-data-dir=")) profile = a.slice("--user-data-dir=".length);',
  "}",
  'const pidFile = profile ? path.join(path.dirname(profile), "chrome.pid") : null;',
  'const child = spawn(binary, args, { stdio: "ignore" });',
  "if (pidFile && child.pid !== undefined) {",
  "  try {",
  "    fs.mkdirSync(path.dirname(pidFile), { recursive: true });",
  "    fs.writeFileSync(pidFile, String(child.pid));",
  "  } catch {}",
  "}",
  "process.exit(0);",
].join("\n");

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function setUpStalledFakeChrome(): Promise<EnvLike> {
  root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pickforge-lab-browser-pre-identity-"),
  );
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true });
  // "stall" never exits and never publishes a DevTools port on its own, so it
  // stays alive for the full identity-wait window like a real Chrome would,
  // and only our teardown code can end it.
  writeFakeChrome(binDir, "stall");
  return {
    ...process.env,
    HOME: home,
    PICKLAB_HOME: path.join(root, "pickforge-home"),
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

/**
 * Run `createBrowserSession` to its expected pre-identity rejection, then
 * assert the record and process-level cleanup semantics that must hold
 * either way: no retry was recorded (since no identity was ever captured to
 * retry against) and the surviving fake Chrome is confirmed dead.
 */
async function expectPreIdentityCleanupConfirmed(env: EnvLike): Promise<void> {
  await expect(
    createBrowserSession({
      projectDir: path.join(root!, "project"),
      registryEnv: env,
      env,
    }),
  ).rejects.toThrow(/could not be identified during startup/);

  const records = await listSessions(env);
  expect(records).toHaveLength(1);
  const record = records[0]!;
  expect(record.status).toBe("error");
  // Identity was never captured, so nothing was ever recorded to retry
  // against later; the only way this can be a true "cleanup complete" is if
  // the group was actually confirmed dead synchronously.
  expect(record.browser).toBeUndefined();
  expect(record.meta?.[REAPER_CLEANUP_PENDING_META_KEY]).toBeUndefined();

  const sessionDir = browserSessionLogDir(record.id, env);
  const pidFile = path.join(sessionDir, "chrome.pid");
  const pidDeadline = Date.now() + MARKER_WAIT_MS;
  while (!fs.existsSync(pidFile) && Date.now() < pidDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(fs.existsSync(pidFile)).toBe(true);
  const chromePid = Number(fs.readFileSync(pidFile, "utf8").trim());
  expect(Number.isSafeInteger(chromePid)).toBe(true);

  try {
    expect(isPidAlive(chromePid)).toBe(false);
  } finally {
    if (isPidAlive(chromePid)) {
      try {
        process.kill(chromePid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  await destroySessionRecord(record.id, env);
}

describe("pre-identity browser daemon cleanup", () => {
  it(
    "kills a live Chrome left behind when the supervisor's own identity never resolves",
    async () => {
      const env = await setUpStalledFakeChrome();
      // The fix: the whole process group (supervisor + Chrome) is killed and
      // confirmed empty before cleanup is reported complete. Before the fix,
      // only the supervisor was signaled directly, leaving Chrome running.
      await expectPreIdentityCleanupConfirmed(env);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "kills a surviving Chrome when the supervisor has already exited (crashed) before cleanup runs",
    async () => {
      const env = await setUpStalledFakeChrome();
      mockedBuildSupervisedBrowserCommand.mockImplementationOnce(
        (nodePath, binaryPath, browserArgs) => ({
          command: nodePath,
          args: ["-e", CRASHING_SUPERVISOR_SCRIPT, binaryPath, ...browserArgs],
        }),
      );
      // The fix's exited branch: `ownedDaemonExited` is already true by the
      // time `stopOwnedBrowserDaemon` runs (the stand-in supervisor exits
      // right after spawning Chrome), yet Chrome is still alive in the same
      // process group. Before the fix this branch returned cleanup-complete
      // unconditionally without ever signaling that surviving group.
      await expectPreIdentityCleanupConfirmed(env);
    },
    TEST_TIMEOUT_MS,
  );
});
