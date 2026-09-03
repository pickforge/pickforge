import {
  missingSdkMessage,
  sdkmanagerInstallCommand,
  sdkmanagerPackageInstallCommand,
} from "@pickforge/lab-android";
import type { PickforgeProfile } from "@pickforge/lab-core";
import type { DetectionSnapshot } from "./detect.js";
import { RECOMMENDED_SYSTEM_IMAGE } from "./planner.js";

export type CheckStatus = "ok" | "warn" | "missing";

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

const BASE_CHECKS = ["pickforge-home", "config"] as const;

const DESKTOP_CHECKS = [
  "xvfb",
  "xdotool",
  "screenshot-tool",
] as const;

const ANDROID_CHECKS = [
  "android-sdk",
  "sdkmanager",
  "avdmanager",
  "emulator",
  "adb",
  "system-image",
  "avd",
] as const;

const CMDLINE_TOOLS_INSTALL_COMMAND = sdkmanagerPackageInstallCommand(
  "cmdline-tools;latest",
);
const EMULATOR_INSTALL_COMMAND = sdkmanagerPackageInstallCommand("emulator");
const PLATFORM_TOOLS_INSTALL_COMMAND =
  sdkmanagerPackageInstallCommand("platform-tools");

export const PROFILE_REQUIRED_CHECKS: Record<
  PickforgeProfile,
  readonly string[]
> = {
  generic: [...BASE_CHECKS],
  "flutter-desktop": [...BASE_CHECKS, ...DESKTOP_CHECKS],
  android: [...BASE_CHECKS, ...ANDROID_CHECKS],
  "desktop+android": [...BASE_CHECKS, ...DESKTOP_CHECKS, ...ANDROID_CHECKS],
};

export function requiredChecksForProfile(
  profile: PickforgeProfile,
): readonly string[] {
  return PROFILE_REQUIRED_CHECKS[profile];
}

function pathCheck(
  id: string,
  title: string,
  found: string | null,
  hint: string,
  missingStatus: CheckStatus = "missing",
): DoctorCheck {
  if (found !== null) {
    return { id, title, status: "ok", detail: found };
  }
  return { id, title, status: missingStatus, detail: "not found", hint };
}

function homeChecks(s: DetectionSnapshot): DoctorCheck[] {
  let home: DoctorCheck;
  if (!s.pickforgeHome.exists) {
    home = {
      id: "pickforge-home",
      title: "Pickforge home",
      status: "missing",
      detail: `${s.pickforgeHome.path} does not exist`,
      hint: "run `pickforge-lab doctor --fix` or `pickforge-lab init` to create it",
    };
  } else if (!s.pickforgeHome.writable) {
    home = {
      id: "pickforge-home",
      title: "Pickforge home",
      status: "missing",
      detail: `${s.pickforgeHome.path} is not writable`,
      hint: `fix ownership/permissions of ${s.pickforgeHome.path}`,
    };
  } else {
    home = {
      id: "pickforge-home",
      title: "Pickforge home",
      status: "ok",
      detail: s.pickforgeHome.path,
    };
  }
  if (s.legacyHome === null) return [home];
  return [
    home,
    {
      id: "legacy-home",
      title: "Legacy Pickforge home",
      status: "warn",
      detail: `${s.legacyHome.path} still exists (earlier default)`,
      hint:
        "config, agent state, sessions, and runs there are still read " +
        "non-destructively as a fallback; nothing was moved or deleted",
    },
  ];
}

function storageCheck(s: DetectionSnapshot): DoctorCheck[] {
  if (s.storage.rejectedProjectCustom === null) return [];
  const requested = s.storage.rejectedProjectCustom.requestedPath;
  return [{
    id: "storage-custom-rejected",
    title: "Project config requested custom storage",
    status: "warn",
    detail:
      requested === undefined
        ? "the project's .picklab/config.json requested storage.mode " +
          '"custom" with no path; it was ignored'
        : `the project's .picklab/config.json requested storage.mode ` +
          `"custom" (path: ${requested}); it was ignored`,
    hint:
      "project-committed config cannot select custom storage (it travels " +
      "with git clone); set storage.mode in the global config instead, " +
      "or PICKFORGE_STORAGE_MODE/PICKFORGE_STORAGE_PATH",
  }];
}

function configCheck(s: DetectionSnapshot): DoctorCheck {
  if (s.config.ok) {
    return {
      id: "config",
      title: "Pickforge config",
      status: "ok",
      detail:
        s.config.profile === null
          ? "readable (no profile set)"
          : `readable (profile: ${s.config.profile})`,
    };
  }
  return {
    id: "config",
    title: "Pickforge config",
    status: "missing",
    detail: s.config.error ?? "unreadable",
    hint: "fix or remove the broken config file",
  };
}

function runtimePathChecks(s: DetectionSnapshot): DoctorCheck[] {
  return [
    pathCheck("xvfb", "Xvfb (headless X server)", s.desktop.xvfb,
      "install Xvfb (e.g. xorg-server-xvfb / xvfb package)"),
    pathCheck("xdotool", "xdotool (input synthesis)", s.desktop.xdotool,
      "install xdotool"),
    pathCheck("screenshot-tool", "Screenshot tool", s.desktop.screenshotTool,
      "install ImageMagick (provides `import`) or scrot"),
    pathCheck("x11vnc", "x11vnc (optional live view)", s.desktop.x11vnc,
      "optional: install x11vnc to watch lab sessions live", "warn"),
    pathCheck("android-sdk", "Android SDK", s.android.sdkRoot, missingSdkMessage()),
    pathCheck("sdkmanager", "sdkmanager", s.android.tools.sdkmanager,
      `install command-line tools: ${CMDLINE_TOOLS_INSTALL_COMMAND}`),
    pathCheck("avdmanager", "avdmanager", s.android.tools.avdmanager,
      `install command-line tools: ${CMDLINE_TOOLS_INSTALL_COMMAND}`),
    pathCheck("emulator", "Android emulator", s.android.tools.emulator,
      `install the emulator package: ${EMULATOR_INSTALL_COMMAND}`),
    pathCheck("adb", "adb", s.android.tools.adb,
      `install platform-tools: ${PLATFORM_TOOLS_INSTALL_COMMAND}`),
  ];
}

function systemImageCheck(s: DetectionSnapshot): DoctorCheck {
  if (s.android.systemImages.length > 0) {
    return {
      id: "system-image", title: "Android system images", status: "ok",
      detail: `${s.android.systemImages.length} installed`,
    };
  }
  return {
    id: "system-image", title: "Android system images", status: "missing",
    detail: "no system images installed",
    hint: `install one with: ${sdkmanagerInstallCommand(RECOMMENDED_SYSTEM_IMAGE)}`,
  };
}

function kvmCheck(s: DetectionSnapshot): DoctorCheck {
  if (s.android.kvm.supported) {
    return {
      id: "kvm", title: "KVM hardware acceleration", status: "ok",
      detail: "/dev/kvm is accessible",
    };
  }
  if (s.android.kvm.exists) {
    return {
      id: "kvm", title: "KVM hardware acceleration", status: "warn",
      detail: "/dev/kvm exists but is not accessible",
      hint: "add your user to the kvm group, then log in again",
    };
  }
  return {
    id: "kvm", title: "KVM hardware acceleration", status: "warn",
    detail: "/dev/kvm not found",
    hint: "without KVM the Android emulator will be very slow",
  };
}

function avdCheck(s: DetectionSnapshot): DoctorCheck {
  if (s.android.avdExists) {
    return {
      id: "avd", title: "Dedicated Pickforge AVD", status: "ok",
      detail: s.android.avdName,
    };
  }
  return {
    id: "avd", title: "Dedicated Pickforge AVD", status: "missing",
    detail: `AVD "${s.android.avdName}" not found`,
    hint: `create it with: pickforge-lab setup android --create-avd --avd-name ${s.android.avdName}`,
  };
}

function labUserCheck(s: DetectionSnapshot): DoctorCheck {
  if (s.labUser.exists) {
    return {
      id: "lab-user", title: "Dedicated lab user", status: "ok",
      detail: s.labUser.name,
    };
  }
  return {
    id: "lab-user", title: "Dedicated lab user", status: "warn",
    detail: `user "${s.labUser.name}" not found`,
    hint:
      "optional until session isolation ships: create it with: " +
      `pickforge-lab setup lab-user --name ${s.labUser.name}`,
  };
}

export function evaluateChecks(s: DetectionSnapshot): DoctorCheck[] {
  return [
    ...homeChecks(s),
    ...storageCheck(s),
    configCheck(s),
    ...runtimePathChecks(s),
    systemImageCheck(s),
    kvmCheck(s),
    avdCheck(s),
    labUserCheck(s),
  ];
}

export function formatCheckLine(check: DoctorCheck): string {
  const status = `[${check.status}]`.padEnd(10);
  const line = `${status}${check.id.padEnd(18)}${check.detail}`;
  return check.hint === undefined ? line : `${line}\n${" ".repeat(10)}hint: ${check.hint}`;
}
