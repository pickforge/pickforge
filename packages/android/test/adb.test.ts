import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isPidAlive, startDaemon } from "@pickforge/lab-core";
import {
  getUiTree,
  launchApp,
  listDevices,
  logcat,
  resolveAdb,
  runAdb,
  screenshot,
  stopEmulator,
  tap,
  typeText,
  waitForBoot,
} from "../src/index.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-android-adb-"));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SERIAL = "emulator-5554";

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let binCounter = 0;

function fakeAdbDir(script: string): string {
  binCounter += 1;
  const dir = path.join(tmpRoot, `bin-${binCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "adb"),
    `#!/bin/sh\nPATH="/usr/bin:/bin:$PATH"\n${script}\n`,
    { mode: 0o755 },
  );
  return dir;
}

describe("resolveAdb", () => {
  it("throws an actionable error when adb is missing", () => {
    expect(() => resolveAdb({ sdk: null, env: { PATH: "" } })).toThrow(
      /platform-tools/,
    );
  });

  it("auto-detects the sdk root from ANDROID_HOME when sdk is undefined", () => {
    const sdk = path.join(tmpRoot, "detected-sdk");
    const adbPath = path.join(sdk, "platform-tools", "adb");
    fs.mkdirSync(path.dirname(adbPath), { recursive: true });
    fs.writeFileSync(adbPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(resolveAdb({ env: { ANDROID_HOME: sdk, PATH: "" } })).toBe(adbPath);
    expect(() =>
      resolveAdb({ sdk: null, env: { ANDROID_HOME: sdk, PATH: "" } }),
    ).toThrow(/platform-tools/);
  });
});

describe("screenshot via exec-out", () => {
  it("writes binary stdout to the out path and verifies the PNG magic", async () => {
    const helper = path.join(tmpRoot, "png.cjs");
    fs.writeFileSync(
      helper,
      "process.stdout.write(Buffer.concat([" +
        "Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])," +
        "Buffer.from([0x00,0xff,0x00,0xfe,0x80,0x81])]))",
    );
    const bin = fakeAdbDir(`exec '${process.execPath}' '${helper}'`);
    const outPath = path.join(tmpRoot, "shots", "screen.png");
    const result = await screenshot({
      serial: SERIAL,
      outPath,
      sdk: null, env: { PATH: bin },
    });
    expect(result.path).toBe(outPath);
    const data = fs.readFileSync(outPath);
    expect(data.length).toBe(14);
    expect(data.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect([...data.subarray(8)]).toEqual([0x00, 0xff, 0x00, 0xfe, 0x80, 0x81]);
  });

  it("rejects non-PNG output", async () => {
    const bin = fakeAdbDir('printf "not a png"');
    await expect(
      screenshot({
        serial: SERIAL,
        outPath: path.join(tmpRoot, "bad.png"),
        sdk: null, env: { PATH: bin },
      }),
    ).rejects.toThrow(/did not produce a PNG/);
  });

  it("surfaces adb failures with the invocation", async () => {
    const bin = fakeAdbDir('echo "device offline" >&2; exit 1');
    await expect(
      screenshot({
        serial: SERIAL,
        outPath: path.join(tmpRoot, "fail.png"),
        sdk: null, env: { PATH: bin },
      }),
    ).rejects.toThrow(/screenshot failed[\s\S]*device offline/);
  });
});

describe("getUiTree", () => {
  it("dumps, reads back, and cleans up the remote xml", async () => {
    const callLog = path.join(tmpRoot, "ui-calls.log");
    const bin = fakeAdbDir(
      [
        `echo "$*" >> '${callLog}'`,
        'case "$*" in',
        '  *"uiautomator dump"*) echo "UI hierchary dumped to: /sdcard/pickforge-lab-ui.xml" ;;',
        '  *"cat /sdcard/pickforge-lab-ui.xml"*) printf \'<?xml version="1.0"?><hierarchy rotation="0"><node text="hi"/></hierarchy>\' ;;',
        "esac",
      ].join("\n"),
    );
    const xml = await getUiTree({ serial: SERIAL, sdk: null, env: { PATH: bin } });
    expect(xml).toContain("<hierarchy");
    expect(xml).toContain('text="hi"');
    const calls = fs.readFileSync(callLog, "utf8").trim().split("\n");
    expect(calls).toEqual([
      `-s ${SERIAL} shell uiautomator dump /sdcard/pickforge-lab-ui.xml`,
      `-s ${SERIAL} exec-out cat /sdcard/pickforge-lab-ui.xml`,
      `-s ${SERIAL} shell rm -f /sdcard/pickforge-lab-ui.xml`,
    ]);
  });

  it("cleans up the remote file even when the dump output is not xml", async () => {
    const callLog = path.join(tmpRoot, "ui-fail-calls.log");
    const bin = fakeAdbDir(
      [
        `echo "$*" >> '${callLog}'`,
        'case "$*" in *"cat "*) printf "ERROR: null root node returned" ;; esac',
      ].join("\n"),
    );
    await expect(
      getUiTree({ serial: SERIAL, sdk: null, env: { PATH: bin }, attempts: 1 }),
    ).rejects.toThrow(/did not return XML/);
    const calls = fs.readFileSync(callLog, "utf8");
    expect(calls).toContain("rm -f /sdcard/pickforge-lab-ui.xml");
  });

  it("retries transient null-root dump failures", async () => {
    const countFile = path.join(tmpRoot, "ui-retry-count");
    const bin = fakeAdbDir(
      [
        'case "$*" in',
        '  *"uiautomator dump"*)',
        `    n=$(cat '${countFile}' 2>/dev/null || echo 0)`,
        "    n=$((n+1))",
        `    echo "$n" > '${countFile}'`,
        '    if [ "$n" -lt 3 ]; then',
        '      echo "ERROR: null root node returned by UiTestAutomationBridge." >&2',
        "      exit 1",
        "    fi",
        '    echo "UI hierchary dumped to: /sdcard/pickforge-lab-ui.xml" ;;',
        '  *"cat /sdcard/pickforge-lab-ui.xml"*) printf \'<?xml version="1.0"?><hierarchy/>\' ;;',
        "esac",
      ].join("\n"),
    );
    const xml = await getUiTree({
      serial: SERIAL,
      sdk: null, env: { PATH: bin },
      retryDelayMs: 10,
    });
    expect(xml).toContain("<hierarchy");
    expect(fs.readFileSync(countFile, "utf8").trim()).toBe("3");
  });

  it("rejects a non-positive attempts option", async () => {
    await expect(
      getUiTree({ serial: SERIAL, sdk: null, env: { PATH: "" }, attempts: 0 }),
    ).rejects.toThrow(/Invalid attempts/);
  });
});

describe("logcat and devices", () => {
  it("returns the dumped log", async () => {
    const bin = fakeAdbDir('echo "06-09 19:00:00.000 I/Pickforge: hello"');
    const output = await logcat({ serial: SERIAL, lines: 10, sdk: null, env: { PATH: bin } });
    expect(output).toContain("I/Pickforge: hello");
  });

  it("lists devices through the real parser", async () => {
    const bin = fakeAdbDir(
      'printf "List of devices attached\\nemulator-5554\\tdevice\\n"',
    );
    expect(await listDevices({ sdk: null, env: { PATH: bin } })).toEqual([
      { serial: "emulator-5554", state: "device" },
    ]);
  });
});

describe("runAdb passthrough", () => {
  it("passes raw args as argv without a shell and prepends the serial", async () => {
    const bin = fakeAdbDir(
      'for a in "$@"; do echo "ARG:$a"; done',
    );
    const result = await runAdb({
      serial: SERIAL,
      args: ["shell", "echo", "; rm -rf /"],
      sdk: null, env: { PATH: bin },
    });
    expect(result.ok).toBe(true);
    expect(result.stdout.split("\n").filter((l) => l !== "")).toEqual([
      "ARG:-s",
      `ARG:${SERIAL}`,
      "ARG:shell",
      "ARG:echo",
      "ARG:; rm -rf /",
    ]);
  });

  it("validates the serial but passes failures through without throwing", async () => {
    const bin = fakeAdbDir("exit 5");
    await expect(
      runAdb({ serial: "bad serial", args: ["devices"], sdk: null, env: { PATH: bin } }),
    ).rejects.toThrow(/Invalid device serial/);
    const result = await runAdb({ args: ["devices"], sdk: null, env: { PATH: bin } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(5);
  });
});

describe("input ops against a fake adb", () => {
  it("taps through adb shell input", async () => {
    const callLog = path.join(tmpRoot, "tap-calls.log");
    const bin = fakeAdbDir(`echo "$*" >> '${callLog}'`);
    await tap({ serial: SERIAL, x: 12, y: 34, sdk: null, env: { PATH: bin } });
    expect(fs.readFileSync(callLog, "utf8").trim()).toBe(
      `-s ${SERIAL} shell input tap 12 34`,
    );
  });

  it("types text containing a percent-s pair through split invocations", async () => {
    const callLog = path.join(tmpRoot, "type-calls.log");
    const bin = fakeAdbDir(`echo "$*" >> '${callLog}'`);
    await typeText({
      serial: SERIAL,
      text: "100%size",
      sdk: null,
      env: { PATH: bin },
    });
    expect(fs.readFileSync(callLog, "utf8").trim().split("\n")).toEqual([
      `-s ${SERIAL} shell input text 100%`,
      `-s ${SERIAL} shell input text size`,
    ]);
  });
});

describe("launchApp", () => {
  const RESOLVE_LINE =
    "com.example.app/.MainActivity";
  const START_OK = [
    'echo "Starting: Intent { cmp=com.example.app/.MainActivity }"',
    'echo "Status: ok"',
    'echo "LaunchState: COLD"',
    'echo "TotalTime: 812"',
  ].join("; ");

  function launchAdb(callLog: string, overrides: Record<string, string> = {}): string {
    const cases = {
      "*resolve-activity*": `echo "priority=0 preferredOrder=0 match=0x108000"; echo "${RESOLVE_LINE}"`,
      '*"am start"*': START_OK,
      "*pidof*": "echo 4242",
      ...overrides,
    };
    return fakeAdbDir(
      [
        `echo "$*" >> '${callLog}'`,
        'case "$*" in',
        ...Object.entries(cases).map(([pattern, body]) => `  ${pattern}) ${body} ;;`),
        "esac",
      ].join("\n"),
    );
  }

  it("resolves the launcher activity, starts it with am start -W, and confirms the process", async () => {
    const callLog = path.join(tmpRoot, "launch-calls.log");
    const bin = launchAdb(callLog);
    const launched = await launchApp({
      serial: SERIAL,
      packageName: "com.example.app",
      sdk: null,
      env: { PATH: bin },
    });
    expect(launched).toEqual({
      component: "com.example.app/.MainActivity",
      pid: 4242,
      launchState: "COLD",
    });
    expect(fs.readFileSync(callLog, "utf8").trim().split("\n")).toEqual([
      `-s ${SERIAL} shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.example.app`,
      `-s ${SERIAL} shell am start -W -n com.example.app/.MainActivity`,
      `-s ${SERIAL} shell pidof com.example.app`,
    ]);
  });

  it("skips resolution when the activity is given", async () => {
    const callLog = path.join(tmpRoot, "launch-explicit.log");
    const bin = launchAdb(callLog);
    await launchApp({
      serial: SERIAL,
      packageName: "com.example.app",
      activity: ".Other",
      sdk: null,
      env: { PATH: bin },
    });
    expect(fs.readFileSync(callLog, "utf8").trim().split("\n")).toEqual([
      `-s ${SERIAL} shell am start -W -n com.example.app/.Other`,
      `-s ${SERIAL} shell pidof com.example.app`,
    ]);
  });

  it("fails distinctly when no launcher activity resolves", async () => {
    const callLog = path.join(tmpRoot, "launch-unresolved.log");
    const bin = launchAdb(callLog, {
      "*resolve-activity*": 'echo "No activity found"',
    });
    await expect(
      launchApp({
        serial: SERIAL,
        packageName: "com.example.app",
        sdk: null,
        env: { PATH: bin },
      }),
    ).rejects.toThrow(
      /No launcher activity found for com\.example\.app on emulator-5554; is the APK installed\?.*No activity found/,
    );
    expect(fs.readFileSync(callLog, "utf8")).not.toContain("am start");
  });

  it("treats an am start error as a launch failure", async () => {
    const bin = launchAdb(path.join(tmpRoot, "launch-error.log"), {
      '*"am start"*':
        'echo "Error type 3"; echo "Error: Activity class {com.example.app/.MainActivity} does not exist."',
    });
    await expect(
      launchApp({
        serial: SERIAL,
        packageName: "com.example.app",
        sdk: null,
        env: { PATH: bin },
      }),
    ).rejects.toThrow(/launch of com\.example\.app failed[\s\S]*does not exist/);
  });

  it("fails when the start was accepted but the process is gone", async () => {
    const bin = launchAdb(path.join(tmpRoot, "launch-dead.log"), {
      "*pidof*": "exit 1",
    });
    await expect(
      launchApp({
        serial: SERIAL,
        packageName: "com.example.app",
        sdk: null,
        env: { PATH: bin },
        settleTimeoutMs: 100,
      }),
    ).rejects.toThrow(
      /launch of com\.example\.app was accepted \(am start -W printed: Starting: Intent[^)]*Status: ok[^)]*\) but no com\.example\.app process is alive after 100ms/,
    );
  });
});

describe("waitForBoot polling", () => {
  it("polls getprop until sys.boot_completed is 1", async () => {
    const countFile = path.join(tmpRoot, "boot-count");
    const bin = fakeAdbDir(
      [
        `n=$(cat '${countFile}' 2>/dev/null || echo 0)`,
        "n=$((n+1))",
        `echo "$n" > '${countFile}'`,
        'if [ "$n" -ge 3 ]; then echo 1; else echo 0; fi',
      ].join("\n"),
    );
    await waitForBoot({
      serial: SERIAL,
      adbPath: path.join(bin, "adb"),
      timeoutMs: 5_000,
      pollIntervalMs: 20,
    });
    expect(fs.readFileSync(countFile, "utf8").trim()).toBe("3");
  });

  it("fails with the log path when the deadline passes", async () => {
    const bin = fakeAdbDir("echo 0");
    await expect(
      waitForBoot({
        serial: SERIAL,
        adbPath: path.join(bin, "adb"),
        timeoutMs: 150,
        pollIntervalMs: 50,
        logPath: "/tmp/emulator.log",
      }),
    ).rejects.toThrow(/did not finish booting within 150ms.*\/tmp\/emulator\.log/);
  });

  it("fails fast when the emulator process dies", async () => {
    const bin = fakeAdbDir("echo 0");
    await expect(
      waitForBoot({
        serial: SERIAL,
        adbPath: path.join(bin, "adb"),
        timeoutMs: 5_000,
        pollIntervalMs: 50,
        isEmulatorAlive: () => false,
        logPath: "/tmp/emulator.log",
      }),
    ).rejects.toThrow(/exited before finishing boot.*\/tmp\/emulator\.log/);
  });

  it("fails when the emulator dies between a positive getprop and success", async () => {
    const bin = fakeAdbDir("echo 1");
    let aliveChecks = 0;
    await expect(
      waitForBoot({
        serial: SERIAL,
        adbPath: path.join(bin, "adb"),
        timeoutMs: 5_000,
        pollIntervalMs: 20,
        isEmulatorAlive: () => {
          aliveChecks += 1;
          return aliveChecks < 2;
        },
        logPath: "/tmp/emulator.log",
      }),
    ).rejects.toThrow(/exited before finishing boot/);
    expect(aliveChecks).toBe(2);
  });

  it("clamps the per-poll getprop timeout to the remaining boot budget", async () => {
    const bin = fakeAdbDir("sleep 30");
    const start = Date.now();
    await expect(
      waitForBoot({
        serial: SERIAL,
        adbPath: path.join(bin, "adb"),
        timeoutMs: 300,
        pollIntervalMs: 50,
      }),
    ).rejects.toThrow(/did not finish booting within 300ms/);
    expect(Date.now() - start).toBeLessThan(6_000);
  });
});

describe("stopEmulator", () => {
  it("falls back to stopPid when adb emu kill does not stop the process", async () => {
    const bin = fakeAdbDir("exit 0");
    const daemon = await startDaemon(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { logDir: path.join(tmpRoot, "stop-logs"), name: "fake-emulator" },
    );
    expect(isPidAlive(daemon.pid)).toBe(true);
    const stopped = await stopEmulator({
      serial: SERIAL,
      pid: daemon.pid,
      sdk: null,
      env: { PATH: bin },
      registryEnv: { PICKFORGE_HOME: path.join(tmpRoot, "stop-home") },
      timeoutMs: 300,
    });
    expect(stopped).toBe(true);
    expect(isPidAlive(daemon.pid)).toBe(false);
  });

  it("returns true for an already-dead pid without adb", async () => {
    expect(
      await stopEmulator({ pid: 999_999_2, sdk: null, env: { PATH: "" }, timeoutMs: 200 }),
    ).toBe(true);
  });
});
