import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createSession,
  getSession,
  isPidAlive,
  updateSession,
  type EnvLike,
} from "@pickforge/lab-core";
import {
  androidSessionLogDir,
  consolePortLockPath,
  createAndroidSession,
  destroyAndroidSession,
  getAndroidSessionStatus,
  startEmulator,
} from "../src/index.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-android-sess-"));
const home = path.join(tmpRoot, "home");
const projectDir = path.join(tmpRoot, "project");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
const registryEnv: EnvLike = { ...process.env, PICKFORGE_HOME: home };

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

let sdkCounter = 0;

function makeFakeSdk(opts: { bootCompleted: string }): string {
  sdkCounter += 1;
  const sdk = path.join(tmpRoot, `sdk-${sdkCounter}`);
  writeExecutable(
    path.join(sdk, "emulator", "emulator"),
    "#!/bin/sh\nPATH=/usr/bin:/bin\nexec sleep 60\n",
  );
  writeExecutable(
    path.join(sdk, "platform-tools", "adb"),
    [
      "#!/bin/sh",
      'case "$*" in',
      `  *getprop*) echo ${opts.bootCompleted} ;;`,
      '  devices) printf "List of devices attached\\nemulator-5554\\tdevice\\n" ;;',
      '  *"emu kill"*) exit 0 ;;',
      "esac",
      "exit 0",
    ].join("\n"),
  );
  return sdk;
}

describe("createAndroidSession", () => {
  it(
    "boots the emulator, records the session, reports status, and destroys it",
    async () => {
      const sdk = makeFakeSdk({ bootCompleted: "1" });
      const session = await createAndroidSession({
        projectDir,
        registryEnv,
        sdk,
        port: 5554,
        env: { PATH: "" },
        bootPollIntervalMs: 20,
        bootTimeoutMs: 5_000,
      });
      try {
        expect(session.avdName).toBe("pickforge-avd");
        expect(session.serial).toBe("emulator-5554");
        expect(session.consolePort).toBe(5554);
        expect(isPidAlive(session.emulatorPid)).toBe(true);
        expect(session.logDir).toBe(androidSessionLogDir(session.id, registryEnv));
        expect(fs.existsSync(session.logPath)).toBe(true);

        const record = await getSession(session.id, registryEnv);
        expect(record?.status).toBe("running");
        expect(record?.android).toEqual({
          avdName: "pickforge-avd",
          serial: "emulator-5554",
          emulatorPid: session.emulatorPid,
          consolePort: 5554,
        });

        const status = await getAndroidSessionStatus(session.id, registryEnv, {
          sdk,
          env: { PATH: "" },
        });
        expect(status.emulatorAlive).toBe(true);
        expect(status.deviceState).toBe("device");
      } finally {
        await destroyAndroidSession(session.id, registryEnv, {
          sdk,
          env: { PATH: "" },
          timeoutMs: 300,
        });
      }
      expect(isPidAlive(session.emulatorPid)).toBe(false);
      expect(await getSession(session.id, registryEnv)).toBeUndefined();
    },
    20_000,
  );

  it("marks the session as error and stops the emulator when boot times out", async () => {
    const sdk = makeFakeSdk({ bootCompleted: "0" });
    const isolatedHome = path.join(tmpRoot, "home-boot-timeout");
    const isolatedEnv: EnvLike = { ...process.env, PICKFORGE_HOME: isolatedHome };
    await expect(
      createAndroidSession({
        projectDir,
        registryEnv: isolatedEnv,
        sdk,
        port: 5556,
        env: { PATH: "" },
        bootPollIntervalMs: 20,
        bootTimeoutMs: 200,
      }),
    ).rejects.toThrow(/did not finish booting/);

    const entries = fs
      .readdirSync(path.join(isolatedHome, "sessions"))
      .filter((entry) => entry.endsWith(".json"));
    expect(entries).toHaveLength(1);
    const id = (entries[0] as string).slice(0, -".json".length);
    const record = await getSession(id, isolatedEnv);
    expect(record?.status).toBe("error");
    expect(record?.android?.avdName).toBe("pickforge-avd");
  });

  it("fails actionably when the emulator binary is missing", async () => {
    const sdk = path.join(tmpRoot, "sdk-missing");
    fs.mkdirSync(sdk, { recursive: true });
    await expect(
      createAndroidSession({
        projectDir,
        registryEnv,
        sdk,
        env: { PATH: "" },
      }),
    ).rejects.toThrow(/emulator binary not found[\s\S]*sdkmanager "emulator"/);
  });

  it("removes stale running records before creating a new session", async () => {
    const sdk = makeFakeSdk({ bootCompleted: "1" });
    const isolatedHome = path.join(tmpRoot, "home-reap-android");
    const isolatedEnv: EnvLike = {
      ...process.env,
      PICKFORGE_HOME: isolatedHome,
    };
    const stale = await createSession(
      { type: "android", projectDir, android: { avdName: "old-avd" } },
      isolatedEnv,
    );
    await updateSession(
      stale.id,
      {
        status: "running",
        android: {
          avdName: "old-avd",
          serial: "emulator-5590",
          emulatorPid: 4_194_304,
          consolePort: 5590,
        },
      },
      isolatedEnv,
    );

    const session = await createAndroidSession({
      projectDir,
      registryEnv: isolatedEnv,
      sdk,
      port: 5560,
      env: { PATH: "" },
      bootPollIntervalMs: 20,
      bootTimeoutMs: 5_000,
    });
    try {
      expect(await getSession(stale.id, isolatedEnv)).toBeUndefined();
      expect(await getSession(session.id, isolatedEnv)).toBeDefined();
    } finally {
      await destroyAndroidSession(session.id, isolatedEnv, {
        sdk,
        env: { PATH: "" },
        timeoutMs: 300,
      });
    }
  });
});

describe("startEmulator failure detail", () => {
  it("includes the daemon log path when boot never completes", async () => {
    const sdk = makeFakeSdk({ bootCompleted: "0" });
    const failureEnv: EnvLike = {
      PICKFORGE_HOME: path.join(tmpRoot, "home-emu-failure"),
    };
    await expect(
      startEmulator({
        avdName: "pickforge-avd",
        sdk,
        port: 5558,
        logDir: path.join(tmpRoot, "emu-logs"),
        env: { PATH: "" },
        registryEnv: failureEnv,
        bootTimeoutMs: 200,
        bootPollIntervalMs: 20,
      }),
    ).rejects.toThrow(/emulator-5558 did not finish booting[\s\S]*emulator\.log/);
    expect(fs.existsSync(consolePortLockPath(5558, failureEnv))).toBe(false);
  });
});

describe("destroyAndroidSession", () => {
  it("throws for unknown sessions", async () => {
    await expect(
      destroyAndroidSession("andr-ffffffff", registryEnv),
    ).rejects.toThrow(/not found/);
  });
});

describe("getAndroidSessionStatus", () => {
  it("throws for unknown sessions", async () => {
    await expect(
      getAndroidSessionStatus("andr-ffffffff", registryEnv),
    ).rejects.toThrow(/not found/);
  });
});
