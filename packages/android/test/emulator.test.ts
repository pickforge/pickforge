import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCommand, type EnvLike } from "@pickforge/lab-core";
import {
  consolePortLockPath,
  releaseConsolePort,
  startEmulator,
  stopEmulator,
  tryReserveConsolePort,
  type EmulatorHandle,
} from "../src/index.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-android-emu-"));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

let sdkCounter = 0;

function makeFakeSdk(adbScript: string): string {
  sdkCounter += 1;
  const sdk = path.join(tmpRoot, `sdk-${sdkCounter}`);
  writeExecutable(
    path.join(sdk, "emulator", "emulator"),
    "#!/bin/sh\nPATH=/usr/bin:/bin\nexec sleep 60\n",
  );
  writeExecutable(
    path.join(sdk, "platform-tools", "adb"),
    `#!/bin/sh\nPATH="/usr/bin:/bin:$PATH"\n${adbScript}\n`,
  );
  return sdk;
}

const BOOTING_ADB_SCRIPT = [
  'case "$*" in',
  "  *getprop*) echo 1 ;;",
  '  devices) printf "List of devices attached\\nemulator-5554\\tdevice\\n" ;;',
  '  *"emu kill"*) exit 0 ;;',
  "esac",
  "exit 0",
].join("\n");

let homeCounter = 0;

function makeRegistryEnv(): EnvLike {
  homeCounter += 1;
  const home = path.join(tmpRoot, `home-${homeCounter}`);
  fs.mkdirSync(home, { recursive: true });
  return { PICKFORGE_HOME: home };
}

async function deadPid(): Promise<number> {
  const result = await runCommand(process.execPath, [
    "-e",
    "console.log(process.pid)",
  ]);
  return Number(result.stdout.trim());
}

describe("console port reservation registry", () => {
  it("gives two concurrent allocations different ports", async () => {
    const sdk = makeFakeSdk(BOOTING_ADB_SCRIPT);
    const registryEnv = makeRegistryEnv();
    const startOpts = {
      avdName: "pickforge-avd",
      sdk,
      env: { PATH: "" },
      registryEnv,
      bootTimeoutMs: 5_000,
      bootPollIntervalMs: 20,
    };
    let first: EmulatorHandle | undefined;
    let second: EmulatorHandle | undefined;
    try {
      [first, second] = await Promise.all([
        startEmulator({ ...startOpts, logDir: path.join(tmpRoot, "emu-a") }),
        startEmulator({ ...startOpts, logDir: path.join(tmpRoot, "emu-b") }),
      ]);
      expect(first.consolePort).not.toBe(second.consolePort);
      expect([first.consolePort, second.consolePort].sort((a, b) => a - b)).toEqual(
        [5556, 5558],
      );
      expect(fs.existsSync(consolePortLockPath(5556, registryEnv))).toBe(true);
      expect(fs.existsSync(consolePortLockPath(5558, registryEnv))).toBe(true);
    } finally {
      for (const handle of [first, second]) {
        if (handle !== undefined) {
          await stopEmulator({
            serial: handle.serial,
            pid: handle.pid,
            sdk,
            env: { PATH: "" },
            registryEnv,
            timeoutMs: 300,
          });
        }
      }
    }
    expect(fs.existsSync(consolePortLockPath(5556, registryEnv))).toBe(false);
    expect(fs.existsSync(consolePortLockPath(5558, registryEnv))).toBe(false);
  }, 20_000);

  it("skips a live reservation even when adb does not list the port", async () => {
    const sdk = makeFakeSdk(BOOTING_ADB_SCRIPT);
    const registryEnv = makeRegistryEnv();
    expect(tryReserveConsolePort(5556, registryEnv)).toBe(true);
    try {
      const handle = await startEmulator({
        avdName: "pickforge-avd",
        sdk,
        logDir: path.join(tmpRoot, "emu-skip"),
        env: { PATH: "" },
        registryEnv,
        bootTimeoutMs: 5_000,
        bootPollIntervalMs: 20,
      });
      try {
        expect(handle.consolePort).toBe(5558);
      } finally {
        await stopEmulator({
          serial: handle.serial,
          pid: handle.pid,
          sdk,
          env: { PATH: "" },
          registryEnv,
          timeoutMs: 300,
        });
      }
    } finally {
      releaseConsolePort(5556, registryEnv);
    }
  }, 20_000);

  it("refuses to start on an explicitly requested port that is reserved", async () => {
    const sdk = makeFakeSdk(BOOTING_ADB_SCRIPT);
    const registryEnv = makeRegistryEnv();
    expect(tryReserveConsolePort(5560, registryEnv)).toBe(true);
    try {
      await expect(
        startEmulator({
          avdName: "pickforge-avd",
          sdk,
          port: 5560,
          logDir: path.join(tmpRoot, "emu-conflict"),
          env: { PATH: "" },
          registryEnv,
          bootTimeoutMs: 5_000,
          bootPollIntervalMs: 20,
        }),
      ).rejects.toThrow(/already reserved/);
    } finally {
      releaseConsolePort(5560, registryEnv);
    }
  });

  it("accepts 5554 when explicitly requested", async () => {
    const sdk = makeFakeSdk(BOOTING_ADB_SCRIPT);
    const registryEnv = makeRegistryEnv();
    const handle = await startEmulator({
      avdName: "pickforge-avd",
      sdk,
      port: 5554,
      logDir: path.join(tmpRoot, "emu-explicit-5554"),
      env: { PATH: "" },
      registryEnv,
      bootTimeoutMs: 5_000,
      bootPollIntervalMs: 20,
    });
    try {
      expect(handle.serial).toBe("emulator-5554");
      expect(handle.consolePort).toBe(5554);
      expect(fs.existsSync(consolePortLockPath(5554, registryEnv))).toBe(true);
    } finally {
      await stopEmulator({
        serial: handle.serial,
        pid: handle.pid,
        sdk,
        env: { PATH: "" },
        registryEnv,
        timeoutMs: 300,
      });
    }
    expect(fs.existsSync(consolePortLockPath(5554, registryEnv))).toBe(false);
  }, 20_000);

  it("reclaims a stale reservation owned by a dead process", async () => {
    const registryEnv = makeRegistryEnv();
    const stale = await deadPid();
    expect(tryReserveConsolePort(5562, registryEnv, stale)).toBe(true);
    expect(tryReserveConsolePort(5562, registryEnv)).toBe(true);
    expect(
      fs.readFileSync(consolePortLockPath(5562, registryEnv), "utf8").trim(),
    ).toBe(String(process.pid));
    expect(tryReserveConsolePort(5562, registryEnv)).toBe(false);
    releaseConsolePort(5562, registryEnv);
  });

  it("propagates an adb devices failure instead of defaulting to 5554", async () => {
    const sdk = makeFakeSdk('case "$*" in devices) exit 1 ;; esac\nexit 0');
    const registryEnv = makeRegistryEnv();
    await expect(
      startEmulator({
        avdName: "pickforge-avd",
        sdk,
        logDir: path.join(tmpRoot, "emu-listfail"),
        env: { PATH: "" },
        registryEnv,
        bootTimeoutMs: 5_000,
        bootPollIntervalMs: 20,
      }),
    ).rejects.toThrow(/Failed to list adb devices/);
    expect(fs.existsSync(consolePortLockPath(5554, registryEnv))).toBe(false);
  });
});

describe("sdk auto-detection in the execution layer", () => {
  it("starts the emulator from an sdk detected via ANDROID_HOME with no PATH tools", async () => {
    const sdk = makeFakeSdk(BOOTING_ADB_SCRIPT);
    const registryEnv = makeRegistryEnv();
    const handle = await startEmulator({
      avdName: "pickforge-avd",
      port: 5564,
      logDir: path.join(tmpRoot, "emu-detected"),
      env: { ANDROID_HOME: sdk, PATH: "" },
      registryEnv,
      bootTimeoutMs: 5_000,
      bootPollIntervalMs: 20,
    });
    try {
      expect(handle.serial).toBe("emulator-5564");
    } finally {
      const stopped = await stopEmulator({
        serial: handle.serial,
        pid: handle.pid,
        env: { ANDROID_HOME: sdk, PATH: "" },
        registryEnv,
        timeoutMs: 300,
      });
      expect(stopped).toBe(true);
    }
    expect(fs.existsSync(consolePortLockPath(5564, registryEnv))).toBe(false);
  }, 20_000);
});

describe("stopEmulator confirmation", () => {
  it("does not send adb kill when the recorded pid is already dead", async () => {
    const marker = path.join(tmpRoot, `adb-kill-${sdkCounter + 1}.txt`);
    const sdk = makeFakeSdk(`printf '%s\\n' "$*" >> ${JSON.stringify(marker)}`);
    const registryEnv = makeRegistryEnv();
    const pid = await deadPid();
    expect(tryReserveConsolePort(5568, registryEnv, pid)).toBe(true);

    expect(
      await stopEmulator({
        serial: "emulator-5568",
        pid,
        sdk,
        env: { PATH: "" },
        registryEnv,
        timeoutMs: 300,
      }),
    ).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(consolePortLockPath(5568, registryEnv))).toBe(false);
  });

  it("returns false when adb devices cannot confirm the shutdown", async () => {
    const sdk = makeFakeSdk(
      [
        'case "$*" in',
        '  *"emu kill"*) exit 0 ;;',
        '  devices) echo "adb server is broken" >&2; exit 1 ;;',
        "esac",
        "exit 0",
      ].join("\n"),
    );
    const registryEnv = makeRegistryEnv();
    const stopped = await stopEmulator({
      serial: "emulator-5566",
      sdk,
      env: { PATH: "" },
      registryEnv,
      timeoutMs: 300,
    });
    expect(stopped).toBe(false);
  });
});
