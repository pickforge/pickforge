import fs from "node:fs";
import type { EnvLike } from "@pickforge/lab-core";
import {
  addCustomAgent,
  AGENT_KINDS,
  builtinAgent,
  listCustomAgents,
  recordAgentState,
  removeCustomAgent,
  runAgentsDoctor,
  writeSharedSnippets,
  type AgentKind,
  type AgentStatus,
  type ChangeResult,
} from "@pickforge/lab-agent-installers";
import { runReported, type CommandResult } from "./shared.js";

export interface AgentsCliOptions {
  json?: boolean;
}

export interface AgentsTargetOptions extends AgentsCliOptions {
  configPath?: string;
}

export interface AgentsInspectOptions extends AgentsCliOptions {
  configPath?: string[];
}

export interface AgentsAddOptions extends AgentsCliOptions {
  name?: string;
  mcpCommand?: string;
  force?: boolean;
}

function parseConfigPathOverrides(
  values: string[] | undefined,
): Partial<Record<AgentKind, string>> {
  const overrides: Partial<Record<AgentKind, string>> = {};
  for (const value of values ?? []) {
    const separator = value.indexOf("=");
    const agent = separator === -1 ? "" : value.slice(0, separator);
    const configPath = separator === -1 ? "" : value.slice(separator + 1);
    if (agent === "" || configPath === "") {
      throw new Error(
        `Invalid --config-path "${value}": expected <agent>=<path>`,
      );
    }
    if (!AGENT_KINDS.includes(agent as AgentKind)) {
      throw new Error(
        `Invalid --config-path agent "${agent}" ` +
          `(expected one of: ${AGENT_KINDS.join(", ")})`,
      );
    }
    overrides[agent as AgentKind] = configPath;
  }
  return overrides;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectStatuses(
  env: EnvLike,
  overrides: Partial<Record<AgentKind, string>>,
): Promise<AgentStatus[]> {
  const statuses: AgentStatus[] = [];
  for (const kind of AGENT_KINDS) {
    const agent = builtinAgent(kind);
    if (agent === undefined) continue;
    const configPath = overrides[kind] ?? agent.defaultConfigPath(env);
    statuses.push({
      name: kind,
      kind,
      configPath,
      configExists: await fileExists(configPath),
      registered: await agent.isRegistered(configPath),
    });
  }
  for (const custom of await listCustomAgents(env)) {
    statuses.push({
      name: custom.name,
      kind: "custom",
      configPath: custom.configPath,
      configExists: true,
      registered: true,
    });
  }
  return statuses;
}

function registrationLabel(registered: AgentStatus["registered"]): string {
  if (registered === "unknown") {
    return "unknown (config exists but is not parseable as strict JSON)";
  }
  return registered ? "registered" : "not registered";
}

export async function runAgentsList(
  opts: AgentsInspectOptions,
  env: EnvLike = process.env,
): Promise<number> {
  return runReported(opts, async () => {
    const overrides = parseConfigPathOverrides(opts.configPath);
    const agents = await collectStatuses(env, overrides);
    return {
      data: { agents },
      lines: agents.map(
        (agent) =>
          `${agent.name}  ${agent.kind === "custom" ? "custom" : "builtin"}  ` +
          `${registrationLabel(agent.registered)}  ${agent.configPath}`,
      ),
    };
  });
}

async function unknownAgentError(
  name: string,
  env: EnvLike,
): Promise<CommandResult> {
  const customs = (await listCustomAgents(env)).map((agent) => agent.name);
  const known = [...AGENT_KINDS, ...customs].join(", ");
  return { errors: [`Unknown agent "${name}" (known agents: ${known})`] };
}

function changeLines(
  name: string,
  result: ChangeResult,
  verb: "registered" | "removed",
): string[] {
  const lines: string[] = [];
  if (result.instructions !== undefined) {
    lines.push(result.instructions);
  } else if (result.changed) {
    lines.push(
      verb === "registered"
        ? `Registered the pickforge-lab MCP server for ${name} in ${result.configPath}`
        : `Removed the pickforge-lab MCP server entry for ${name} from ${result.configPath}`,
    );
  } else {
    lines.push(
      verb === "registered"
        ? `${name} is already registered in ${result.configPath} (no changes made)`
        : `${name} has no pickforge-lab entry in ${result.configPath} (nothing to remove)`,
    );
  }
  if (result.backupPath !== undefined) {
    lines.push(`Backed up the previous config to ${result.backupPath}`);
  }
  if (result.warning !== undefined) {
    lines.push(`warning: ${result.warning}`);
  }
  return lines;
}

export async function runAgentsLink(
  name: string,
  opts: AgentsTargetOptions,
  env: EnvLike = process.env,
): Promise<number> {
  return runReported(opts, async () => {
    const agent = builtinAgent(name);
    if (agent === undefined) {
      const customs = await listCustomAgents(env);
      const custom = customs.find((candidate) => candidate.name === name);
      if (custom !== undefined) {
        return {
          errors: [
            `"${name}" is a custom agent; its MCP config snippet lives at ` +
              `${custom.configPath}. Point the agent at it manually.`,
          ],
        };
      }
      return unknownAgentError(name, env);
    }
    const snippets = await writeSharedSnippets(env);
    const configPath = opts.configPath ?? agent.defaultConfigPath(env);
    const result = await agent.link(configPath, env);
    const registered = await agent.isRegistered(configPath);
    if (result.instructions === undefined) {
      await recordAgentState(name, { registered: true, configPath }, env);
    }
    return {
      data: {
        agent: name,
        configPath,
        registered,
        changed: result.changed,
        backupPath: result.backupPath ?? null,
        instructions: result.instructions ?? null,
        warning: result.warning ?? null,
        snippets,
      },
      lines: changeLines(name, result, "registered"),
    };
  });
}

export async function runAgentsUnlink(
  name: string,
  opts: AgentsTargetOptions,
  env: EnvLike = process.env,
): Promise<number> {
  return runReported(opts, async () => {
    const agent = builtinAgent(name);
    if (agent === undefined) {
      const customs = await listCustomAgents(env);
      if (customs.some((candidate) => candidate.name === name)) {
        const result = await removeCustomAgent(name, env);
        return {
          data: {
            agent: name,
            configPath: result.configPath,
            changed: result.changed,
          },
          lines: [`Removed custom agent "${name}" (${result.configPath})`],
        };
      }
      return unknownAgentError(name, env);
    }
    const configPath = opts.configPath ?? agent.defaultConfigPath(env);
    const result = await agent.unlink(configPath, env);
    await recordAgentState(name, { registered: false, configPath }, env);
    return {
      data: {
        agent: name,
        configPath,
        changed: result.changed,
        backupPath: result.backupPath ?? null,
        warning: result.warning ?? null,
      },
      lines: changeLines(name, result, "removed"),
    };
  });
}

export async function runAgentsDoctorCommand(
  opts: AgentsInspectOptions,
  env: EnvLike = process.env,
): Promise<number> {
  return runReported(opts, async () => {
    const configPaths = parseConfigPathOverrides(opts.configPath);
    const report = await runAgentsDoctor({ env, configPaths });
    const errors = report.checks
      .filter((check) => check.status === "problem")
      .map((check) => `${check.id}: ${check.detail}`);
    return {
      data: { checks: report.checks },
      lines: report.checks.map(
        (check) => `[${check.status}] ${check.id}: ${check.detail}`,
      ),
      errors,
    };
  });
}

export async function runAgentsAdd(
  opts: AgentsAddOptions,
  env: EnvLike = process.env,
): Promise<number> {
  return runReported(opts, async () => {
    if (opts.name === undefined || opts.name === "") {
      return { errors: ["--name is required"] };
    }
    if (opts.mcpCommand === undefined) {
      return { errors: ["--mcp-command is required"] };
    }
    const agent = await addCustomAgent(
      { name: opts.name, mcpCommand: opts.mcpCommand, force: opts.force },
      env,
    );
    const snippets = await writeSharedSnippets(env);
    return {
      data: {
        name: agent.name,
        configPath: agent.configPath,
        command: agent.entry.command,
        args: agent.entry.args,
        snippets,
      },
      lines: [
        `Added custom agent "${agent.name}" (${agent.configPath})`,
        `Command: ${[agent.entry.command, ...agent.entry.args].join(" ")}`,
        "Note: the command string is split on whitespace; quoting is not supported.",
      ],
    };
  });
}
