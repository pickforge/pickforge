import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

let forceStopFailure = false;

vi.mock("../src/emulator.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/emulator.js")>();
  return {
    ...actual,
    stopEmulator: vi.fn(async (opts: Parameters<typeof actual.stopEmulator>[0]) => {
      if (forceStopFailure) {
        return false;
      }
      return actual.stopEmulator(opts);
    }),
  };
});

import {
  REAPER_CLEANUP_PENDING_META_KEY,
  beginEvidenceRun,
  getSession,
  isPidAlive,
  reapDeadRunningSessions,
  type EnvLike,
} from "@pickforge/lab-core";
import {
  createAndroidSession,
  destroyAndroidSession,
  teardownAndroidSession,
} from "../src/index.js";

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
      '  devices) printf "List of devices attached\\nemulator-5554\\tdevice\\n" ;;',
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
      port: 5554,
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
