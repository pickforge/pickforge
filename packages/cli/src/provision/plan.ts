import type { PickforgeConfig } from "@pickforge/lab-core";

export interface StepCommand {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  input?: string;
}

interface StepBase {
  id: string;
  title: string;
  privileged: boolean;
}

export interface CommandStep extends StepBase {
  kind: "command";
  command: StepCommand;
}

export interface MkdirStep extends StepBase {
  kind: "mkdir";
  dir: string;
}

export interface WriteGlobalConfigStep extends StepBase {
  kind: "write-global-config";
  config: PickforgeConfig;
}

export interface WriteProjectConfigStep extends StepBase {
  kind: "write-project-config";
  config: PickforgeConfig;
}

export type ProvisioningStep =
  | CommandStep
  | MkdirStep
  | WriteGlobalConfigStep
  | WriteProjectConfigStep;

export type StepKind = ProvisioningStep["kind"];

export interface ProvisioningPlan {
  steps: ProvisioningStep[];
}

export type PlanResult =
  | { ok: true; plan: ProvisioningPlan }
  | { ok: false; error: string };

export function formatStep(step: ProvisioningStep): string {
  switch (step.kind) {
    case "command":
      return `$ ${step.command.cmd} ${step.command.args.join(" ")}`;
    case "mkdir":
      return `mkdir -p ${step.dir}`;
    case "write-global-config":
      return `update global config: ${JSON.stringify(step.config)}`;
    case "write-project-config":
      return `write project config: ${JSON.stringify(step.config)}`;
  }
}
