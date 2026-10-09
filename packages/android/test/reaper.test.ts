import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

let forceStopFailure = false;
let beforeStop: (() => Promise<void>) | undefined;

vi.mock("../src/emulator.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/emulator.js")>();
  return {
    ...actual,
    stopEmulator: vi.fn(async (opts: Parameters<typeof actual.stopEmulator>[0]) => {
      if (forceStopFailure) {
        return false;
      }
      await beforeStop?.();
      return actual.stopEmulator(opts);
    }),
  };
});

import {
  REAPER_CLEANUP_PENDING_META_KEY,
  beginEvidenceRun,
  createSession,
  destroySessionRecord,
  getSession,
  isPidAlive,
  reapDeadRunningSessions,
  sessionDataDir,
  teardownLocalSession,
  withSessionVncLock,
  type EnvLike,
} from "@pickforge/lab-core";
import {
  createAndroidSession,
  destroyAndroidSession,
  teardownAndroidSession,
} from "../src/index.js";
import { stopEmulator } from "../src/emulator.js";
import { holdTestPortLock } from "./port-lock.js";

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "pickforge-lab-android-reaper-"),
);
const home = path.join(tmpRoot, "home");
const projectDir = path.join(tmpRoot, "project");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
const registryEnv: EnvLike = { ...process.env, PICKFORGE_HOME: home };

/** A fake AVD home that satisfies the pre-flight "AVD exists" check. */
const avdHome = path.join(tmpRoot, "avd");
fs.mkdirSync(avdHome, { recursive: true });
fs.writeFileSync(path.join(avdHome, "pickforge-avd.ini"), "avd.ini.encoding=UTF-8\n");
const toolEnv: EnvLike = { PATH: "", ANDROID_AVD_HOME: avdHome };

/**
 * A test-private console port, clear of the 5554-5562 ports a real emulator
 * on this machine would hold and of the windows the other android tests use.
 */
const BASE = 5648;

// The window is host-global; see port-lock.ts (#293).
holdTestPortLock("reaper");

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function makeFakeSdk(): string {
  const sdk = path.join(tmpRoot, "sdk");
  writeExecutable(
    path.join(sdk, "emulator", "emulator"),
    "#!/bin/sh\nPATH=/usr/bin:/bin\nexec sleep 60\n",
  );
  writeExecutable(
    path.join(sdk, "platform-tools", "adb"),
    [
      "#!/bin/sh",
      'case "$*" in',
      "  *getprop*) echo 1 ;;",
      `  devices) printf "List of devices attached\\nemulator-${BASE}\\tdevice\\n" ;;`,
      '  *"emu kill"*) exit 0 ;;',
      "esac",
      "exit 0",
    ].join("\n"),
  );
  return sdk;
}

describe("android reaper tracking", () => {
  it("keeps a leaked android session reaper-trackable after a failed destroy", async () => {
    const sdk = makeFakeSdk();
    const session = await createAndroidSession({
      projectDir,
      registryEnv,
      sdk,
      port: BASE,
      env: toolEnv,
      bootPollIntervalMs: 20,
      bootTimeoutMs: 5_000,
    });

    const { run } = await beginEvidenceRun(
      projectDir,
      session.id,
      {},
      registryEnv,
    );

    forceStopFailure = true;
    try {
      await expect(
        destroyAndroidSession(session.id, registryEnv, {
          sdk,
          env: toolEnv,
          timeoutMs: 300,
        }),
      ).rejects.toThrow(/Failed to stop emulator/);

      const leaked = await getSession(session.id, registryEnv);
      expect(leaked?.status).toBe("error");
      expect(leaked?.meta?.[REAPER_CLEANUP_PENDING_META_KEY]).toBe(true);
      expect(leaked?.android?.emulatorPid).toBe(session.emulatorPid);
      expect(isPidAlive(session.emulatorPid)).toBe(true);
    } finally {
      forceStopFailure = false;
    }

    const reaped = await reapDeadRunningSessions(registryEnv, {
      android: {
        teardown: (id, finalize) =>
          teardownAndroidSession(
            id,
            registryEnv,
            { sdk, env: toolEnv, timeoutMs: 300 },
            finalize,
          ),
      },
    });
    expect(reaped.map((record) => record.id)).toContain(session.id);
    expect(await getSession(session.id, registryEnv)).toBeUndefined();
    expect(isPidAlive(session.emulatorPid)).toBe(false);
    expect(
      JSON.parse(
        await fs.promises.readFile(path.join(run.dir, "manifest.json"), "utf8"),
      ),
    ).toMatchObject({ status: "failed" });
  }, 20_000);
});

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

describe("android-only teardown lock (#321)", () => {
  it("serializes overlapping destroys of one session", async () => {
    const sdk = makeFakeSdk();
    const session = await createAndroidSession({
      projectDir,
      registryEnv,
      sdk,
      port: BASE + 2,
      env: toolEnv,
      bootPollIntervalMs: 20,
      bootTimeoutMs: 5_000,
    });
    const sessions = path.join(home, "sessions");
    const waiters = () =>
      fs.readdirSync(sessions).filter((name) => name.startsWith(`${session.id}.ensure-vnc.lock.`)).length;
    vi.mocked(stopEmulator).mockClear();
    let stops = 0;
    // Hold the first stop until the second destroy waits on the lock or,
    // without a lock, reaches its own stop.
    beforeStop = async () => {
      stops += 1;
      if (stops === 1) await until(() => stops > 1 || waiters() > 1, 2_000);
    };
    try {
      const destroy = () =>
        destroyAndroidSession(session.id, registryEnv, { sdk, env: toolEnv, timeoutMs: 300 });
      const results = await Promise.allSettled([destroy(), destroy()]);
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = results.find((result) => result.status === "rejected");
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      expect(((rejected as PromiseRejectedResult).reason as Error).message).toBe(
        `Android session not found: ${session.id}`,
      );
    } finally {
      beforeStop = undefined;
    }
    expect(stopEmulator).toHaveBeenCalledTimes(1);
    expect(await getSession(session.id, registryEnv)).toBeUndefined();
    expect(isPidAlive(session.emulatorPid)).toBe(false);
    const logDir = sessionDataDir(session.id, registryEnv);
    expect(fs.readdirSync(logDir).filter((name) => name.includes("stopped.json"))).toEqual(["stopped.json"]);
    expect(fs.readdirSync(sessions).filter((name) => name.startsWith(`${session.id}.ensure-vnc.lock`))).toEqual([]);
  }, 20_000);

  it("runs the duo Android leg inside the desktop lock without taking it again", async () => {
    const record = await createSession({
      type: "desktop+android",
      projectDir,
      status: "running",
      desktop: { display: ":2995" },
      android: { avdName: "fake" },
    }, registryEnv);
    const runtime = {
      desktop: {
        teardown: (id: string, finalize: () => Promise<void>) =>
          withSessionVncLock(id, registryEnv, finalize),
      },
      android: {
        teardown: (id: string, finalize: () => Promise<void>) =>
          teardownAndroidSession(id, registryEnv, {}, finalize),
      },
    };
    await teardownLocalSession(record, runtime, () => destroySessionRecord(record.id, registryEnv));
    expect(await getSession(record.id, registryEnv)).toBeUndefined();
  }, 5_000);
  it("refuses a non-Android record without finalizing it", async () => {
    const record = await createSession({ type: "browser", projectDir, status: "running" }, registryEnv);
    const finalize = vi.fn(async () => {});
    await expect(teardownAndroidSession(record.id, registryEnv, {}, finalize)).rejects.toThrow(
      `Session ${record.id} is not an Android session`,
    );
    expect(finalize).not.toHaveBeenCalled();
    expect(await getSession(record.id, registryEnv)).toBeDefined();
    await destroySessionRecord(record.id, registryEnv);
  });
});
