import path from "node:path";
import type { EnvLike, PickforgeProfile } from "@pickforge/lab-core";
import { resolveAskpassCapability } from "../provision/askpass.js";
import {
  evaluateChecks,
  formatCheckLine,
  requiredChecksForProfile,
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

export interface InitCliOptions {
  profile?: PickforgeProfile;
  yes?: boolean;
  createLabUser?: boolean;
  createAvd?: boolean;
  dryRun?: boolean;
  json?: boolean;
  projectDir?: string;
}

export interface InitReport {
  ok: boolean;
  /** Mirrors `ExecuteProvisioningResult.status` so `--json` consumers can
   * distinguish a declined/cancelled/sudo-cancelled provisioning run from a
   * generic failure without string-matching `errors`. `"failed"` before an
   * execution ever runs. */
  status: ExecuteProvisioningResult["status"];
  profile: PickforgeProfile;
  projectDir: string;
  dryRun: boolean;
  checks: DoctorCheck[];
  plan: ProvisioningStep[];
  results: StepResult[];
  errors: string[];
}

async function consentTo(
  what: string,
  opts: InitCliOptions,
  remediation: string,
) {
  const answer = await confirm(`Provision ${what}?`, { yes: opts.yes });
  return toConsentDecision(answer, {
    declined: `Required ${what} was declined. ${remediation}`,
    cancelled:
      `Refusing to provision ${what} without consent in a non-interactive ` +
      `session. ${remediation}`,
  });
}

function planAvdProvisioning(
  snapshot: DetectionSnapshot,
  opts: InitCliOptions,
  sections: ProvisioningSection[],
): void {
  const result = planCreateAvd({
    avdName: snapshot.android.avdName,
    sdkRoot: snapshot.android.sdkRoot,
    avdmanagerPath: snapshot.android.tools.avdmanager,
    installedImages: snapshot.android.systemImages,
    existingAvds: snapshot.android.avds,
  });
  if (!result.ok) {
    sections.push({ kind: "blocked", reason: result.error });
    return;
  }
  sections.push({
    kind: "plan",
    plan: result.plan,
    satisfies: "avd",
    consent: {
      decide: () =>
        consentTo(
          `dedicated AVD "${snapshot.android.avdName}" (runs avdmanager)`,
          opts,
          "Re-run with --yes --create-avd or run: pickforge-lab setup android --create-avd",
        ),
    },
  });
}

function planLabUserProvisioning(
  snapshot: DetectionSnapshot,
  opts: InitCliOptions,
  sections: ProvisioningSection[],
): void {
  const result = planLabUser({
    name: snapshot.labUser.name,
    home: snapshot.labUser.home,
    userExists: snapshot.labUser.exists,
    homeExists: snapshot.labUser.homeExists,
    kvmPresent: snapshot.android.kvm.exists,
  });
  if (!result.ok) {
    sections.push({ kind: "blocked", reason: result.error });
    return;
  }
  sections.push({
    kind: "plan",
    plan: result.plan,
    privilegeUnavailable: {
      reason: labUserPrivilegeUnavailableMessage(snapshot.labUser.name),
    },
    consent: {
      decide: () =>
        consentTo(
          `lab user "${snapshot.labUser.name}" (privileged, runs sudo)`,
          opts,
          "Re-run with --yes --create-lab-user or run: pickforge-lab setup lab-user",
        ),
    },
  });
}

// eslint-disable-next-line max-lines-per-function, complexity -- Legacy gate debt: pickforge/pickforge#60
export async function runInit(
  opts: InitCliOptions,
  env: EnvLike = process.env,
): Promise<number> {
  const profile = opts.profile ?? "generic";
  const projectDir = path.resolve(opts.projectDir ?? process.cwd());
  const snapshot = await collectSnapshot({ env, projectDir });
  const allChecks = evaluateChecks(snapshot);
  const requiredIds = requiredChecksForProfile(profile);
  const checks = allChecks.filter((check) => requiredIds.includes(check.id));

  if (opts.json !== true) {
    for (const check of checks) {
      console.log(formatCheckLine(check));
    }
  }

  const sections: ProvisioningSection[] = [
    {
      kind: "plan",
      plan: {
        steps: [
          {
            id: "project-config",
            title: `Write project config (profile: ${profile})`,
            kind: "write-project-config",
            privileged: false,
            config: { profile },
          },
        ],
      },
    },
  ];
  const homePlan = planPickforgeHome({
    path: snapshot.picklabHome.path,
    exists: snapshot.picklabHome.exists,
  });
  if (homePlan.steps.length > 0) {
    sections.push({ kind: "plan", plan: homePlan, satisfies: "pickforge-home" });
  }

  const avdRequired = requiredIds.includes("avd");
  if (!snapshot.android.avdExists && (avdRequired || opts.createAvd === true)) {
    planAvdProvisioning(snapshot, opts, sections);
  }
  if (!snapshot.labUser.exists && opts.createLabUser === true) {
    planLabUserProvisioning(snapshot, opts, sections);
  }

  for (const check of checks) {
    if (check.status !== "missing") continue;
    sections.push({
      kind: "blocked",
      unlessSatisfied: check.id,
      reason:
        `Required check "${check.id}" failed: ${check.detail}.` +
        (check.hint === undefined ? "" : ` Hint: ${check.hint}`),
    });
  }

  const report: InitReport = {
    ok: false,
    status: "failed",
    profile,
    projectDir,
    dryRun: opts.dryRun === true,
    checks,
    plan: [],
    results: [],
    errors: [],
  };

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
  report.plan = execution.plan.steps;
  report.results = execution.results;
  report.ok = execution.ok;
  report.status = execution.status;
  if (!execution.ok) {
    const errors =
      execution.errors.length > 0 ? execution.errors : ["provisioning failed"];
    if (
      execution.results.some(
        (result) => result.id === "project-config" && result.ok,
      )
    ) {
      report.errors.push(
        `${errors[0]}. Project config was written; fix the failed dependency and ` +
          `re-run pickforge-lab init (idempotent), or check pickforge-lab doctor.`,
      );
      report.errors.push(...errors.slice(1));
    } else {
      report.errors.push(...errors);
    }
  }
  emit(report, opts);
  return report.ok ? 0 : 1;
}

function emit(report: InitReport, opts: InitCliOptions): void {
  if (opts.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const error of report.errors) {
    console.error(`error: ${error}`);
  }
  if (report.ok) {
    console.log(
      report.dryRun
        ? `[dry-run] init complete for profile ${report.profile} (no changes made)`
        : `Initialized PickLab project (profile: ${report.profile}) in ${report.projectDir}`,
    );
    if (!report.dryRun) {
      console.log(
        "Next: pickforge-lab agents install <codex|claude-code|cursor|pi> to register " +
          "the MCP server, then pickforge-lab doctor to verify dependencies.",
      );
    }
  }
}
