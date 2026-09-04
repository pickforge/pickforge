import fs from "node:fs";
import {
  deepMerge,
  globalConfigPath,
  projectConfigPath,
  readConfigFile,
  redactSecrets,
  runCommand,
  saveGlobalConfig,
  saveProjectConfig,
  type EnvLike,
  type PickforgeConfig,
} from "@pickforge/lab-core";
import {
  askpassUnavailableMessage,
  type AskpassCapability,
} from "./askpass.js";
import {
  formatStep,
  type CommandStep,
  type ProvisioningPlan,
  type ProvisioningStep,
} from "./plan.js";

const DEFAULT_STEP_TIMEOUT_MS = 180_000;

// Real `sudo` prefixes its own diagnostics with "sudo:" — auth failure,
// cancellation (the askpass helper produced no password), and "no askpass
// program specified" all take this shape. The wrapped command's own stderr
// does not, so this is the fail-closed line between "sudo denied/cancelled
// this" and "the privileged command itself failed" without ever parsing
// prompt text or credentials (sudo never echoes those to its own stderr —
// they go straight from the askpass helper into sudo's authentication path).
const SUDO_DENIAL_RE = /^sudo:/im;

export type PlanClassification =
  | "empty"
  | "automatic"
  | "unprivileged"
  | "privileged"
  | "mixed";

export type ConsentDecision =
  | { kind: "approved" }
  | { kind: "declined"; reason: string }
  | { kind: "cancelled"; reason: string };

interface DenialPolicy {
  onDenied?: "cancel" | "skip";
  retainPlanOnDenied?: boolean;
}

export interface ProvisioningPlanSection {
  kind: "plan";
  plan: ProvisioningPlan;
  satisfies?: string;
  consent?: DenialPolicy & {
    decide: (classification: PlanClassification) => Promise<ConsentDecision>;
  };
  privilegeUnavailable?: {
    action?: "error" | "skip";
    /** Used verbatim only when sudo itself is missing from PATH — the
     * failure mode this field predates the askpass contract for. Ignored
     * for an askpass-unavailable failure (see `context` below), since a
     * static reason authored for "sudo not found" would otherwise paper
     * over the real, state-correct askpass message. */
    reason: string;
    /** Prefix (e.g. `"lab-user: "`) prepended, verbatim, to an
     * askpass-unavailable message (headless/no-helper/unsupported-platform).
     * `reason` doesn't apply to that failure mode (see above), so this is a
     * section's only way to keep the same "<label>: " context its sibling
     * skip/error reasons already carry — e.g. doctor's `--fix` skip list
     * mixes "avd: ..." and "lab-user: ..." entries. */
    context?: string;
  };
}

export interface BlockedProvisioningSection {
  kind: "blocked";
  action?: "error" | "skip";
  reason: string;
  unlessSatisfied?: string;
}

export type ProvisioningSection =
  | ProvisioningPlanSection
  | BlockedProvisioningSection;

export interface ProvisioningExecutionAdapter {
  materialize(step: ProvisioningStep): ProvisioningStep;
  execute(step: ProvisioningStep): Promise<void>;
  executePrivileged(step: ProvisioningStep): Promise<void>;
}

export interface ExecuteProvisioningOptions {
  dryRun?: boolean;
  env?: EnvLike;
  projectDir?: string;
  log?: (line: string) => void;
  timeoutMs?: number;
  adapter?: ProvisioningExecutionAdapter;
  privilege?: {
    sudoPath: string | null;
    /** Pre-resolved via `resolveAskpassCapability` at command-invocation
     * time (per the locked v1 contract). Missing is treated as `headless` —
     * fail-closed, never an implicit "available". */
    askpass?: AskpassCapability;
  };
  beforeExecute?: (plan: ProvisioningPlan) => void | Promise<void>;
}

export interface StepResult {
  id: string;
  ok: boolean;
  detail: string;
}

export interface ExecuteProvisioningResult {
  ok: boolean;
  status: "completed" | "declined" | "cancelled" | "failed";
  plan: ProvisioningPlan;
  skipped: string[];
  results: StepResult[];
  errors: string[];
  error?: string;
}

interface PreparedStep {
  materialized: ProvisioningStep;
}

type PreparedSection =
  | {
      kind: "plan";
      classification: PlanClassification;
      section: ProvisioningPlanSection;
      steps: PreparedStep[];
    }
  | {
      kind: "unavailable";
      section: ProvisioningPlanSection;
      reason: string;
    }
  | {
      kind: "blocked";
      section: BlockedProvisioningSection;
    };

class PrivilegeUnavailableError extends Error {}

/** Preflight failure: the `sudo` binary itself isn't on PATH. Callers may
 * override this reason with a section's static `privilegeUnavailable.reason`
 * (e.g. `labUserPrivilegeUnavailableMessage`) — that override predates the
 * askpass contract and was always written to describe exactly this case. */
class SudoMissingError extends PrivilegeUnavailableError {}

/** Preflight failure: sudo exists, but the locked v1 askpass contract's
 * capability check didn't resolve to `available` (headless, no helper, or
 * an unsupported platform). Its message is already the specific,
 * state-correct, actionable one from `askpassUnavailableMessage` — a
 * section's static `privilegeUnavailable.reason` (written only for the
 * sudo-missing case above) must never paper over it with a stale, wrong
 * "sudo not found" message. */
class AskpassUnavailableError extends PrivilegeUnavailableError {}

/** Thrown when a privileged command's own execution is denied or cancelled
 * by sudo (auth failure, or the user dismissing the graphical prompt) — a
 * distinct, actionable runtime state per the locked v1 contract, never
 * retried automatically. Exported so custom adapters can raise the same
 * state without re-implementing the `sudo:`-prefix heuristic. */
export class PrivilegedCommandDeniedError extends Error {}

export function classifyPlan(plan: ProvisioningPlan): PlanClassification {
  if (plan.steps.length === 0) return "empty";
  const consentSteps = plan.steps.filter(
    (step) => step.kind === "command" || step.privileged,
  );
  if (consentSteps.length === 0) return "automatic";
  const hasPrivileged = consentSteps.some((step) => step.privileged);
  const hasUnprivileged = consentSteps.some((step) => !step.privileged);
  if (hasPrivileged && hasUnprivileged) return "mixed";
  return hasPrivileged ? "privileged" : "unprivileged";
}

async function patchGlobalConfig(
  patch: PickforgeConfig,
  env: EnvLike = process.env,
): Promise<void> {
  const existing = await readConfigFile(globalConfigPath(env));
  await saveGlobalConfig(deepMerge(existing, patch) as PickforgeConfig, env);
}

async function patchProjectConfig(
  projectDir: string,
  patch: PickforgeConfig,
): Promise<void> {
  const existing = await readConfigFile(projectConfigPath(projectDir));
  await saveProjectConfig(
    projectDir,
    deepMerge(existing, patch) as PickforgeConfig,
  );
}

async function executeLocalStep(
  step: ProvisioningStep,
  opts: ExecuteProvisioningOptions,
): Promise<void> {
  switch (step.kind) {
    case "mkdir": {
      await fs.promises.mkdir(step.dir, { recursive: true });
      return;
    }
    case "command": {
      const command = step.command;
      const result = await runCommand(command.cmd, command.args, {
        env: { ...opts.env, ...command.env },
        input: command.input,
        timeoutMs: opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      });
      if (!result.ok) {
        const detail =
          result.stderr.trim() ||
          result.stdout.trim() ||
          (result.timedOut ? "timed out" : `exit code ${result.code}`);
        if (step.privileged && SUDO_DENIAL_RE.test(result.stderr)) {
          throw new PrivilegedCommandDeniedError(
            `sudo denied or cancelled this privileged command: ${detail}. ` +
              "No changes were made by this step. Approve the graphical " +
              "sudo prompt and re-run, or run it yourself in a terminal: " +
              manualSudoCommandFromMaterialized(step),
          );
        }
        throw new Error(
          `${command.cmd} ${command.args.join(" ")} failed: ${detail}`,
        );
      }
      return;
    }
    case "write-global-config": {
      await patchGlobalConfig(step.config, opts.env);
      return;
    }
    case "write-project-config": {
      if (opts.projectDir === undefined) {
        throw new Error("write-project-config step requires a project directory");
      }
      await patchProjectConfig(opts.projectDir, step.config);
      return;
    }
  }
}

/** Reconstruct the command line a user can paste into a terminal themselves
 * — the manual fallback the locked v1 contract requires whenever graphical
 * sudo isn't available. For the raw (pre-materialization) step. */
function manualSudoCommand(step: CommandStep): string {
  return `sudo ${step.command.cmd} ${step.command.args.join(" ")}`.trim();
}

/** Same fallback, reconstructed from an already-materialized `sudo -A <cmd>
 * <args>` step (as seen inside `executeLocalStep`) by dropping the `-A`
 * flag we added ourselves. Only ever called on steps this module
 * materialized, so the `["-A", cmd, ...args]` shape is guaranteed. */
function manualSudoCommandFromMaterialized(step: CommandStep): string {
  return `sudo ${step.command.args.slice(1).join(" ")}`.trim();
}

function materializePrivilegedStep(
  step: ProvisioningStep,
  opts: ExecuteProvisioningOptions,
): ProvisioningStep {
  const sudoPath = opts.privilege?.sudoPath;
  if (sudoPath === undefined || sudoPath === null) {
    throw new SudoMissingError("sudo not found on PATH");
  }
  if (step.kind !== "command") {
    throw new Error(`Unsupported privileged provisioning step: ${step.kind}`);
  }
  // Missing capability is treated as `headless` — fail-closed, never an
  // implicit "available" — so a caller that forgets to resolve+pass it
  // cannot accidentally spawn sudo without a graphical prompt.
  const capability: AskpassCapability =
    opts.privilege?.askpass ?? { state: "headless" };
  if (capability.state !== "available") {
    throw new AskpassUnavailableError(
      askpassUnavailableMessage(capability, manualSudoCommand(step)),
    );
  }
  return {
    ...step,
    command: {
      ...step.command,
      cmd: sudoPath,
      args: ["-A", step.command.cmd, ...step.command.args],
      // SUDO_ASKPASS is the only environment variable this feature may
      // inject (locked v1 contract) — every other key from the step's own
      // `command.env` passes through untouched.
      env: { ...step.command.env, SUDO_ASKPASS: capability.helper },
    },
  };
}

export function createLocalExecutionAdapter(
  opts: ExecuteProvisioningOptions = {},
): ProvisioningExecutionAdapter {
  return {
    materialize: (step) =>
      step.privileged ? materializePrivilegedStep(step, opts) : step,
    execute: async (step) => executeLocalStep(step, opts),
    executePrivileged: async (step) => executeLocalStep(step, opts),
  };
}

function publicPlan(steps: readonly PreparedStep[]): ProvisioningPlan {
  return JSON.parse(
    redactSecrets(
      JSON.stringify({ steps: steps.map((step) => step.materialized) }),
    ),
  ) as ProvisioningPlan;
}

function executionResult(
  status: ExecuteProvisioningResult["status"],
  steps: readonly PreparedStep[],
  skipped: string[],
  results: StepResult[],
  errors: string[],
): ExecuteProvisioningResult {
  const redactedErrors = errors.map((error) => redactSecrets(error));
  return {
    ok: status === "completed",
    status,
    plan: publicPlan(steps),
    skipped: skipped.map((entry) => redactSecrets(entry)),
    results,
    errors: redactedErrors,
    ...(redactedErrors.length === 0 ? {} : { error: redactedErrors[0] }),
  };
}

function prepareSections(
  sections: readonly ProvisioningSection[],
  adapter: ProvisioningExecutionAdapter,
): PreparedSection[] {
  return sections.map((section): PreparedSection => {
    if (section.kind === "blocked") {
      return { kind: "blocked", section };
    }
    try {
      return {
        kind: "plan",
        classification: classifyPlan(section.plan),
        section,
        steps: section.plan.steps.map((step) => ({
          materialized: adapter.materialize(step),
        })),
      };
    } catch (error) {
      if (error instanceof AskpassUnavailableError) {
        // Always the specific, state-correct reason — never masked by a
        // section's static privilegeUnavailable.reason (see class doc) —
        // but still honors an explicit `context` prefix, so a section that
        // labels its other skip/error reasons (e.g. doctor's "lab-user: ")
        // keeps that same label here.
        const context = section.privilegeUnavailable?.context;
        return {
          kind: "unavailable",
          section,
          reason:
            context === undefined ? error.message : `${context}${error.message}`,
        };
      }
      if (error instanceof PrivilegeUnavailableError) {
        return {
          kind: "unavailable",
          section,
          reason: section.privilegeUnavailable?.reason ?? error.message,
        };
      }
      return {
        kind: "blocked",
        section: {
          kind: "blocked",
          reason: `Provisioning preflight failed: ${(error as Error).message}`,
        },
      };
    }
  });
}

// eslint-disable-next-line max-lines-per-function, complexity -- Legacy gate debt: pickforge/pickforge#60
export async function executeProvisioning(
  sections: readonly ProvisioningSection[],
  opts: ExecuteProvisioningOptions = {},
): Promise<ExecuteProvisioningResult> {
  const adapter = opts.adapter ?? createLocalExecutionAdapter(opts);
  const prepared = prepareSections(sections, adapter);
  const selected: PreparedStep[] = [];
  const satisfied = new Set<string>();
  const skipped: string[] = [];
  const errors: string[] = [];
  let errorStatus: "declined" | "cancelled" | "failed" = "failed";

  const addError = (
    reason: string,
    status: "declined" | "cancelled" | "failed" = "failed",
  ): void => {
    if (errors.length === 0) errorStatus = status;
    errors.push(reason);
  };

  for (const entry of prepared) {
    if (entry.kind === "blocked") {
      if (
        entry.section.unlessSatisfied !== undefined &&
        satisfied.has(entry.section.unlessSatisfied)
      ) {
        continue;
      }
      if (entry.section.action === "skip") {
        skipped.push(entry.section.reason);
      } else {
        addError(entry.section.reason);
      }
      continue;
    }
    if (entry.kind === "unavailable") {
      if (entry.section.privilegeUnavailable?.action === "skip") {
        skipped.push(entry.reason);
      } else {
        addError(entry.reason);
      }
      continue;
    }

    const { classification, section } = entry;
    if (
      opts.dryRun !== true &&
      classification !== "empty" &&
      classification !== "automatic"
    ) {
      if (section.consent === undefined) {
        addError(
          "Refusing to execute provisioning commands without a consent decision.",
          "cancelled",
        );
        continue;
      }
      let decision: ConsentDecision;
      try {
        decision = await section.consent.decide(classification);
      } catch (error) {
        addError(`Provisioning consent failed: ${(error as Error).message}`);
        continue;
      }
      if (decision.kind !== "approved") {
        if (section.consent.onDenied === "skip") {
          skipped.push(decision.reason);
        } else {
          addError(decision.reason, decision.kind);
          // eslint-disable-next-line max-depth -- Legacy gate debt: pickforge/pickforge#60
          if (section.consent.retainPlanOnDenied === true) {
            selected.push(...entry.steps);
          }
        }
        continue;
      }
    }

    selected.push(...entry.steps);
    if (section.satisfies !== undefined) {
      satisfied.add(section.satisfies);
    }
  }

  if (errors.length > 0) {
    return executionResult(errorStatus, selected, skipped, [], errors);
  }

  const plan = publicPlan(selected);
  if (opts.beforeExecute !== undefined) {
    try {
      await opts.beforeExecute(plan);
    } catch (error) {
      return executionResult(
        "failed",
        selected,
        skipped,
        [],
        [`Provisioning pre-execution hook failed: ${(error as Error).message}`],
      );
    }
  }

  const log = opts.log ?? (() => {});
  const results: StepResult[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const preparedStep = selected[index]!;
    const presentation = plan.steps[index]!;
    const formatted = formatStep(presentation);
    const title = presentation.title;
    if (opts.dryRun === true) {
      log(`[dry-run] ${title}: ${formatted}`);
      results.push({ id: presentation.id, ok: true, detail: "dry-run" });
      continue;
    }
    try {
      if (preparedStep.materialized.privileged) {
        await adapter.executePrivileged(preparedStep.materialized);
      } else {
        await adapter.execute(preparedStep.materialized);
      }
      log(`[done] ${title}`);
      results.push({ id: presentation.id, ok: true, detail: formatted });
    } catch (error) {
      const detail = redactSecrets((error as Error).message);
      // sudo denial/cancellation is a distinct, actionable runtime state
      // (locked v1 contract) — never folded into a generic "failed" and
      // never retried automatically.
      const cancelledBySudo = error instanceof PrivilegedCommandDeniedError;
      const message = `Step "${presentation.id}" ${
        cancelledBySudo ? "cancelled" : "failed"
      }: ${detail}`;
      log(`[${cancelledBySudo ? "cancelled" : "failed"}] ${title}: ${detail}`);
      results.push({ id: presentation.id, ok: false, detail: message });
      return executionResult(
        cancelledBySudo ? "cancelled" : "failed",
        selected,
        skipped,
        results,
        [message],
      );
    }
  }
  return executionResult("completed", selected, skipped, results, []);
}
