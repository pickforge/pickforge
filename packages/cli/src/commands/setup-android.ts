import { sdkmanagerInstallCommand } from "@pickforge/lab-android";
import type { EnvLike } from "@pickforge/lab-core";
import { collectSnapshot, type DetectionSnapshot } from "../provision/detect.js";
import {
  executeProvisioning,
  type StepResult,
} from "../provision/executor.js";
import type { ProvisioningStep } from "../provision/plan.js";
import {
  planCreateAvd,
  RECOMMENDED_SYSTEM_IMAGE,
} from "../provision/planner.js";
import { confirm, toConsentDecision } from "../provision/prompts.js";

export interface SetupAndroidCliOptions {
  createAvd?: boolean;
  avdName?: string;
  systemImage?: string;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface SetupAndroidReport {
  ok: boolean;
  sdkRoot: string | null;
  tools: DetectionSnapshot["android"]["tools"];
  systemImages: string[];
  kvm: DetectionSnapshot["android"]["kvm"];
  avdName: string;
  avds: string[];
  avdExists: boolean;
  dryRun: boolean;
  plan: ProvisioningStep[];
  results: StepResult[];
  errors: string[];
}

function describe(report: SetupAndroidReport): string[] {
  const lines = [
    `Android SDK:    ${report.sdkRoot ?? "not found"}`,
    `sdkmanager:     ${report.tools.sdkmanager ?? "not found"}`,
    `avdmanager:     ${report.tools.avdmanager ?? "not found"}`,
    `emulator:       ${report.tools.emulator ?? "not found"}`,
    `adb:            ${report.tools.adb ?? "not found"}`,
    `system images:  ${
      report.systemImages.length > 0
        ? report.systemImages.join(", ")
        : "none installed"
    }`,
    `KVM:            ${report.kvm.supported ? "available" : "unavailable"}`,
    `AVDs:           ${report.avds.length > 0 ? report.avds.join(", ") : "none"}`,
  ];
  if (report.systemImages.length === 0) {
    lines.push(
      `hint: install a system image with: ` +
        sdkmanagerInstallCommand(RECOMMENDED_SYSTEM_IMAGE),
    );
  }
  return lines;
}

function emit(report: SetupAndroidReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const line of describe(report)) {
    console.log(line);
  }
  for (const error of report.errors) {
    console.error(`error: ${error}`);
  }
}

export async function runSetupAndroid(
  opts: SetupAndroidCliOptions,
  env: EnvLike = process.env,
): Promise<number> {
  const snapshot = await collectSnapshot({ env, avdName: opts.avdName });
  const android = snapshot.android;
  const report: SetupAndroidReport = {
    ok: true,
    sdkRoot: android.sdkRoot,
    tools: android.tools,
    systemImages: android.systemImages.map((image) => image.packageId),
    kvm: android.kvm,
    avdName: android.avdName,
    avds: android.avds,
    avdExists: android.avdExists,
    dryRun: opts.dryRun === true,
    plan: [],
    results: [],
    errors: [],
  };

  if (opts.createAvd !== true) {
    emit(report, opts.json === true);
    return 0;
  }

  const result = planCreateAvd({
    avdName: android.avdName,
    systemImage: opts.systemImage,
    sdkRoot: android.sdkRoot,
    avdmanagerPath: android.tools.avdmanager,
    installedImages: android.systemImages,
    existingAvds: android.avds,
  });
  if (!result.ok) {
    report.ok = false;
    report.errors.push(result.error);
    emit(report, opts.json === true);
    return 1;
  }
  report.plan = result.plan.steps;

  const log =
    opts.json === true ? () => {} : (line: string) => console.log(line);
  if (opts.json !== true && android.avdExists) {
    console.log(`AVD "${android.avdName}" already exists.`);
  }
  const execution = await executeProvisioning(
    [
      {
        kind: "plan",
        plan: result.plan,
        consent: {
          retainPlanOnDenied: true,
          decide: async () => {
            const answer = await confirm(`Create AVD "${android.avdName}"?`, {
              yes: opts.yes,
            });
            return toConsentDecision(answer, {
              declined: "Aborted: AVD creation was declined.",
              cancelled:
                "Refusing to create the AVD without consent in a " +
                "non-interactive session. Re-run with --yes.",
            });
          },
        },
      },
    ],
    { dryRun: opts.dryRun, env, log },
  );
  report.plan = execution.plan.steps;
  report.results = execution.results;
  report.ok = execution.ok;
  if (!execution.ok) {
    report.errors.push(execution.error ?? "provisioning failed");
  }
  emit(report, opts.json === true);
  return execution.ok ? 0 : 1;
}
