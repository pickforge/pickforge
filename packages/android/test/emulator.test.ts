import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCommand, type EnvLike } from "@pickforge/lab-core";
import {
  AVD_SHARING_POLICY,
  avdLockPath,
  consolePortLockPath,
  DEVICE_STATE_UNKNOWN,
  EmulatorStartError,
  releaseConsolePort,
  startEmulator,
  stopEmulator,
  tryReserveConsolePort,
  waitForBoot,
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

/** A fake AVD home that satisfies the pre-flight "AVD exists" check. */
const avdHome = path.join(tmpRoot, "avd");
fs.mkdirSync(path.join(avdHome, "pickforge-avd.avd"), { recursive: true });
fs.writeFileSync(
  path.join(avdHome, "pickforge-avd.ini"),
  `avd.ini.encoding=UTF-8\npath=${path.join(avdHome, "pickforge-avd.avd")}\n`,
);
const toolEnv: EnvLike = { PATH: "", ANDROID_AVD_HOME: avdHome };

let sdkCounter = 0;

const SLEEPING_EMULATOR = "#!/bin/sh\nPATH=/usr/bin:/bin\nexec sleep 60\n";

function makeFakeSdk(adbScript: string, emulatorScript = SLEEPING_EMULATOR): string {
  sdkCounter += 1;
  const sdk = path.join(tmpRoot, `sdk-${sdkCounter}`);
  writeExecutable(path.join(sdk, "emulator", "emulator"), emulatorScript);
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

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
      resolve(server),
    );
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function stop(handle: EmulatorHandle, sdk: string, registryEnv: EnvLike) {
  await stopEmulator({
    serial: handle.serial,
    pid: handle.pid,
    sdk,
    env: toolEnv,
    registryEnv,
    timeoutMs: 300,
  });
}

async function startFailure(
  promise: Promise<unknown>,
): Promise<EmulatorStartError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EmulatorStartError);
    return error as EmulatorStartError;
  }
  throw new Error("expected startEmulator to reject");
}

describe("console port reservation registry", () => {
  it("gives two concurrent allocations different ports", async () => {
    const sdk = makeFakeSdk(BOOTING_ADB_SCRIPT);
    const registryEnv = makeRegistryEnv();
    const startOpts = {
      avdName: "pickforge-avd",
      sdk,
      env: toolEnv,
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
          await stop(handle, sdk, registryEnv);
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
        env: toolEnv,
        registryEnv,
        bootTimeoutMs: 5_000,
        bootPollIntervalMs: 20,
      });
      try {
        expect(handle.consolePort).toBe(5558);
      } finally {
        await stop(handle, sdk, registryEnv);
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
          env: toolEnv,
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
      env: toolEnv,
      registryEnv,
      bootTimeoutMs: 5_000,
      bootPollIntervalMs: 20,
    });
    try {
      expect(handle.serial).toBe("emulator-5554");
      expect(handle.consolePort).toBe(5554);
      expect(fs.existsSync(consolePortLockPath(5554, registryEnv))).toBe(true);
    } finally {
      await stop(handle, sdk, registryEnv);
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
        env: toolEnv,
        registryEnv,
        bootTimeoutMs: 5_000,
        bootPollIntervalMs: 20,
      }),
    ).rejects.toThrow(/Failed to list adb devices/);
    expect(fs.existsSync(consolePortLockPath(5554, registryEnv))).toBe(false);
  });
});

describe("port collisions outside the reservation registry", () => {
  it("skips an auto-allocated port that another process has bound", async () => {
    const sdk = makeFakeSdk(BOOTING_ADB_SCRIPT);
    const registryEnv = makeRegistryEnv();
    const progress: string[] = [];
    const server = await listenOn(5556);
    try {
      const handle = await startEmulator({
        avdName: "pickforge-avd",
        sdk,
        logDir: path.join(tmpRoot, "emu-tcp-skip"),
        env: toolEnv,
        registryEnv,
        bootTimeoutMs: 5_000,
        bootPollIntervalMs: 20,
        onProgress: (message) => progress.push(message),
      });
      try {
        expect(handle.consolePort).toBe(5558);
        expect(progress.join("\n")).toMatch(/console port 5556 is bound/);
      } finally {
        await stop(handle, sdk, registryEnv);
      }
    } finally {
      await closeServer(server);
    }
    expect(fs.existsSync(consolePortLockPath(5556, registryEnv))).toBe(false);
  }, 20_000);

  it("fails distinctly before spawning when an explicit port is bound", async () => {
    const marker = path.join(tmpRoot, "spawned-explicit-bound.txt");
    const sdk = makeFakeSdk(
      BOOTING_ADB_SCRIPT,
      `#!/bin/sh\nPATH=/usr/bin:/bin\n: > ${JSON.stringify(marker)}\nexec sleep 60\n`,
    );
    const registryEnv = makeRegistryEnv();
    const server = await listenOn(5570);
    try {
      const error = await startFailure(
        startEmulator({
          avdName: "pickforge-avd",
          sdk,
          port: 5570,
          logDir: path.join(tmpRoot, "emu-tcp-explicit"),
          env: toolEnv,
          registryEnv,
          bootTimeoutMs: 5_000,
          bootPollIntervalMs: 20,
        }),
      );
      expect(error.kind).toBe("port-collision");
      expect(error.message).toMatch(/Console port 5570 or adb port 5571[^\n]*\[port-collision\]/);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      await closeServer(server);
    }
    expect(fs.existsSync(consolePortLockPath(5570, registryEnv))).toBe(false);
  });

  it("retries on a fresh port when the emulator itself reports a collision", async () => {
    const attempts = path.join(tmpRoot, "collision-attempts.txt");
    const sdk = makeFakeSdk(
      BOOTING_ADB_SCRIPT,
      [
        "#!/bin/sh",
        "PATH=/usr/bin:/bin",
        'port=""',
        'while [ $# -gt 0 ]; do [ "$1" = "-port" ] && port="$2"; shift; done',
        `echo "$port" >> ${JSON.stringify(attempts)}`,
        'if [ "$port" = "5556" ]; then',
        '  echo "ERROR        | console port 5556 is already in use"',
        "  exit 1",
        "fi",
        "exec sleep 60",
        "",
      ].join("\n"),
    );
    const registryEnv = makeRegistryEnv();
    const progress: string[] = [];
    const handle = await startEmulator({
      avdName: "pickforge-avd",
      sdk,
      logDir: path.join(tmpRoot, "emu-collision-retry"),
      env: toolEnv,
      registryEnv,
      bootTimeoutMs: 5_000,
      bootPollIntervalMs: 20,
      onProgress: (message) => progress.push(message),
    });
    try {
      expect(handle.consolePort).toBe(5558);
      expect(fs.readFileSync(attempts, "utf8").trim().split("\n")).toEqual([
        "5556",
        "5558",
      ]);
      expect(progress.join("\n")).toMatch(/console port 5556 was taken[^\n]*retrying/);
    } finally {
      await stop(handle, sdk, registryEnv);
    }
    expect(fs.existsSync(consolePortLockPath(5556, registryEnv))).toBe(false);
  }, 20_000);

  it("gives up after the bounded retries and keeps the collision diagnosis", async () => {
    const sdk = makeFakeSdk(
      BOOTING_ADB_SCRIPT,
      '#!/bin/sh\necho "ERROR        | address already in use"\nexit 1\n',
    );
    const registryEnv = makeRegistryEnv();
    const error = await startFailure(
      startEmulator({
        avdName: "pickforge-avd",
        sdk,
        logDir: path.join(tmpRoot, "emu-collision-giveup"),
        env: toolEnv,
        registryEnv,
        bootTimeoutMs: 5_000,
        bootPollIntervalMs: 20,
      }),
    );
    expect(error.kind).toBe("port-collision");
    expect(error.diagnostics.consolePort).toBe(5560);
    for (const port of [5556, 5558, 5560]) {
      expect(fs.existsSync(consolePortLockPath(port, registryEnv))).toBe(false);
    }
  }, 20_000);
});

describe("AVD pre-flight checks", () => {
  it("fails before spawning when the AVD is not in the emulator's AVD home", async () => {
    const marker = path.join(tmpRoot, "spawned-missing-avd.txt");
    const sdk = makeFakeSdk(
      BOOTING_ADB_SCRIPT,
      `#!/bin/sh\nPATH=/usr/bin:/bin\n: > ${JSON.stringify(marker)}\nexec sleep 60\n`,
    );
    const registryEnv = makeRegistryEnv();
    const error = await startFailure(
      startEmulator({
        avdName: "absent-avd",
        sdk,
        logDir: path.join(tmpRoot, "emu-missing-avd"),
        env: toolEnv,
        registryEnv,
      }),
    );
    expect(error.kind).toBe("avd-missing");
    expect(error.message).toContain(path.join(avdHome, "absent-avd.ini"));
    expect(error.message).toContain(`available AVDs in ${avdHome}: pickforge-avd`);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("refuses a writable start while a live emulator holds the AVD lock", async () => {
    const marker = path.join(tmpRoot, "spawned-locked-avd.txt");
    const sdk = makeFakeSdk(
      BOOTING_ADB_SCRIPT,
      `#!/bin/sh\nPATH=/usr/bin:/bin\n: > ${JSON.stringify(marker)}\nexec sleep 60\n`,
    );
    const registryEnv = makeRegistryEnv();
    // A live process whose argv[0] reads as an emulator, like the real lock owner.
    const holder: ChildProcess = spawn("sleep", ["60"], {
      argv0: "emulator",
      stdio: "ignore",
    });
    await new Promise((resolve) => holder.once("spawn", resolve));
    const lockPath = avdLockPath("pickforge-avd", toolEnv);
    fs.writeFileSync(lockPath, `${holder.pid}\0`);
    try {
      const error = await startFailure(
        startEmulator({
          avdName: "pickforge-avd",
          sdk,
          logDir: path.join(tmpRoot, "emu-locked-avd"),
          env: toolEnv,
          registryEnv,
        }),
      );
      expect(error.kind).toBe("avd-in-use");
      expect(error.message).toContain(`writable emulator pid ${holder.pid}`);
      expect(error.message).toContain("--read-only");
      // The refusal is stated as Pickforge's policy, not as an emulator rule.
      expect(error.message).toContain(AVD_SHARING_POLICY);
      expect(error.message).not.toMatch(/the emulator only shares/);
      expect(fs.existsSync(marker)).toBe(false);

      // Pickforge refuses a read-only instance next to a writable one too.
      const readOnlyError = await startFailure(
        startEmulator({
          avdName: "pickforge-avd",
          sdk,
          readOnly: true,
          logDir: path.join(tmpRoot, "emu-locked-avd-ro"),
          env: toolEnv,
          registryEnv,
        }),
      );
      expect(readOnlyError.kind).toBe("avd-in-use");
      expect(readOnlyError.message).toContain(AVD_SHARING_POLICY);
      expect(readOnlyError.message).not.toContain("with --read-only");
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(lockPath, { force: true });
      holder.kill("SIGKILL");
    }

    // Without a writable holder, read-only instances share the AVD.
    const shared = await startEmulator({
      avdName: "pickforge-avd",
      sdk,
      readOnly: true,
      logDir: path.join(tmpRoot, "emu-shared-ro"),
      env: toolEnv,
      registryEnv,
      bootTimeoutMs: 5_000,
      bootPollIntervalMs: 20,
    });
    try {
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      await stop(shared, sdk, registryEnv);
    }
  }, 20_000);

  it("treats a lock whose pid is not an emulator as stale", async () => {
    const sdk = makeFakeSdk(BOOTING_ADB_SCRIPT);
    const registryEnv = makeRegistryEnv();
    const lockPath = avdLockPath("pickforge-avd", toolEnv);
    // This test runner is alive but is not an emulator.
    fs.writeFileSync(lockPath, `${process.pid}\n`);
    try {
      const handle = await startEmulator({
        avdName: "pickforge-avd",
        sdk,
        port: 5572,
        logDir: path.join(tmpRoot, "emu-stale-lock"),
        env: toolEnv,
        registryEnv,
        bootTimeoutMs: 5_000,
        bootPollIntervalMs: 20,
      });
      await stop(handle, sdk, registryEnv);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  }, 20_000);
});

describe("start failure diagnostics", () => {
  it("classifies an early exit from the log and keeps the tail after the log is gone", async () => {
    const sdk = makeFakeSdk(
      BOOTING_ADB_SCRIPT,
      [
        "#!/bin/sh",
        'echo "INFO         | Android emulator version 36.5.10.0"',
        'echo "ERROR        | Unknown AVD name [pickforge-avd], use -list-avds to see valid list."',
        "exit 1",
        "",
      ].join("\n"),
    );
    const registryEnv = makeRegistryEnv();
    const logDir = path.join(tmpRoot, "emu-unknown-avd");
    const error = await startFailure(
      startEmulator({
        avdName: "pickforge-avd",
        sdk,
        port: 5574,
        logDir,
        env: toolEnv,
        registryEnv,
        bootTimeoutMs: 5_000,
        bootPollIntervalMs: 20,
      }),
    );
    expect(error.kind).toBe("avd-missing");
    expect(error.message).toMatch(
      /exited before finishing boot \[avd-missing\];[^\n]*ANDROID_AVD_HOME[^\n]*check the log at .*emulator\.log/,
    );
    expect(error.message).toContain("--- emulator log tail (last 2 lines) ---");
    expect(error.message).toContain("Unknown AVD name [pickforge-avd]");
    fs.rmSync(logDir, { recursive: true, force: true });
    expect(error.diagnostics.logTail).toEqual([
      "INFO         | Android emulator version 36.5.10.0",
      "ERROR        | Unknown AVD name [pickforge-avd], use -list-avds to see valid list.",
    ]);
    expect(fs.existsSync(consolePortLockPath(5574, registryEnv))).toBe(false);
  });

  it("names the adb device state when boot times out", async () => {
    const sdk = makeFakeSdk(
      [
        'case "$*" in',
        "  *getprop*) echo 0 ;;",
        '  devices) printf "List of devices attached\\nemulator-5576\\toffline\\n" ;;',
        "esac",
        "exit 0",
      ].join("\n"),
    );
    const registryEnv = makeRegistryEnv();
    const error = await startFailure(
      startEmulator({
        avdName: "pickforge-avd",
        sdk,
        port: 5576,
        logDir: path.join(tmpRoot, "emu-offline"),
        env: toolEnv,
        registryEnv,
        bootTimeoutMs: 200,
        bootPollIntervalMs: 20,
      }),
    );
    expect(error.kind).toBe("boot-timeout");
    expect(error.diagnostics.deviceState).toBe("offline");
    expect(error.message).toMatch(
      /did not finish booting within 200ms \[boot-timeout\]; adb state: offline; adb listed the device but it stayed offline/,
    );
  });

  it("reports the device as missing when adb never lists it", async () => {
    const sdk = makeFakeSdk(
      [
        'case "$*" in',
        "  *getprop*) echo 0 ;;",
        '  devices) printf "List of devices attached\\n" ;;',
        "esac",
        "exit 0",
      ].join("\n"),
    );
    const registryEnv = makeRegistryEnv();
    const error = await startFailure(
      startEmulator({
        avdName: "pickforge-avd",
        sdk,
        port: 5578,
        logDir: path.join(tmpRoot, "emu-never-listed"),
        env: toolEnv,
        registryEnv,
        bootTimeoutMs: 200,
        bootPollIntervalMs: 20,
      }),
    );
    expect(error.diagnostics.deviceState).toBe("missing");
    expect(error.message).toContain("adb never listed the device");
  });

  it("keeps the typed diagnosis, log path, and tail when the adb probe itself cannot run", async () => {
    // adb vanishes (or stops being executable) while the emulator is booting:
    // the boot probe must not surface as a bare spawn error that loses the
    // kind, the log path, and the redacted tail.
    const logPath = path.join(tmpRoot, "probe-cannot-run.log");
    fs.writeFileSync(
      logPath,
      "INFO         | Android emulator version 36.5.10.0\nINFO         | token=sk-live-abcdefghijklmnopqrstuvwxyz0123456789\n",
    );
    let error: unknown;
    try {
      await waitForBoot({
        serial: "emulator-5590",
        adbPath: path.join(tmpRoot, "no-such-adb"),
        logPath,
        avdName: "pickforge-avd",
        timeoutMs: 100,
        pollIntervalMs: 10,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EmulatorStartError);
    const typed = error as EmulatorStartError;
    expect(typed.kind).toBe("boot-timeout");
    expect(typed.diagnostics.logPath).toBe(logPath);
    expect(typed.diagnostics.logTail).toEqual([
      "INFO         | Android emulator version 36.5.10.0",
      "INFO         | token=[REDACTED]",
    ]);
    expect(typed.diagnostics.deviceState).toBe(DEVICE_STATE_UNKNOWN);
    expect(typed.message).toContain("[boot-timeout]");
    expect(typed.message).toContain("adb itself could not be run");
    expect(typed.message).toMatch(/probe failed to run: .*ENOENT/);
    expect(typed.message).toContain(`check the log at ${logPath}`);
    expect(typed.message).not.toContain("abcdefghijklmnopqrstuvwxyz");

    // The same failure through startEmulator lands in the same typed error.
    const sdk = makeFakeSdk(BOOTING_ADB_SCRIPT);
    fs.writeFileSync(path.join(sdk, "platform-tools", "adb"), "#!/nonexistent/interpreter\n", {
      mode: 0o755,
    });
    const registryEnv = makeRegistryEnv();
    const started = await startFailure(
      startEmulator({
        avdName: "pickforge-avd",
        sdk,
        port: 5590,
        logDir: path.join(tmpRoot, "emu-probe-cannot-run"),
        env: toolEnv,
        registryEnv,
        bootTimeoutMs: 200,
        bootPollIntervalMs: 20,
      }),
    );
    expect(started.kind).toBe("boot-timeout");
    expect(started.diagnostics.deviceState).toBe(DEVICE_STATE_UNKNOWN);
    expect(started.diagnostics.logPath).toMatch(/emulator\.log$/);
    expect(started.message).toMatch(/probe failed to run: .*ENOENT/);
    expect(fs.existsSync(consolePortLockPath(5590, registryEnv))).toBe(false);
  });

  it("reports the boot mode from the emulator log and honours cold boot", async () => {
    const argsFile = path.join(tmpRoot, "boot-mode-args.txt");
    const sdk = makeFakeSdk(
      BOOTING_ADB_SCRIPT,
      [
        "#!/bin/sh",
        "PATH=/usr/bin:/bin",
        `echo "$*" >> ${JSON.stringify(argsFile)}`,
        "echo \"INFO         | Loading snapshot 'default_boot'...\"",
        "exec sleep 60",
        "",
      ].join("\n"),
    );
    const registryEnv = makeRegistryEnv();
    const warm = await startEmulator({
      avdName: "pickforge-avd",
      sdk,
      port: 5580,
      logDir: path.join(tmpRoot, "emu-warm"),
      env: toolEnv,
      registryEnv,
      bootTimeoutMs: 5_000,
      bootPollIntervalMs: 20,
    });
    try {
      expect(warm.bootMode).toBe("warm");
    } finally {
      await stop(warm, sdk, registryEnv);
    }
    const cold = await startEmulator({
      avdName: "pickforge-avd",
      sdk,
      port: 5582,
      coldBoot: true,
      readOnly: true,
      logDir: path.join(tmpRoot, "emu-cold"),
      env: toolEnv,
      registryEnv,
      bootTimeoutMs: 5_000,
      bootPollIntervalMs: 20,
    });
    try {
      expect(cold.bootMode).toBe("cold");
    } finally {
      await stop(cold, sdk, registryEnv);
    }
    const [warmArgs, coldArgs] = fs.readFileSync(argsFile, "utf8").trim().split("\n");
    expect(warmArgs).not.toContain("-no-snapshot-load");
    expect(coldArgs).toContain("-port 5582 -no-snapshot-load -read-only");
  }, 20_000);
});

describe("sdk auto-detection in the execution layer", () => {
  it("starts the emulator from an sdk detected via ANDROID_HOME with no PATH tools", async () => {
    const sdk = makeFakeSdk(BOOTING_ADB_SCRIPT);
    const registryEnv = makeRegistryEnv();
    const env = { ...toolEnv, ANDROID_HOME: sdk };
    const handle = await startEmulator({
      avdName: "pickforge-avd",
      port: 5564,
      logDir: path.join(tmpRoot, "emu-detected"),
      env,
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
        env,
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
        env: toolEnv,
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
      env: toolEnv,
      registryEnv,
      timeoutMs: 300,
    });
    expect(stopped).toBe(false);
  });
});
