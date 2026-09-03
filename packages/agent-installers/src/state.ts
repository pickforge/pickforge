import fs from "node:fs";
import path from "node:path";
import {
  agentsDir,
  legacyAgentsDir,
  resolveReadablePath,
  writeFileAtomic,
  type EnvLike,
} from "@pickforge/lab-core";

export interface AgentStateEntry {
  registered: boolean;
  configPath: string;
  updatedAt: string;
}

export interface AgentsState {
  agents: Record<string, AgentStateEntry>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function agentsStatePath(env: EnvLike = process.env): string {
  return path.join(agentsDir(env), "state.json");
}

function legacyAgentsStatePath(env: EnvLike): string | undefined {
  const dir = legacyAgentsDir(env);
  return dir === undefined ? undefined : path.join(dir, "state.json");
}

/**
 * Read agent registration state. Falls back to a pre-#34 `~/.picklab/agents`
 * record when the new home has none yet, so "is this agent registered?"
 * keeps answering correctly across the default-root change without a
 * migration step. Writes (`recordAgentState`) always target the new home.
 */
export async function readAgentsState(
  env: EnvLike = process.env,
): Promise<AgentsState> {
  const statePath = await resolveReadablePath(
    agentsStatePath(env),
    legacyAgentsStatePath(env),
  );
  let raw: string;
  try {
    raw = await fs.promises.readFile(statePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { agents: {} };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { agents: {} };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.agents)) {
    return { agents: {} };
  }
  const agents: Record<string, AgentStateEntry> = {};
  for (const [name, value] of Object.entries(parsed.agents)) {
    if (
      isPlainObject(value) &&
      typeof value.registered === "boolean" &&
      typeof value.configPath === "string"
    ) {
      agents[name] = {
        registered: value.registered,
        configPath: value.configPath,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
      };
    }
  }
  return { agents };
}

export async function recordAgentState(
  name: string,
  entry: { registered: boolean; configPath: string },
  env: EnvLike = process.env,
  now: Date = new Date(),
): Promise<void> {
  const state = await readAgentsState(env);
  state.agents[name] = { ...entry, updatedAt: now.toISOString() };
  await writeFileAtomic(
    agentsStatePath(env),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}
