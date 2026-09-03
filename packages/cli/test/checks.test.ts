import { describe, expect, it } from "vitest";
import {
  evaluateChecks,
  PROFILE_REQUIRED_CHECKS,
  requiredChecksForProfile,
} from "../src/provision/checks.js";
import type { DetectionSnapshot } from "../src/provision/detect.js";

function snapshot(
  overrides: {
    pickforgeHome?: Partial<DetectionSnapshot["pickforgeHome"]>;
    legacyHome?: DetectionSnapshot["legacyHome"];
    storage?: DetectionSnapshot["storage"];
    config?: Partial<DetectionSnapshot["config"]>;
    desktop?: Partial<DetectionSnapshot["desktop"]>;
    android?: Partial<DetectionSnapshot["android"]>;
    labUser?: Partial<DetectionSnapshot["labUser"]>;
    sudo?: string | null;
  } = {},
): DetectionSnapshot {
  return {
    pickforgeHome: {
      path: "/home/u/.pickforge/lab",
      exists: true,
      writable: true,
      ...overrides.pickforgeHome,
    },
    legacyHome: overrides.legacyHome ?? null,
    storage: overrides.storage ?? { rejectedProjectCustom: null },
    config: { ok: true, error: null, profile: null, ...overrides.config },
    desktop: {
      xvfb: "/usr/bin/Xvfb",
      xdotool: "/usr/bin/xdotool",
      screenshotTool: "import",
      x11vnc: "/usr/bin/x11vnc",
      ...overrides.desktop,
    },
    android: {
      sdkRoot: "/sdk",
      tools: {
        sdkmanager: "/sdk/cmdline-tools/latest/bin/sdkmanager",
        avdmanager: "/sdk/cmdline-tools/latest/bin/avdmanager",
        emulator: "/sdk/emulator/emulator",
        adb: "/sdk/platform-tools/adb",
      },
      systemImages: [
        {
          packageId: "system-images;android-34;google_apis;x86_64",
          api: "android-34",
          tag: "google_apis",
          abi: "x86_64",
          path: "/sdk/system-images/android-34/google_apis/x86_64",
        },
      ],
      kvm: { exists: true, readable: true, writable: true, supported: true },
      avdName: "pickforge-avd",
      avds: ["pickforge-avd"],
      avdExists: true,
      ...overrides.android,
    },
    labUser: {
      name: "pickforge-lab",
      home: "/var/lib/pickforge/lab-home",
      exists: true,
      homeExists: true,
      ...overrides.labUser,
    },
    sudo: overrides.sudo === undefined ? "/usr/bin/sudo" : overrides.sudo,
  };
}

function checkById(s: DetectionSnapshot, id: string) {
  const check = evaluateChecks(s).find((entry) => entry.id === id);
  expect(check).toBeDefined();
  return check!;
}

describe("evaluateChecks", () => {
  it("reports everything ok for a fully provisioned machine", () => {
    const checks = evaluateChecks(snapshot());
    expect(checks.every((check) => check.status === "ok")).toBe(true);
  });

  it("flags a missing pickforge-lab home", () => {
    const check = checkById(
      snapshot({ pickforgeHome: { exists: false, writable: false } }),
      "pickforge-home",
    );
    expect(check.status).toBe("missing");
  });

  it("flags an unwritable pickforge-lab home as missing", () => {
    const check = checkById(
      snapshot({ pickforgeHome: { writable: false } }),
      "pickforge-home",
    );
    expect(check.status).toBe("missing");
    expect(check.detail).toContain("not writable");
  });

  it("omits the legacy-home check when there is nothing to report", () => {
    const checks = evaluateChecks(snapshot());
    expect(checks.some((check) => check.id === "legacy-home")).toBe(false);
  });

  it("surfaces a detected legacy ~/.picklab home as a non-blocking warning", () => {
    const check = checkById(
      snapshot({ legacyHome: { path: "/home/u/.picklab" } }),
      "legacy-home",
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("/home/u/.picklab");
    expect(check.hint).toContain("non-destructively");
  });

  it("omits the storage-custom-rejected check when nothing was rejected", () => {
    const checks = evaluateChecks(snapshot());
    expect(
      checks.some((check) => check.id === "storage-custom-rejected"),
    ).toBe(false);
  });

  it("surfaces a rejected project-config custom storage request as a non-blocking warning", () => {
    const check = checkById(
      snapshot({
        storage: {
          rejectedProjectCustom: { requestedPath: "/attacker/path" },
        },
      }),
      "storage-custom-rejected",
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("/attacker/path");
    expect(check.hint).toContain("global config");
  });

  it("surfaces a rejected request even with no requested path", () => {
    const check = checkById(
      snapshot({ storage: { rejectedProjectCustom: {} } }),
      "storage-custom-rejected",
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("no path");
  });

  it("flags a broken config with its parse error", () => {
    const check = checkById(
      snapshot({ config: { ok: false, error: "Invalid PickLab config" } }),
      "config",
    );
    expect(check.status).toBe("missing");
    expect(check.detail).toContain("Invalid PickLab config");
  });

  it("treats x11vnc as optional (warn, not missing)", () => {
    const check = checkById(snapshot({ desktop: { x11vnc: null } }), "x11vnc");
    expect(check.status).toBe("warn");
  });

  it("treats absent KVM as a warning", () => {
    const check = checkById(
      snapshot({
        android: {
          kvm: { exists: false, readable: false, writable: false, supported: false },
        },
      }),
      "kvm",
    );
    expect(check.status).toBe("warn");
    expect(check.hint).toContain("slow");
  });

  it("hints the exact sdkmanager command when system images are missing", () => {
    const check = checkById(
      snapshot({ android: { systemImages: [] } }),
      "system-image",
    );
    expect(check.status).toBe("missing");
    expect(check.hint).toContain(
      'sdkmanager "system-images;android-35;google_apis;x86_64"',
    );
  });

  it("hints the exact sdkmanager command when command-line tools are missing", () => {
    const tools = {
      sdkmanager: null,
      avdmanager: null,
      emulator: "/sdk/emulator/emulator",
      adb: "/sdk/platform-tools/adb",
    };
    const sdkmanagerCheck = checkById(
      snapshot({ android: { tools } }),
      "sdkmanager",
    );
    const avdmanagerCheck = checkById(
      snapshot({ android: { tools } }),
      "avdmanager",
    );

    expect(sdkmanagerCheck.status).toBe("missing");
    expect(sdkmanagerCheck.hint).toContain('sdkmanager "cmdline-tools;latest"');
    expect(avdmanagerCheck.status).toBe("missing");
    expect(avdmanagerCheck.hint).toContain('sdkmanager "cmdline-tools;latest"');
  });

  it("hints exact environment exports when the Android SDK root is missing", () => {
    const check = checkById(
      snapshot({ android: { sdkRoot: null } }),
      "android-sdk",
    );
    expect(check.status).toBe("missing");
    expect(check.hint).toContain('export ANDROID_HOME="$HOME/Android/Sdk"');
    expect(check.hint).toContain('export ANDROID_SDK_ROOT="$ANDROID_HOME"');
  });

  it("flags a missing AVD with a setup hint", () => {
    const check = checkById(
      snapshot({ android: { avds: [], avdExists: false } }),
      "avd",
    );
    expect(check.status).toBe("missing");
    expect(check.hint).toContain("pickforge-lab setup android --create-avd");
  });

  it("treats a missing lab user as an optional warning", () => {
    const check = checkById(snapshot({ labUser: { exists: false } }), "lab-user");
    expect(check.status).toBe("warn");
    expect(check.hint).toContain("optional until session isolation ships");
    expect(check.hint).toContain("pickforge-lab setup lab-user");
  });
});

describe("requiredChecksForProfile", () => {
  it("keeps generic projects to home and config", () => {
    expect(requiredChecksForProfile("generic")).toEqual([
      "pickforge-home",
      "config",
    ]);
  });

  it("requires desktop tooling for flutter-desktop", () => {
    const ids = requiredChecksForProfile("flutter-desktop");
    expect(ids).toContain("xvfb");
    expect(ids).toContain("xdotool");
    expect(ids).toContain("screenshot-tool");
    expect(ids).not.toContain("lab-user");
    expect(ids).not.toContain("android-sdk");
    expect(ids).not.toContain("x11vnc");
  });

  it("requires the android toolchain and AVD for android", () => {
    const ids = requiredChecksForProfile("android");
    expect(ids).toEqual(
      expect.arrayContaining([
        "android-sdk",
        "sdkmanager",
        "avdmanager",
        "emulator",
        "adb",
        "system-image",
        "avd",
      ]),
    );
    expect(ids).not.toContain("xvfb");
    expect(ids).not.toContain("kvm");
  });

  it("unions desktop and android for desktop+android", () => {
    const ids = requiredChecksForProfile("desktop+android");
    expect(ids).toContain("xvfb");
    expect(ids).toContain("avd");
    expect(ids).not.toContain("lab-user");
  });

  it("does not require the lab user for any profile", () => {
    expect(PROFILE_REQUIRED_CHECKS.generic).not.toContain("lab-user");
    expect(PROFILE_REQUIRED_CHECKS.android).not.toContain("lab-user");
    expect(PROFILE_REQUIRED_CHECKS["flutter-desktop"]).not.toContain("lab-user");
    expect(PROFILE_REQUIRED_CHECKS["desktop+android"]).not.toContain("lab-user");
  });

  it("covers every profile", () => {
    expect(Object.keys(PROFILE_REQUIRED_CHECKS).sort()).toEqual([
      "android",
      "desktop+android",
      "flutter-desktop",
      "generic",
    ]);
  });
});
