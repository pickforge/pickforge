import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  commonSdkPaths,
  detectAndroidEnvironment,
  detectKvm,
  detectSdkRoot,
  detectSdkTools,
  findSdkTool,
  listSystemImages,
  missingSdkMessage,
  resolveSdkRoot,
  sdkmanagerInstallCommand,
  sdkmanagerPackageInstallCommand,
  systemImageInstalled,
} from "../src/index.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-android-sdk-"));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeDir(...segments: string[]): string {
  const dir = path.join(tmpRoot, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function makeFakeSdk(name: string): string {
  const sdk = makeDir(name);
  writeExecutable(path.join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager"));
  writeExecutable(path.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"));
  writeExecutable(path.join(sdk, "emulator", "emulator"));
  writeExecutable(path.join(sdk, "platform-tools", "adb"));
  return sdk;
}

describe("detectSdkRoot", () => {
  it("prefers ANDROID_HOME over ANDROID_SDK_ROOT", () => {
    const home = makeDir("sdk-home");
    const root = makeDir("sdk-root");
    expect(
      detectSdkRoot({
        env: { ANDROID_HOME: home, ANDROID_SDK_ROOT: root },
        commonPaths: [],
      }),
    ).toBe(home);
  });

  it("skips a nonexistent ANDROID_HOME and uses ANDROID_SDK_ROOT", () => {
    const root = makeDir("sdk-root2");
    expect(
      detectSdkRoot({
        env: {
          ANDROID_HOME: path.join(tmpRoot, "does-not-exist"),
          ANDROID_SDK_ROOT: root,
        },
        commonPaths: [],
      }),
    ).toBe(root);
  });

  it("falls back to the first existing common path", () => {
    const common = makeDir("common", "Android", "Sdk");
    expect(
      detectSdkRoot({
        env: {},
        commonPaths: [path.join(tmpRoot, "missing"), common],
      }),
    ).toBe(common);
  });

  it("derives common paths from the home directory", () => {
    const home = path.join(tmpRoot, "userhome");
    expect(commonSdkPaths(home)).toEqual([
      path.join(home, "Android", "Sdk"),
      path.join(home, "Library", "Android", "sdk"),
      "/opt/android-sdk",
    ]);
  });

  it("returns null when nothing is found, with an actionable message available", () => {
    expect(detectSdkRoot({ env: {}, commonPaths: [] })).toBeNull();
    const message = missingSdkMessage();
    expect(message).toMatch(/ANDROID_HOME/);
    expect(message).toContain('export ANDROID_HOME="$HOME/Android/Sdk"');
    expect(message).toContain('export ANDROID_SDK_ROOT="$ANDROID_HOME"');
    expect(message).toMatch(/developer\.android\.com/);
  });

  it("ignores an ANDROID_HOME pointing at a regular file", () => {
    const filePath = path.join(tmpRoot, "not-a-dir");
    fs.writeFileSync(filePath, "x");
    expect(
      detectSdkRoot({ env: { ANDROID_HOME: filePath }, commonPaths: [] }),
    ).toBeNull();
  });
});

describe("findSdkTool / detectSdkTools", () => {
  it("finds all tools in a complete fake sdk", () => {
    const sdk = makeFakeSdk("sdk-complete");
    const tools = detectSdkTools({ sdk, env: { PATH: "" } });
    expect(tools.sdkmanager).toBe(
      path.join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager"),
    );
    expect(tools.avdmanager).toBe(
      path.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
    );
    expect(tools.emulator).toBe(path.join(sdk, "emulator", "emulator"));
    expect(tools.adb).toBe(path.join(sdk, "platform-tools", "adb"));
  });

  it("falls back to tools/bin for legacy sdk layouts", () => {
    const sdk = makeDir("sdk-legacy");
    writeExecutable(path.join(sdk, "tools", "bin", "avdmanager"));
    expect(findSdkTool(sdk, "avdmanager", { PATH: "" })).toBe(
      path.join(sdk, "tools", "bin", "avdmanager"),
    );
  });

  it("falls back to PATH for adb when the sdk lacks platform-tools", () => {
    const sdk = makeDir("sdk-no-pt");
    const bin = makeDir("fake-path-bin");
    writeExecutable(path.join(bin, "adb"));
    expect(findSdkTool(sdk, "adb", { PATH: bin })).toBe(path.join(bin, "adb"));
    expect(findSdkTool(null, "adb", { PATH: bin })).toBe(path.join(bin, "adb"));
  });

  it("returns null for tools missing everywhere", () => {
    const sdk = makeDir("sdk-empty");
    const tools = detectSdkTools({ sdk, env: { PATH: "" } });
    expect(tools).toEqual({
      sdkmanager: null,
      avdmanager: null,
      emulator: null,
      adb: null,
    });
  });

  it("ignores non-executable tool files", () => {
    const sdk = makeDir("sdk-noexec");
    const adbPath = path.join(sdk, "platform-tools", "adb");
    fs.mkdirSync(path.dirname(adbPath), { recursive: true });
    fs.writeFileSync(adbPath, "not executable", { mode: 0o644 });
    expect(findSdkTool(sdk, "adb", { PATH: "" })).toBeNull();
  });

  it("probes versioned cmdline-tools dirs, picking the highest version", () => {
    const sdk = makeDir("sdk-versioned");
    writeExecutable(path.join(sdk, "cmdline-tools", "9.0", "bin", "sdkmanager"));
    writeExecutable(path.join(sdk, "cmdline-tools", "16.0", "bin", "sdkmanager"));
    expect(findSdkTool(sdk, "sdkmanager", { PATH: "" })).toBe(
      path.join(sdk, "cmdline-tools", "16.0", "bin", "sdkmanager"),
    );
  });

  it("prefers cmdline-tools/latest over versioned dirs", () => {
    const sdk = makeDir("sdk-latest-first");
    writeExecutable(path.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"));
    writeExecutable(path.join(sdk, "cmdline-tools", "16.0", "bin", "avdmanager"));
    expect(findSdkTool(sdk, "avdmanager", { PATH: "" })).toBe(
      path.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
    );
  });

  it("falls back to a bare cmdline-tools/bin layout", () => {
    const sdk = makeDir("sdk-bare-cmdline");
    writeExecutable(path.join(sdk, "cmdline-tools", "bin", "sdkmanager"));
    expect(findSdkTool(sdk, "sdkmanager", { PATH: "" })).toBe(
      path.join(sdk, "cmdline-tools", "bin", "sdkmanager"),
    );
  });

  it("auto-detects the sdk root when sdk is undefined, but not for null", () => {
    const sdk = makeFakeSdk("sdk-undefined-detect");
    const env = { ANDROID_HOME: sdk, PATH: "" };
    expect(resolveSdkRoot(undefined, env)).toBe(sdk);
    expect(resolveSdkRoot(null, env)).toBeNull();
    expect(resolveSdkRoot(sdk, { PATH: "" })).toBe(sdk);
    expect(findSdkTool(undefined, "emulator", env)).toBe(
      path.join(sdk, "emulator", "emulator"),
    );
    expect(findSdkTool(undefined, "adb", env)).toBe(
      path.join(sdk, "platform-tools", "adb"),
    );
    expect(findSdkTool(null, "emulator", env)).toBeNull();
  });
});

describe("listSystemImages", () => {
  it("parses the system-images directory tree", () => {
    const sdk = makeDir("sdk-images");
    makeDir("sdk-images", "system-images", "android-34", "google_apis", "x86_64");
    makeDir("sdk-images", "system-images", "android-34", "google_apis", "arm64-v8a");
    makeDir("sdk-images", "system-images", "android-30", "default", "x86_64");
    fs.writeFileSync(
      path.join(sdk, "system-images", "android-34", "stray-file"),
      "x",
    );

    const images = listSystemImages(sdk);
    expect(images.map((image) => image.packageId)).toEqual([
      "system-images;android-30;default;x86_64",
      "system-images;android-34;google_apis;arm64-v8a",
      "system-images;android-34;google_apis;x86_64",
    ]);
    expect(images[0]).toMatchObject({
      api: "android-30",
      tag: "default",
      abi: "x86_64",
    });
  });

  it("returns an empty list when system-images is absent", () => {
    const sdk = makeDir("sdk-no-images");
    expect(listSystemImages(sdk)).toEqual([]);
  });

  it("follows symlinked directories so listing matches systemImageInstalled", () => {
    const external = makeDir("external-google-apis");
    makeDir("external-google-apis", "x86_64");
    const sdk = makeDir("sdk-symlinked");
    makeDir("sdk-symlinked", "system-images", "android-34");
    fs.symlinkSync(
      external,
      path.join(sdk, "system-images", "android-34", "google_apis"),
    );
    const packageId = "system-images;android-34;google_apis;x86_64";
    expect(listSystemImages(sdk).map((image) => image.packageId)).toEqual([
      packageId,
    ]);
    expect(systemImageInstalled(sdk, packageId)).toBe(true);
  });

  it("reports installation state for a specific image", () => {
    const sdk = makeDir("sdk-installed");
    makeDir("sdk-installed", "system-images", "android-34", "google_apis", "x86_64");
    expect(
      systemImageInstalled(sdk, "system-images;android-34;google_apis;x86_64"),
    ).toBe(true);
    expect(
      systemImageInstalled(sdk, "system-images;android-35;google_apis;x86_64"),
    ).toBe(false);
  });
});

describe("sdkmanagerInstallCommand", () => {
  it("returns the exact sdkmanager command for an image id", () => {
    expect(
      sdkmanagerInstallCommand("system-images;android-34;google_apis;x86_64"),
    ).toBe('sdkmanager "system-images;android-34;google_apis;x86_64"');
  });

  it("rejects malformed image ids", () => {
    expect(() => sdkmanagerInstallCommand("platform-tools")).toThrow(
      /Invalid system image/,
    );
    expect(() =>
      sdkmanagerInstallCommand('system-images;android-34;"$(reboot)";x86_64 extra'),
    ).toThrow(/Invalid system image/);
  });
});

describe("sdkmanagerPackageInstallCommand", () => {
  it("returns the exact sdkmanager command for known SDK package ids", () => {
    expect(sdkmanagerPackageInstallCommand("cmdline-tools;latest")).toBe(
      'sdkmanager "cmdline-tools;latest"',
    );
    expect(sdkmanagerPackageInstallCommand("platform-tools")).toBe(
      'sdkmanager "platform-tools"',
    );
    expect(sdkmanagerPackageInstallCommand("emulator")).toBe(
      'sdkmanager "emulator"',
    );
  });

  it("rejects unsafe SDK package ids", () => {
    expect(() =>
      sdkmanagerPackageInstallCommand('cmdline-tools;"$(reboot)"'),
    ).toThrow(/Invalid Android SDK package/);
    expect(() =>
      sdkmanagerPackageInstallCommand("platform-tools extra"),
    ).toThrow(/Invalid Android SDK package/);
  });
});

describe("detectKvm", () => {
  it("reports an accessible fake kvm node as supported", () => {
    const kvmPath = path.join(makeDir("dev"), "kvm");
    fs.writeFileSync(kvmPath, "", { mode: 0o660 });
    const status = detectKvm(kvmPath);
    expect(status).toEqual({
      exists: true,
      readable: true,
      writable: true,
      supported: true,
    });
  });

  it("reports a missing kvm node as unsupported", () => {
    expect(detectKvm(path.join(tmpRoot, "no-kvm"))).toEqual({
      exists: false,
      readable: false,
      writable: false,
      supported: false,
    });
  });

  it("reports an inaccessible kvm node as unsupported", () => {
    const kvmPath = path.join(makeDir("dev-locked"), "kvm");
    fs.writeFileSync(kvmPath, "", { mode: 0o000 });
    const status = detectKvm(kvmPath);
    expect(status.exists).toBe(true);
    expect(status.supported).toBe(false);
  });
});

describe("detectAndroidEnvironment", () => {
  it("aggregates sdk root, tools, images, and kvm", () => {
    const sdk = makeFakeSdk("sdk-aggregate");
    makeDir("sdk-aggregate", "system-images", "android-34", "google_apis", "x86_64");
    const kvmPath = path.join(makeDir("dev-agg"), "kvm");
    fs.writeFileSync(kvmPath, "", { mode: 0o660 });

    const detected = detectAndroidEnvironment({
      env: { ANDROID_HOME: sdk, PATH: "" },
      commonPaths: [],
      kvmPath,
    });
    expect(detected.sdkRoot).toBe(sdk);
    expect(detected.tools.emulator).toBe(path.join(sdk, "emulator", "emulator"));
    expect(detected.systemImages).toHaveLength(1);
    expect(detected.kvm.supported).toBe(true);
  });

  it("returns nulls and empties when nothing is installed", () => {
    const detected = detectAndroidEnvironment({
      env: { PATH: "" },
      commonPaths: [],
      kvmPath: path.join(tmpRoot, "no-kvm-2"),
    });
    expect(detected.sdkRoot).toBeNull();
    expect(detected.tools.adb).toBeNull();
    expect(detected.systemImages).toEqual([]);
    expect(detected.kvm.supported).toBe(false);
  });
});
