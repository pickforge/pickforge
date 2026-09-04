import type { EnvLike } from "@pickforge/lab-core";
import { resolveAskpassCapability } from "../provision/askpass.js";
import { collectSnapshot } from "../provision/detect.js";
import {
  executeProvisioning,
  type ExecuteProvisioningResult,
  type StepResult,
} from "../provision/executor.js";
import type { ProvisioningStep } from "../provision/plan.js";
import {
  labUserPrivilegeUnavailableMessage,
  planLabUser,
} from "../provision/planner.js";
import { confirm, toConsentDecision } from "../provision/prompts.js";

export interface SetupLabUserCliOptions {
  name?: string;
  home?: string;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface SetupLabUserReport {
  ok: boolean;
  /** Mirrors `ExecuteProvisioningResult.status` so `--json` consumers can
   * distinguish a declined/cancelled/sudo-cancelled provisioning run from a
   * generic failure without string-matching `errors`. `"failed"` before an
   * execution ever runs (e.g. an invalid lab user name/home). */
  status: ExecuteProvisioningResult["status"];
  name: string;
  home: string;
  userExists: boolean;
  dryRun: boolean;
  plan: ProvisioningStep[];
  results: StepResult[];
  errors: string[];
}

function emit(report: SetupLabUserReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const error of report.errors) {
    console.error(`error: ${error}`);
  }
}

export async function runSetupLabUser(
  opts: SetupLabUserCliOptions,
  env: EnvLike = process.env,
): Promise<number> {
  const snapshot = await collectSnapshot({
    env,
    labUserName: opts.name,
    labUserHome: opts.home,
  });
  const report: SetupLabUserReport = {
    ok: false,
    status: "failed",
    name: snapshot.labUser.name,
    home: snapshot.labUser.home,
    userExists: snapshot.labUser.exists,
    dryRun: opts.dryRun === true,
    plan: [],
    results: [],
    errors: [],
  };

  const result = planLabUser({
    name: snapshot.labUser.name,
    home: snapshot.labUser.home,
    userExists: snapshot.labUser.exists,
    homeExists: snapshot.labUser.homeExists,
    kvmPresent: snapshot.android.kvm.exists,
  });
  if (!result.ok) {
    report.errors.push(result.error);
    emit(report, opts.json === true);
    return 1;
  }
  report.plan = result.plan.steps;

  const log =
    opts.json === true ? () => {} : (line: string) => console.log(line);
  const execution = await executeProvisioning(
    [
      {
        kind: "plan",
        plan: result.plan,
        privilegeUnavailable: {
          reason: labUserPrivilegeUnavailableMessage(snapshot.labUser.name),
        },
        consent: {
          retainPlanOnDenied: true,
          decide: async () => {
            const answer = await confirm(
              `Create system user "${snapshot.labUser.name}" with home ` +
                `${snapshot.labUser.home} (privileged, runs sudo)?`,
              { yes: opts.yes },
            );
            return toConsentDecision(answer, {
              declined: "Aborted: lab user provisioning was declined.",
              cancelled:
                "Refusing to provision the lab user without consent in a " +
                "non-interactive session. Re-run with --yes.",
            });
          },
        },
      },
    ],
    {
      dryRun: opts.dryRun,
      env,
      log,
      privilege: {
        sudoPath: snapshot.sudo,
        askpass: resolveAskpassCapability(env),
      },
      beforeExecute: () => {
        if (opts.json !== true && snapshot.labUser.exists) {
          console.log(`User "${snapshot.labUser.name}" already exists.`);
        }
      },
    },
  );
  report.plan = execution.plan.steps;
  report.results = execution.results;
  report.ok = execution.ok;
  report.status = execution.status;
  if (!execution.ok) {
    report.errors.push(execution.error ?? "provisioning failed");
  }
  emit(report, opts.json === true);
  if (opts.json !== true && execution.ok && opts.dryRun !== true) {
    console.log(
      `Lab user "${report.name}" is ready (home: ${report.home}).`,
    );
  }
  return execution.ok ? 0 : 1;
}
