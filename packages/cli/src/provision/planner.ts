import path from "node:path";
import {
  buildCreateAvdArgs,
  isValidSystemImageId,
  missingSdkMessage,
  sdkmanagerInstallCommand,
  type SystemImage,
} from "@pickforge/lab-android";
import type { PlanResult, ProvisioningPlan, ProvisioningStep } from "./plan.js";

export const RECOMMENDED_SYSTEM_IMAGE =
  "system-images;android-35;google_apis;x86_64";

export const NOLOGIN_SHELL = "/usr/sbin/nologin";

const LAB_USER_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

export interface LabUserPlanInput {
  name: string;
  home: string;
  userExists: boolean;
  homeExists: boolean;
  kvmPresent: boolean;
}

export function labUserPrivilegeUnavailableMessage(name: string): string {
  return (
    `sudo not found on PATH; cannot provision lab user "${name}". ` +
    `Install sudo, or create the user manually as root: ` +
    `useradd -r -M -s ${NOLOGIN_SHELL} ${name}`
  );
}

export function planLabUser(input: LabUserPlanInput): PlanResult {
  if (!LAB_USER_NAME_PATTERN.test(input.name)) {
    return {
      ok: false,
      error:
        `Invalid lab user name "${input.name}": expected a POSIX user name ` +
        `(lowercase letters, digits, underscores, hyphens; max 32 chars)`,
    };
  }
  if (!path.isAbsolute(input.home) || input.home !== path.normalize(input.home)) {
    return {
      ok: false,
      error: `Invalid lab user home "${input.home}": expected a normalized absolute path`,
    };
  }

  const privilegedSpecs: Array<{
    id: string;
    title: string;
    cmd: string;
    args: string[];
  }> = [];
  if (!input.userExists) {
    privilegedSpecs.push({
      id: "useradd",
      title: `Create locked service user ${input.name}`,
      cmd: "useradd",
      args: ["-r", "-M", "-s", NOLOGIN_SHELL, input.name],
    });
  }
  if (!input.homeExists) {
    privilegedSpecs.push({
      id: "mkdir-home",
      title: `Create lab home ${input.home}`,
      cmd: "mkdir",
      args: ["-p", input.home],
    });
  }
  if (!input.userExists || !input.homeExists) {
    privilegedSpecs.push(
      {
        id: "chown-home",
        title: `Own lab home by ${input.name}`,
        cmd: "chown",
        args: [`${input.name}:${input.name}`, input.home],
      },
      {
        id: "chmod-home",
        title: "Restrict lab home permissions to 750",
        cmd: "chmod",
        args: ["750", input.home],
      },
    );
  }
  if (!input.userExists && input.kvmPresent) {
    privilegedSpecs.push({
      id: "kvm-group",
      title: `Grant ${input.name} access to /dev/kvm`,
      cmd: "usermod",
      args: ["-aG", "kvm", input.name],
    });
  }

  const steps: ProvisioningStep[] = [];
  if (privilegedSpecs.length > 0) {
    steps.push(
      ...privilegedSpecs.map(
        (spec): ProvisioningStep => ({
          id: spec.id,
          title: spec.title,
          kind: "command",
          privileged: true,
          command: { cmd: spec.cmd, args: spec.args },
        }),
      ),
    );
  }
  steps.push({
    id: "persist-lab-user",
    title: "Persist lab user in global PickLab config",
    kind: "write-global-config",
    privileged: false,
    config: { labUser: { name: input.name, home: input.home } },
  });
  return { ok: true, plan: { steps } };
}

const TAG_SCORES: Record<string, number> = {
  google_apis: 3,
  default: 2,
  google_apis_playstore: 1,
};

const ABI_SCORES: Record<string, number> = {
  x86_64: 2,
  x86: 1,
};

function apiLevel(image: SystemImage): number {
  const match = /^android-(\d+)$/.exec(image.api);
  return match === null ? -1 : Number(match[1]);
}

export function chooseSystemImage(
  images: readonly SystemImage[],
): SystemImage | null {
  let best: SystemImage | null = null;
  for (const image of images) {
    if (best === null) {
      best = image;
      continue;
    }
    const tagDiff = (TAG_SCORES[image.tag] ?? 0) - (TAG_SCORES[best.tag] ?? 0);
    if (tagDiff !== 0) {
      if (tagDiff > 0) best = image;
      continue;
    }
    const abiDiff = (ABI_SCORES[image.abi] ?? 0) - (ABI_SCORES[best.abi] ?? 0);
    if (abiDiff !== 0) {
      if (abiDiff > 0) best = image;
      continue;
    }
    if (apiLevel(image) > apiLevel(best)) {
      best = image;
    }
  }
  return best;
}

export interface AvdPlanInput {
  avdName: string;
  systemImage?: string;
  sdkRoot: string | null;
  avdmanagerPath: string | null;
  installedImages: readonly SystemImage[];
  existingAvds: readonly string[];
}

export function planCreateAvd(input: AvdPlanInput): PlanResult {
  const persistStep: ProvisioningStep = {
    id: "persist-avd",
    title: "Persist AVD name in global PickLab config",
    kind: "write-global-config",
    privileged: false,
    config: { android: { avdName: input.avdName } },
  };

  if (input.existingAvds.includes(input.avdName)) {
    return { ok: true, plan: { steps: [persistStep] } };
  }
  if (input.sdkRoot === null) {
    return { ok: false, error: missingSdkMessage() };
  }

  let systemImage: string;
  if (input.systemImage !== undefined) {
    if (!isValidSystemImageId(input.systemImage)) {
      return {
        ok: false,
        error:
          `Invalid system image "${input.systemImage}": expected the form ` +
          `"system-images;android-<api>;<tag>;<abi>"`,
      };
    }
    if (
      !input.installedImages.some(
        (image) => image.packageId === input.systemImage,
      )
    ) {
      return {
        ok: false,
        error:
          `System image "${input.systemImage}" is not installed under ` +
          `${input.sdkRoot}. Install it with: ` +
          sdkmanagerInstallCommand(input.systemImage),
      };
    }
    systemImage = input.systemImage;
  } else {
    const chosen = chooseSystemImage(input.installedImages);
    if (chosen === null) {
      return {
        ok: false,
        error:
          `No Android system images installed under ${input.sdkRoot}. ` +
          `Install one with: ` +
          sdkmanagerInstallCommand(RECOMMENDED_SYSTEM_IMAGE),
      };
    }
    systemImage = chosen.packageId;
  }

  if (input.avdmanagerPath === null) {
    return {
      ok: false,
      error:
        `avdmanager not found under ${input.sdkRoot} or on PATH; install the ` +
        `Android command-line tools ` +
        `(https://developer.android.com/studio#command-line)`,
    };
  }

  let args: string[];
  try {
    args = buildCreateAvdArgs({ name: input.avdName, systemImage });
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  return {
    ok: true,
    plan: {
      steps: [
        {
          id: "create-avd",
          title: `Create AVD ${input.avdName} (${systemImage})`,
          kind: "command",
          privileged: false,
          command: {
            cmd: input.avdmanagerPath,
            args,
            env: {
              ANDROID_HOME: input.sdkRoot,
              ANDROID_SDK_ROOT: input.sdkRoot,
            },
            input: "no\n",
          },
        },
        persistStep,
      ],
    },
  };
}

export interface PickforgeHomePlanInput {
  path: string;
  exists: boolean;
}

export function planPickforgeHome(
  input: PickforgeHomePlanInput,
): ProvisioningPlan {
  if (input.exists) {
    return { steps: [] };
  }
  return {
    steps: [
      {
        id: "pickforge-home",
        title: `Create PickLab home ${input.path}`,
        kind: "mkdir",
        privileged: false,
        dir: input.path,
      },
    ],
  };
}
