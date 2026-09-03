import { describe, expect, it } from "vitest";
import {
  buildClearLogcatArgs,
  buildCreateAvdArgs,
  buildEmulatorArgs,
  buildInstallApkArgs,
  buildKeyeventArgs,
  buildLaunchAppArgs,
  buildLogcatArgs,
  buildScreenshotArgs,
  buildTapArgs,
  buildTypeTextArgs,
  buildUiCatArgs,
  buildUiCleanupArgs,
  buildUiDumpArgs,
  emulatorSerial,
  escapeInputText,
  KEYCODE_BACK,
  KEYCODE_HOME,
  parseAdbDevices,
  parseEmulatorListAvds,
  pickConsolePort,
  splitInputText,
  UI_DUMP_REMOTE_PATH,
} from "../src/index.js";

const SERIAL = "emulator-5554";
const HOSTILE = ["; rm -rf /", "$(reboot)", "`id`", "&& cat /etc/passwd"];

describe("buildCreateAvdArgs", () => {
  it("builds the avdmanager invocation", () => {
    expect(
      buildCreateAvdArgs({
        name: "pickforge-avd",
        systemImage: "system-images;android-34;google_apis;x86_64",
      }),
    ).toEqual([
      "create",
      "avd",
      "-n",
      "pickforge-avd",
      "-k",
      "system-images;android-34;google_apis;x86_64",
    ]);
  });

  it("appends the optional device profile as one element", () => {
    const args = buildCreateAvdArgs({
      name: "pickforge-avd",
      systemImage: "system-images;android-34;google_apis;x86_64",
      device: "pixel 5",
    });
    expect(args.slice(-2)).toEqual(["--device", "pixel 5"]);
  });

  it("rejects hostile avd names and system images", () => {
    for (const value of HOSTILE) {
      expect(() =>
        buildCreateAvdArgs({
          name: value,
          systemImage: "system-images;android-34;default;x86_64",
        }),
      ).toThrow(/Invalid AVD name/);
      expect(() =>
        buildCreateAvdArgs({ name: "ok", systemImage: value }),
      ).toThrow(/Invalid system image/);
    }
    expect(() =>
      buildCreateAvdArgs({
        name: "ok",
        systemImage: "system-images;android-34;default;x86_64",
        device: "--injected",
      }),
    ).toThrow(/Invalid device profile/);
  });
});

describe("buildEmulatorArgs", () => {
  it("builds headless defaults with an explicit port", () => {
    expect(buildEmulatorArgs({ avdName: "pickforge-avd", port: 5556 })).toEqual([
      "-avd",
      "pickforge-avd",
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-port",
      "5556",
    ]);
  });

  it("omits -no-window when headless is disabled", () => {
    const args = buildEmulatorArgs({ avdName: "pickforge-avd", headless: false });
    expect(args).not.toContain("-no-window");
    expect(args).toContain("-no-audio");
  });

  it("rejects hostile avd names and invalid ports", () => {
    for (const value of HOSTILE) {
      expect(() => buildEmulatorArgs({ avdName: value })).toThrow(
        /Invalid AVD name/,
      );
    }
    expect(() => buildEmulatorArgs({ avdName: "a", port: 5555 })).toThrow(
      /even integer/,
    );
    expect(() => buildEmulatorArgs({ avdName: "a", port: 80 })).toThrow(
      /Invalid console port/,
    );
  });
});

describe("emulator serial and port helpers", () => {
  it("derives the serial from the console port", () => {
    expect(emulatorSerial(5554)).toBe("emulator-5554");
    expect(() => emulatorSerial(5553)).toThrow(/Invalid console port/);
  });

  it("picks the first free automatic even console port", () => {
    expect(pickConsolePort([])).toBe(5556);
    expect(pickConsolePort(["emulator-5554", "emulator-5556"])).toBe(5558);
    expect(pickConsolePort(["emulator-5554", "0123456789ABCDEF"])).toBe(5556);
  });

  it("throws when all automatic console ports are taken", () => {
    const used: string[] = [];
    for (let port = 5556; port <= 5682; port += 2) {
      used.push(`emulator-${port}`);
    }
    expect(() => pickConsolePort(used)).toThrow(/No free emulator console port/);
  });
});

describe("adb arg builders", () => {
  it("builds install args with the apk path as one element", () => {
    const apk = "/tmp/app with spaces; rm -rf /.apk";
    expect(buildInstallApkArgs(SERIAL, apk)).toEqual([
      "-s",
      SERIAL,
      "install",
      "-r",
      apk,
    ]);
  });

  it("builds am start args when an activity is given", () => {
    expect(buildLaunchAppArgs(SERIAL, "com.example.app", ".MainActivity")).toEqual(
      ["-s", SERIAL, "shell", "am", "start", "-n", "com.example.app/.MainActivity"],
    );
  });

  it("builds monkey args when only a package is given", () => {
    expect(buildLaunchAppArgs(SERIAL, "com.example.app")).toEqual([
      "-s",
      SERIAL,
      "shell",
      "monkey",
      "-p",
      "com.example.app",
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
  });

  it("rejects hostile package names, activities, and serials", () => {
    for (const value of HOSTILE) {
      expect(() => buildLaunchAppArgs(SERIAL, value)).toThrow(
        /Invalid package name/,
      );
      expect(() => buildLaunchAppArgs(SERIAL, "com.example.app", value)).toThrow(
        /Invalid activity/,
      );
      expect(() => buildTapArgs(value, 1, 2)).toThrow(/Invalid device serial/);
    }
    expect(() => buildLaunchAppArgs(SERIAL, "singleword")).toThrow(
      /Invalid package name/,
    );
  });

  it("builds screencap exec-out args", () => {
    expect(buildScreenshotArgs(SERIAL)).toEqual([
      "-s",
      SERIAL,
      "exec-out",
      "screencap",
      "-p",
    ]);
  });

  it("builds tap args and validates coordinates", () => {
    expect(buildTapArgs(SERIAL, 120, 740)).toEqual([
      "-s",
      SERIAL,
      "shell",
      "input",
      "tap",
      "120",
      "740",
    ]);
    expect(() => buildTapArgs(SERIAL, -1, 0)).toThrow(/Invalid x coordinate/);
    expect(() => buildTapArgs(SERIAL, 0, 1.5)).toThrow(/Invalid y coordinate/);
  });

  it("builds keyevent args including back and home keycodes", () => {
    expect(buildKeyeventArgs(SERIAL, KEYCODE_BACK)).toEqual([
      "-s",
      SERIAL,
      "shell",
      "input",
      "keyevent",
      "KEYCODE_BACK",
    ]);
    expect(buildKeyeventArgs(SERIAL, "4")).toContain("4");
    expect(buildKeyeventArgs(SERIAL, "3")).toContain("3");
    expect(KEYCODE_HOME).toBe("KEYCODE_HOME");
    expect(() => buildKeyeventArgs(SERIAL, "KEYCODE_A; reboot")).toThrow(
      /Invalid key/,
    );
  });

  it("builds the ui dump, cat, and cleanup invocations", () => {
    expect(buildUiDumpArgs(SERIAL)).toEqual([
      "-s",
      SERIAL,
      "shell",
      "uiautomator",
      "dump",
      UI_DUMP_REMOTE_PATH,
    ]);
    expect(buildUiCatArgs(SERIAL)).toEqual([
      "-s",
      SERIAL,
      "exec-out",
      "cat",
      UI_DUMP_REMOTE_PATH,
    ]);
    expect(buildUiCleanupArgs(SERIAL)).toEqual([
      "-s",
      SERIAL,
      "shell",
      "rm",
      "-f",
      UI_DUMP_REMOTE_PATH,
    ]);
  });
});

describe("android input text escaping", () => {
  it("escapes spaces as %s", () => {
    expect(escapeInputText("hello world")).toBe("hello%sworld");
  });

  it("escapes device-shell metacharacters", () => {
    expect(escapeInputText("a&b|c;d")).toBe("a\\&b\\|c\\;d");
    expect(escapeInputText('say "hi" $(now) `id` ~user')).toBe(
      'say%s\\"hi\\"%s\\$\\(now\\)%s\\`id\\`%s\\~user',
    );
    expect(escapeInputText("back\\slash")).toBe("back\\\\slash");
    expect(escapeInputText("<tag>")).toBe("\\<tag\\>");
  });

  it("keeps hostile injection strings as a single escaped argv element", () => {
    for (const value of HOSTILE) {
      const args = buildTypeTextArgs(SERIAL, value);
      expect(args).toHaveLength(6);
      expect(args.slice(0, 5)).toEqual([
        "-s",
        SERIAL,
        "shell",
        "input",
        "text",
      ]);
      const payload = args[5] as string;
      expect(payload).not.toContain(" ");
      expect(payload).toBe(escapeInputText(value));
    }
    expect(buildTypeTextArgs(SERIAL, "; rm -rf /")[5]).toBe(
      "\\;%srm%s-rf%s/",
    );
    expect(buildTypeTextArgs(SERIAL, "$(reboot)")[5]).toBe("\\$\\(reboot\\)");
  });

  it("rejects empty text and control characters", () => {
    expect(() => buildTypeTextArgs(SERIAL, "")).toThrow(/non-empty/);
    expect(() => buildTypeTextArgs(SERIAL, "line\nbreak")).toThrow(
      /control characters/,
    );
  });

  it("rejects non-ASCII text with an actionable error", () => {
    expect(() => buildTypeTextArgs(SERIAL, "héllo")).toThrow(/non-ASCII/);
    expect(() => buildTypeTextArgs(SERIAL, "emoji \u{1f600}")).toThrow(
      /non-ASCII/,
    );
  });

  it("keeps a literal percent intact and rejects an untypeable raw %s", () => {
    expect(buildTypeTextArgs(SERIAL, "100%done")[5]).toBe("100%done");
    expect(buildTypeTextArgs(SERIAL, "50% off")[5]).toBe("50%%soff");
    expect(() => buildTypeTextArgs(SERIAL, "100%size")).toThrow(/typeText/);
  });

  it("splits percent-s pairs into separately typeable chunks", () => {
    expect(splitInputText("100%size")).toEqual(["100%", "size"]);
    expect(splitInputText("a%sb%sc")).toEqual(["a%", "sb%", "sc"]);
    expect(splitInputText("%s")).toEqual(["%", "s"]);
    expect(splitInputText("plain")).toEqual(["plain"]);
    expect(splitInputText("50% off")).toEqual(["50% off"]);
    for (const chunk of splitInputText("100%size")) {
      expect(buildTypeTextArgs(SERIAL, chunk)[5]).not.toContain("%s");
    }
  });
});

describe("logcat arg building", () => {
  it("builds dump-mode args with a default line budget", () => {
    expect(buildLogcatArgs(SERIAL)).toEqual([
      "-s",
      SERIAL,
      "logcat",
      "-d",
      "-t",
      "500",
    ]);
  });

  it("supports custom line counts and filterspecs", () => {
    expect(buildLogcatArgs(SERIAL, { lines: 50, filter: "ActivityManager:I *:S" })).toEqual([
      "-s",
      SERIAL,
      "logcat",
      "-d",
      "-t",
      "50",
      "ActivityManager:I",
      "*:S",
    ]);
  });

  it("rejects invalid line counts", () => {
    expect(() => buildLogcatArgs(SERIAL, { lines: 0 })).toThrow(/Invalid lines/);
    expect(() => buildLogcatArgs(SERIAL, { lines: 2.5 })).toThrow(/Invalid lines/);
  });

  it("builds clear args", () => {
    expect(buildClearLogcatArgs(SERIAL)).toEqual(["-s", SERIAL, "logcat", "-c"]);
  });
});

describe("parseAdbDevices", () => {
  it("parses serials and states", () => {
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "emulator-5556\toffline",
      "R58M123ABC\tunauthorized",
      "* daemon started successfully *",
      "",
    ].join("\n");
    expect(parseAdbDevices(output)).toEqual([
      { serial: "emulator-5554", state: "device" },
      { serial: "emulator-5556", state: "offline" },
      { serial: "R58M123ABC", state: "unauthorized" },
    ]);
  });

  it("returns an empty list for an empty device table", () => {
    expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
  });
});

describe("parseEmulatorListAvds", () => {
  it("keeps avd names and drops emulator log noise", () => {
    const output = [
      "INFO    | Storing crashdata in: /tmp/android-x/emu-crash.db",
      "pickforge-avd",
      "Pixel_5_API_34",
      "",
    ].join("\n");
    expect(parseEmulatorListAvds(output)).toEqual(["pickforge-avd", "Pixel_5_API_34"]);
  });
});
