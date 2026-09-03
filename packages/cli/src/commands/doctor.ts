import type { EnvLike } from "@pickforge/lab-core";
import { resolveAskpassCapability } from "../provision/askpass.js";
import {
  evaluateChecks,
  formatCheckLine,
  type DoctorCheck,
} from "../provision/checks.js";
import { collectSnapshot, type DetectionSnapshot } from "../provision/detect.js";
import {
  executeProvisioning,
  type ExecuteProvisioningResult,
  type ProvisioningSection,
  type StepResult,
} from "../provision/executor.js";
import type { ProvisioningStep } from "../provision/plan.js";
import {
  labUserPrivilegeUnavailableMessage,
  planCreateAvd,
  planLabUser,
  planPickforgeHome,
} from "../provision/planner.js";
import { confirm, toConsentDecision } from "../provision/prompts.js";

export interface DoctorCliOptions {
  json?: boolean;
  fix?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  projectDir?: string;
}

export interface DoctorFixReport {
  dryRun: boolean;
  /** Mirrors `ExecuteProvisioningResult.status` so `--json` consumers can
   * distinguish a declined/cancelled/sudo-cancelled fix run from a generic
   * failure without string-matching `steps`/errors. */
  status: ExecuteProvisioningResult["status"];
  steps: ProvisioningStep[];
  skipped: string[];
  results: StepResult[];
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  errors: string[];
  fix?: DoctorFixReport;
}

async function buildFixPlan(
  snapshot: DetectionSnapshot,
  opts: DoctorCliOptions,
): Promise<ProvisioningSection[]> {
  const sections: ProvisioningSection[] = [];
  const consentHint =
    "skipped (requires consent; re-run with --yes or confirm interactively)";

  sections.push({
    kind: "plan",
    plan: planPickforgeHome({
      path: snapshot.picklabHome.path,
      exists: snapshot.picklabHome.exists,
    }),
  });

  if (!snapshot.android.avdExists) {
    const result = planCreateAvd({
      avdName: snapshot.android.avdName,
      sdkRoot: snapshot.android.sdkRoot,
      avdmanagerPath: snapshot.android.tools.avdmanager,
      installedImages: snapshot.android.systemImages,
      existingAvds: snapshot.android.avds,
    });
    if (!result.ok) {
      sections.push({
        kind: "blocked",
        action: "skip",
        reason: `avd: ${result.error}`,
      });
    } else {
      sections.push({
        kind: "plan",
        plan: result.plan,
        consent: {
          onDenied: "skip",
          decide: async () => {
            const answer = await confirm(
              `Create AVD "${snapshot.android.avdName}" (runs avdmanager)?`,
              { yes: opts.yes },
            );
            return toConsentDecision(answer, {
              declined: `avd: ${consentHint}`,
              cancelled: `avd: ${consentHint}`,
            });
          },
        },
      });
    }
  }

  if (!snapshot.labUser.exists) {
    const result = planLabUser({
      name: snapshot.labUser.name,
      home: snapshot.labUser.home,
      userExists: snapshot.labUser.exists,
      homeExists: snapshot.labUser.homeExists,
      kvmPresent: snapshot.android.kvm.exists,
    });
    if (!result.ok) {
      sections.push({
        kind: "blocked",
        action: "skip",
        reason: `lab-user: ${result.error}`,
      });
    } else {
      sections.push({
        kind: "plan",
        plan: result.plan,
        privilegeUnavailable: {
          action: "skip",
          reason: `lab-user: ${labUserPrivilegeUnavailableMessage(
            snapshot.labUser.name,
          )}`,
          context: "lab-user: ",
        },
        consent: {
          onDenied: "skip",
          decide: async () => {
            const answer = await confirm(
              `Create lab user "${snapshot.labUser.name}" (privileged, runs sudo)?`,
              { yes: opts.yes },
            );
            return toConsentDecision(answer, {
              declined: `lab-user: ${consentHint}`,
              cancelled: `lab-user: ${consentHint}`,
            });
          },
        },
      });
    }
  }

  return sections;
}

export async function runDoctor(
  opts: DoctorCliOptions,
  env: EnvLike = process.env,
): Promise<number> {
  const projectDir = opts.projectDir ?? process.cwd();
  const snapshot = await collectSnapshot({ env, projectDir });
  const checks = evaluateChecks(snapshot);
  const report: DoctorReport = {
    ok: !checks.some((check) => check.status === "missing"),
    checks,
    errors: [],
  };

  if (opts.json !== true) {
    for (const check of checks) {
      console.log(formatCheckLine(check));
    }
  }

  let exitCode = 0;
  if (opts.fix === true) {
    const sections = await buildFixPlan(snapshot, opts);
    const log =
      opts.json === true ? () => {} : (line: string) => console.log(line);
    const execution = await executeProvisioning(
      sections,
      {
        dryRun: opts.dryRun,
        env,
        projectDir,
        log,
        privilege: {
          sudoPath: snapshot.sudo,
          askpass: resolveAskpassCapability(env),
        },
      },
    );
    report.fix = {
      dryRun: opts.dryRun === true,
      status: execution.status,
      steps: execution.plan.steps,
      skipped: execution.skipped,
      results: execution.results,
    };
    if (!execution.ok) {
      report.errors.push(...execution.errors);
      exitCode = 1;
    }
  }

  if (opts.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (report.fix !== undefined) {
      for (const entry of report.fix.skipped) {
        console.log(`[skipped] ${entry}`);
      }
    }
    for (const error of report.errors) {
      console.error(`error: ${error}`);
    }
  }
  return exitCode;
}
