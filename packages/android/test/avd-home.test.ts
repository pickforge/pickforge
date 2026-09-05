import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  avdDataDir,
  avdExists,
  avdHomeDir,
  avdIniPath,
  avdLockPath,
  avdToolEnv,
  createAvd,
  listAvds,
  readAvdLockOwner,
  scanAvdHome,
} from "../src/index.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-avd-home-"));
const IMAGE = "system-images;android-35;google_apis;x86_64";

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `#!/bin/sh\nPATH=/usr/bin:/bin\n${content}\n`, {
    mode: 0o755,
  });
}

let sdkCounter = 0;

/**
 * A fake SDK whose avdmanager behaves like the real one: it records its
 * environment and writes the AVD wherever `avdmanagerScript` decides.
 */
function makeFakeSdk(avdmanagerScript: string): {
  sdk: string;
  envLog: string;
  emulatorLog: string;
} {
  sdkCounter += 1;
  const sdk = path.join(tmpRoot, `sdk-${sdkCounter}`);
  const envLog = path.join(sdk, "avdmanager-env.txt");
  const emulatorLog = path.join(sdk, "emulator-env.txt");
  fs.mkdirSync(path.join(sdk, "system-images", "android-35", "google_apis", "x86_64"), {
    recursive: true,
  });
  writeExecutable(
    path.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
    [
      `printf 'ANDROID_AVD_HOME=%s\\n' "$ANDROID_AVD_HOME" > ${JSON.stringify(envLog)}`,
      'name=""',
      'while [ $# -gt 0 ]; do [ "$1" = "-n" ] && name="$2"; shift; done',
      avdmanagerScript,
    ].join("\n"),
  );
  writeExecutable(
    path.join(sdk, "emulator", "emulator"),
    [
      `printf 'ANDROID_AVD_HOME=%s\\n' "$ANDROID_AVD_HOME" > ${JSON.stringify(emulatorLog)}`,
      'for ini in "$ANDROID_AVD_HOME"/*.ini; do [ -f "$ini" ] && basename "$ini" .ini; done',
      "exit 0",
    ].join("\n"),
  );
  writeExecutable(path.join(sdk, "platform-tools", "adb"), "exit 0");
  return { sdk, envLog, emulatorLog };
}

describe("avdHomeDir", () => {
  it("prefers ANDROID_AVD_HOME, then the emulator's user-directory variables, then HOME", () => {
    const home = path.join(tmpRoot, "home");
    expect(avdHomeDir({ HOME: home })).toBe(path.join(home, ".android", "avd"));
    expect(
      avdHomeDir({ HOME: home, ANDROID_SDK_HOME: "/prefs/sdk-home" }),
    ).toBe(path.join("/prefs/sdk-home", ".android", "avd"));
    expect(
      avdHomeDir({
        HOME: home,
        ANDROID_SDK_HOME: "/prefs/sdk-home",
        ANDROID_PREFS_ROOT: "/prefs/root",
      }),
    ).toBe(path.join("/prefs/root", ".android", "avd"));
    expect(
      avdHomeDir({
        HOME: home,
        ANDROID_PREFS_ROOT: "/prefs/root",
        ANDROID_EMULATOR_HOME: "/prefs/emulator-home",
      }),
    ).toBe(path.join("/prefs/emulator-home", "avd"));
    expect(
      avdHomeDir({
        HOME: home,
        ANDROID_EMULATOR_HOME: "/prefs/emulator-home",
        ANDROID_USER_HOME: "/prefs/user-home",
      }),
    ).toBe(path.join("/prefs/user-home", "avd"));
    expect(
      avdHomeDir({
        HOME: home,
        ANDROID_USER_HOME: "/prefs/user-home",
        ANDROID_AVD_HOME: "/prefs/avd",
      }),
    ).toBe("/prefs/avd");
  });

  it("ignores XDG_CONFIG_HOME, which the emulator does not honour", () => {
    const home = path.join(tmpRoot, "home");
    expect(
      avdHomeDir({ HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") }),
    ).toBe(path.join(home, ".android", "avd"));
  });

  it("treats empty variables as unset", () => {
    const home = path.join(tmpRoot, "home");
    expect(avdHomeDir({ HOME: home, ANDROID_AVD_HOME: "" })).toBe(
      path.join(home, ".android", "avd"),
    );
  });

  it("pins every tool to the same directory through avdToolEnv", () => {
    expect(avdToolEnv({ ANDROID_AVD_HOME: "/prefs/avd" })).toEqual({
      ANDROID_AVD_HOME: "/prefs/avd",
    });
  });
});

describe("AVD lookups", () => {
  const avdHome = path.join(tmpRoot, "lookups");
  const dataDir = path.join(tmpRoot, "elsewhere", "lab.avd");
  fs.mkdirSync(avdHome, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(avdHome, "lab.ini"),
    `avd.ini.encoding=UTF-8\npath=${dataDir}\npath.rel=avd/lab.avd\n`,
  );
  fs.writeFileSync(path.join(avdHome, "notes.txt"), "not an avd");
  const env = { ANDROID_AVD_HOME: avdHome };

  it("finds the ini, the data directory from its path entry, and the lock", () => {
    expect(avdIniPath("lab", env)).toBe(path.join(avdHome, "lab.ini"));
    expect(avdExists("lab", env)).toBe(true);
    expect(avdExists("other", env)).toBe(false);
    expect(avdDataDir("lab", env)).toBe(dataDir);
    expect(avdDataDir("other", env)).toBe(path.join(avdHome, "other.avd"));
    expect(avdLockPath("lab", env)).toBe(path.join(dataDir, "hardware-qemu.ini.lock"));
    expect(scanAvdHome(env)).toEqual(["lab"]);
  });

  it("reads the emulator's lock owner pid and ignores garbage", () => {
    const lock = avdLockPath("lab", env);
    expect(readAvdLockOwner("lab", env)).toBeNull();
    fs.writeFileSync(lock, "3245328\0");
    expect(readAvdLockOwner("lab", env)).toBe(3245328);
    fs.writeFileSync(lock, "not-a-pid");
    expect(readAvdLockOwner("lab", env)).toBeNull();
    fs.rmSync(lock);
  });

  it("rejects hostile names before touching the filesystem", () => {
    expect(() => avdIniPath("../etc", env)).toThrow(/Invalid AVD name/);
  });
});

describe("createAvd and the emulator agree on the AVD home", () => {
  it("passes ANDROID_AVD_HOME to avdmanager and verifies the ini landed there", async () => {
    const { sdk, envLog, emulatorLog } = makeFakeSdk(
      'mkdir -p "$ANDROID_AVD_HOME" && : > "$ANDROID_AVD_HOME/$name.ini"',
    );
    const home = path.join(tmpRoot, "agree-home");
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      PATH: "",
    };
    const created = await createAvd({ name: "lab-avd", systemImage: IMAGE, sdk, env });
    const expectedHome = path.join(home, ".android", "avd");
    expect(created.iniPath).toBe(path.join(expectedHome, "lab-avd.ini"));
    expect(fs.existsSync(created.iniPath)).toBe(true);
    expect(fs.readFileSync(envLog, "utf8").trim()).toBe(
      `ANDROID_AVD_HOME=${expectedHome}`,
    );

    expect(await listAvds({ sdk, env })).toEqual(["lab-avd"]);
    expect(fs.readFileSync(emulatorLog, "utf8").trim()).toBe(
      `ANDROID_AVD_HOME=${expectedHome}`,
    );
  });

  it("fails distinctly when avdmanager writes the AVD where the emulator will not look", async () => {
    // Models avdmanager honouring XDG_CONFIG_HOME while ignoring ANDROID_AVD_HOME.
    const { sdk } = makeFakeSdk(
      'mkdir -p "$XDG_CONFIG_HOME/.android/avd" && : > "$XDG_CONFIG_HOME/.android/avd/$name.ini"',
    );
    const home = path.join(tmpRoot, "xdg-home");
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      PATH: "",
    };
    await expect(
      createAvd({ name: "lab-avd", systemImage: IMAGE, sdk, env }),
    ).rejects.toThrow(
      new RegExp(
        `avdmanager reported success for "lab-avd" but ${path.join(home, ".android", "avd", "lab-avd.ini")} does not exist[^\\n]*XDG_CONFIG_HOME`,
      ),
    );
    expect(
      fs.existsSync(path.join(home, ".config", ".android", "avd", "lab-avd.ini")),
    ).toBe(true);
    expect(await listAvds({ sdk, env })).toEqual([]);
  });
});
