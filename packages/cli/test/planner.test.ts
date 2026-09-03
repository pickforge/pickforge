import { describe, expect, it } from "vitest";
import type { SystemImage } from "@pickforge/lab-android";
import type {
  PickforgeConfig,
} from "@pickforge/lab-core";
import type { ProvisioningStep, StepCommand } from "../src/provision/plan.js";
import {
  chooseSystemImage,
  planCreateAvd,
  planLabUser,
  planPickforgeHome,
  RECOMMENDED_SYSTEM_IMAGE,
} from "../src/provision/planner.js";

function commandOf(step: ProvisioningStep): StepCommand {
  expect(step.kind).toBe("command");
  if (step.kind !== "command") throw new Error("unreachable");
  return step.command;
}

function configOf(step: ProvisioningStep): PickforgeConfig {
  if (
    step.kind !== "write-global-config" &&
    step.kind !== "write-project-config"
  ) {
    throw new Error(`expected a config step, got ${step.kind}`);
  }
  return step.config;
}

function image(packageId: string): SystemImage {
  const [, api, tag, abi] = packageId.split(";") as [
    string,
    string,
    string,
    string,
  ];
  return { packageId, api, tag, abi, path: `/sdk/system-images/${api}/${tag}/${abi}` };
}

const baseLabUser = {
  name: "pickforge-lab",
  home: "/var/lib/pickforge/lab-home",
  userExists: false,
  homeExists: false,
  kvmPresent: true,
};

describe("planLabUser", () => {
  it("plans full creation when the user is missing and kvm is present", () => {
    const result = planLabUser(baseLabUser);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((step) => step.id)).toEqual([
      "useradd",
      "mkdir-home",
      "chown-home",
      "chmod-home",
      "kvm-group",
      "persist-lab-user",
    ]);
    const useradd = result.plan.steps[0]!;
    expect(useradd.privileged).toBe(true);
    expect(commandOf(useradd)).toEqual({
      cmd: "useradd",
      args: ["-r", "-M", "-s", "/usr/sbin/nologin", "pickforge-lab"],
    });
    expect(commandOf(result.plan.steps[3]!).args).toEqual([
      "750",
      "/var/lib/pickforge/lab-home",
    ]);
    expect(commandOf(result.plan.steps[4]!).args).toEqual([
      "-aG",
      "kvm",
      "pickforge-lab",
    ]);
    const persist = result.plan.steps[5]!;
    expect(persist.kind).toBe("write-global-config");
    expect(persist.privileged).toBe(false);
    expect(configOf(persist)).toEqual({
      labUser: { name: "pickforge-lab", home: "/var/lib/pickforge/lab-home" },
    });
  });

  it("omits the kvm group when /dev/kvm is absent", () => {
    const result = planLabUser({ ...baseLabUser, kvmPresent: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.some((step) => step.id === "kvm-group")).toBe(
      false,
    );
  });

  it("keeps every privileged command free of sudo routing", () => {
    const result = planLabUser(baseLabUser);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const commands = result.plan.steps
      .filter((step) => step.kind === "command")
      .map(commandOf);
    expect(commands.map((command) => command.cmd)).toEqual([
      "useradd",
      "mkdir",
      "chown",
      "chmod",
      "usermod",
    ]);
    expect(JSON.stringify(commands)).not.toContain("sudo");
  });

  it("is a config-only no-op when user and home already exist", () => {
    const result = planLabUser({
      ...baseLabUser,
      userExists: true,
      homeExists: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((step) => step.id)).toEqual([
      "persist-lab-user",
    ]);
    expect(result.plan.steps.some((step) => step.privileged)).toBe(false);
  });

  it("repairs the home when the user exists but the home is missing", () => {
    const result = planLabUser({ ...baseLabUser, userExists: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((step) => step.id)).toEqual([
      "mkdir-home",
      "chown-home",
      "chmod-home",
      "persist-lab-user",
    ]);
    expect(
      result.plan.steps
        .filter((step) => step.kind === "command")
        .every((step) => step.privileged),
    ).toBe(true);
    expect(result.plan.steps.at(-1)?.privileged).toBe(false);
  });

  it("rejects invalid user names", () => {
    const result = planLabUser({ ...baseLabUser, name: "bad name; rm -rf" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Invalid lab user name");
  });

  it("rejects relative home paths", () => {
    const result = planLabUser({ ...baseLabUser, home: "relative/home" });
    expect(result.ok).toBe(false);
  });
});

describe("chooseSystemImage", () => {
  it("returns null for an empty list", () => {
    expect(chooseSystemImage([])).toBeNull();
  });

  it("prefers google_apis over default and playstore tags", () => {
    const chosen = chooseSystemImage([
      image("system-images;android-35;google_apis_playstore;x86_64"),
      image("system-images;android-34;google_apis;x86_64"),
      image("system-images;android-35;default;x86_64"),
    ]);
    expect(chosen?.packageId).toBe("system-images;android-34;google_apis;x86_64");
  });

  it("prefers x86_64 and higher API levels", () => {
    const chosen = chooseSystemImage([
      image("system-images;android-33;google_apis;x86_64"),
      image("system-images;android-35;google_apis;x86"),
      image("system-images;android-35;google_apis;x86_64"),
    ]);
    expect(chosen?.packageId).toBe("system-images;android-35;google_apis;x86_64");
  });
});

const baseAvd = {
  avdName: "pickforge-avd",
  sdkRoot: "/sdk",
  avdmanagerPath: "/sdk/cmdline-tools/latest/bin/avdmanager",
  installedImages: [image("system-images;android-34;google_apis;x86_64")],
  existingAvds: [] as string[],
};

describe("planCreateAvd", () => {
  it("is a config-only no-op when the AVD already exists", () => {
    const result = planCreateAvd({
      ...baseAvd,
      existingAvds: ["pickforge-avd"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((step) => step.id)).toEqual(["persist-avd"]);
  });

  it("fails with an actionable message when the SDK is missing", () => {
    const result = planCreateAvd({ ...baseAvd, sdkRoot: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Android SDK not found");
  });

  it("emits the exact sdkmanager command when the requested image is missing", () => {
    const result = planCreateAvd({
      ...baseAvd,
      systemImage: "system-images;android-35;google_apis;arm64-v8a",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      'sdkmanager "system-images;android-35;google_apis;arm64-v8a"',
    );
  });

  it("emits the recommended sdkmanager command when no images are installed", () => {
    const result = planCreateAvd({ ...baseAvd, installedImages: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(`sdkmanager "${RECOMMENDED_SYSTEM_IMAGE}"`);
  });

  it("fails when avdmanager is unavailable", () => {
    const result = planCreateAvd({ ...baseAvd, avdmanagerPath: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("avdmanager not found");
  });

  it("plans an unprivileged avdmanager run plus config persistence", () => {
    const result = planCreateAvd(baseAvd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps.map((step) => step.id)).toEqual([
      "create-avd",
      "persist-avd",
    ]);
    const create = result.plan.steps[0]!;
    expect(create.privileged).toBe(false);
    expect(commandOf(create)).toEqual({
      cmd: "/sdk/cmdline-tools/latest/bin/avdmanager",
      args: [
        "create",
        "avd",
        "-n",
        "pickforge-avd",
        "-k",
        "system-images;android-34;google_apis;x86_64",
      ],
      env: { ANDROID_HOME: "/sdk", ANDROID_SDK_ROOT: "/sdk" },
      input: "no\n",
    });
    expect(configOf(result.plan.steps[1]!)).toEqual({
      android: { avdName: "pickforge-avd" },
    });
  });

  it("rejects invalid AVD names", () => {
    const result = planCreateAvd({ ...baseAvd, avdName: "-bad name" });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed system image ids", () => {
    const result = planCreateAvd({ ...baseAvd, systemImage: "not-an-image" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Invalid system image");
  });
});

describe("planPickforgeHome", () => {
  it("plans a mkdir when the home is missing", () => {
    const plan = planPickforgeHome({ path: "/tmp/x/.picklab", exists: false });
    expect(plan.steps).toEqual([
      {
        id: "pickforge-home",
        title: "Create PickLab home /tmp/x/.picklab",
        kind: "mkdir",
        privileged: false,
        dir: "/tmp/x/.picklab",
      },
    ]);
  });

  it("is a no-op when the home exists", () => {
    expect(planPickforgeHome({ path: "/tmp/x", exists: true }).steps).toEqual([]);
  });
});
