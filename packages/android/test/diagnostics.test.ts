import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AVD_SHARING_POLICY,
  avdHomeDir,
  classifyEmulatorLog,
  describeDeviceState,
  detectBootMode,
  DEVICE_STATE_UNKNOWN,
  deviceStateHint,
  EmulatorStartError,
  isEmulatorStartError,
  LOG_TAIL_LINES,
  readLogTail,
  startFailureRecord,
} from "../src/index.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-android-diag-"));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("classifyEmulatorLog", () => {
  it("maps each known emulator failure line to one distinct kind", () => {
    const cases: Array<[string, string]> = [
      ["ERROR        | Unknown AVD name [x], use -list-avds to see valid list.", "avd-missing"],
      [
        "ERROR        | Running multiple emulators with the same AVD is an experimental feature.Please use -read-only flag to enable this feature.",
        "avd-in-use",
      ],
      ["ERROR        | console port 5556 is already in use", "port-collision"],
      ["ERROR        | bind: address already in use", "port-collision"],
      ["ERROR        | snapshot default_boot: L1 table entry corrupted", "snapshot"],
      ["ERROR        | Failed to load snapshot 'default_boot'", "snapshot"],
      ["ERROR        | x86_64 emulation currently requires hardware acceleration!", "kvm"],
      ["ERROR        | /dev/kvm: permission denied", "kvm"],
      ["INFO         | boring line", "process-exit"],
    ];
    for (const [line, kind] of cases) {
      expect(classifyEmulatorLog([line]).kind, line).toBe(kind);
    }
    expect(classifyEmulatorLog([]).kind).toBe("process-exit");
    expect(classifyEmulatorLog([]).hint).toBeUndefined();
    expect(classifyEmulatorLog(["Unknown AVD name [x]"]).hint).toContain("ANDROID_AVD_HOME");
  });

  it("names the directories the emulator really searches, matching avdHomeDir", () => {
    const hint = classifyEmulatorLog(["ERROR        | Unknown AVD name [x]"]).hint ?? "";
    // Every directory the hint names must be the one avdHomeDir resolves for
    // that variable, so a user following the hint puts the AVD where
    // Pickforge (and the emulator) will look.
    expect(hint).toContain("$ANDROID_SDK_HOME/.android/avd");
    expect(hint).not.toMatch(/\$ANDROID_SDK_HOME\/avd\b/);
    expect(hint).toContain("$ANDROID_PREFS_ROOT/.android/avd");
    expect(hint).toContain("$ANDROID_USER_HOME/avd");
    expect(hint).toContain("$ANDROID_EMULATOR_HOME/avd");
    expect(avdHomeDir({ ANDROID_SDK_HOME: "/p" })).toBe("/p/.android/avd");
    expect(avdHomeDir({ ANDROID_PREFS_ROOT: "/p" })).toBe("/p/.android/avd");
    expect(avdHomeDir({ ANDROID_USER_HOME: "/p" })).toBe("/p/avd");
    expect(avdHomeDir({ ANDROID_EMULATOR_HOME: "/p" })).toBe("/p/avd");
  });

  it("states AVD sharing as Pickforge's own policy, not as emulator behaviour", () => {
    const hint =
      classifyEmulatorLog(["ERROR        | Another emulator instance is running"]).hint ?? "";
    expect(hint).toContain(AVD_SHARING_POLICY);
    expect(AVD_SHARING_POLICY).toMatch(/^Pickforge shares an AVD only among read-only sessions/);
    expect(hint).not.toMatch(/the emulator only shares/);
    expect(hint).toContain("--read-only");
  });

  it("does not mistake the emulator's normal snapshot chatter for a failure", () => {
    expect(
      classifyEmulatorLog([
        "INFO         | Loading snapshot 'default_boot'...",
        "INFO         | Successfully loaded snapshot 'default_boot'",
      ]).kind,
    ).toBe("process-exit");
  });
});

describe("detectBootMode", () => {
  it("reads warm, cold, and unknown from the log and honours a forced cold boot", () => {
    expect(detectBootMode(["INFO         | Loading snapshot 'default_boot'..."])).toBe("warm");
    expect(
      detectBootMode([
        "INFO         | Loading snapshot 'default_boot'...",
        "WARNING      | The emulator is performing a cold boot because the saved state could not be loaded. Reason: x",
      ]),
    ).toBe("cold");
    expect(detectBootMode(["INFO         | Monitoring duration of emulator setup."])).toBe(
      "unknown",
    );
    expect(detectBootMode(["INFO         | Loading snapshot 'default_boot'..."], true)).toBe(
      "cold",
    );
  });
});

describe("readLogTail", () => {
  it("returns the last lines, drops blanks, redacts secrets, and tolerates a missing file", () => {
    const logPath = path.join(tmpRoot, "emulator.log");
    const lines: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      lines.push(`line ${i}`, "");
    }
    lines.push("INFO | sending token=sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
    fs.writeFileSync(logPath, lines.join("\n"));
    const tail = readLogTail(logPath);
    expect(tail).toHaveLength(LOG_TAIL_LINES);
    expect(tail[0]).toBe(`line ${100 - LOG_TAIL_LINES + 1}`);
    expect(tail.at(-1)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(tail.every((line) => line !== "")).toBe(true);
    expect(readLogTail(logPath, 2)).toHaveLength(2);
    expect(readLogTail(path.join(tmpRoot, "absent.log"))).toEqual([]);
    expect(readLogTail(undefined)).toEqual([]);
  });

  it("reads only the end of a large log", () => {
    const logPath = path.join(tmpRoot, "large.log");
    const filler = `${"x".repeat(1_000)}\n`.repeat(200);
    fs.writeFileSync(logPath, `${filler}final line\n`);
    const tail = readLogTail(logPath, 1);
    expect(tail).toEqual(["final line"]);
  });
});

describe("device state helpers", () => {
  it("describes the serial's adb state or missing", () => {
    const devices = [
      { serial: "emulator-5554", state: "device" },
      { serial: "emulator-5556", state: "unauthorized" },
    ];
    expect(describeDeviceState(devices, "emulator-5554")).toBe("device");
    expect(describeDeviceState(devices, "emulator-5556")).toBe("unauthorized");
    expect(describeDeviceState(devices, "emulator-5558")).toBe("missing");
    expect(deviceStateHint("unauthorized")).toContain("adbkey");
    expect(deviceStateHint("missing")).toContain("never listed");
    expect(deviceStateHint(DEVICE_STATE_UNKNOWN)).toContain("adb itself could not be run");
    expect(deviceStateHint("weird")).toBeUndefined();
  });
});

describe("EmulatorStartError", () => {
  it("formats the kind, state, hint, log path, and tail into one message", () => {
    const error = new EmulatorStartError("Emulator emulator-5556 did not finish booting", {
      kind: "boot-timeout",
      avdName: "lab",
      serial: "emulator-5556",
      consolePort: 5556,
      logPath: "/tmp/x/emulator.log",
      logTail: ["INFO | a", "ERROR | b"],
      deviceState: "offline",
      hint: "the guest did not finish starting adbd",
    });
    expect(error.name).toBe("EmulatorStartError");
    expect(error.kind).toBe("boot-timeout");
    expect(isEmulatorStartError(error)).toBe(true);
    expect(isEmulatorStartError(new Error("x"))).toBe(false);
    expect(error.message).toBe(
      [
        "Emulator emulator-5556 did not finish booting [boot-timeout]; adb state: offline; " +
          "the guest did not finish starting adbd; check the log at /tmp/x/emulator.log",
        "--- emulator log tail (last 2 lines) ---",
        "INFO | a",
        "ERROR | b",
      ].join("\n"),
    );
  });

  it("stays single-line without a tail and omits unset fields", () => {
    const error = new EmulatorStartError('AVD "lab" not found', {
      kind: "avd-missing",
      avdName: "lab",
      logTail: [],
    });
    expect(error.message).toBe('AVD "lab" not found [avd-missing]');
  });

  it("produces a persistable record and nothing for foreign errors", () => {
    const error = new EmulatorStartError("x", {
      kind: "port-collision",
      avdName: "lab",
      serial: "emulator-5560",
      consolePort: 5560,
      logTail: ["a"],
      hint: "h",
    });
    expect(startFailureRecord(error)).toEqual({
      kind: "port-collision",
      avdName: "lab",
      serial: "emulator-5560",
      consolePort: 5560,
      logTail: ["a"],
      hint: "h",
    });
    expect(startFailureRecord(new Error("plain"))).toBeUndefined();
  });
});
