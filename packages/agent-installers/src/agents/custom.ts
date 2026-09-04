import fs from "node:fs";
import path from "node:path";
import {
  agentsDir,
  ensureDir,
  legacyAgentsDirs,
  listDirSafe,
  resolveReadablePath,
  writeFileAtomic,
  type EnvLike,
} from "@pickforge/lab-core";
import {
  LEGACY_MCP_SERVER_NAME,
  LEGACY_SHARED_SNIPPET_BASENAMES,
  MCP_SERVER_NAME,
  renderJsonSnippet,
  SHARED_SNIPPET_BASENAMES,
} from "../snippet.js";
import { AGENT_KINDS, type ChangeResult, type McpServerEntry } from "../types.js";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const RESERVED_NAMES = new Set<string>([
  ...AGENT_KINDS,
  "state",
  ...[...SHARED_SNIPPET_BASENAMES, ...LEGACY_SHARED_SNIPPET_BASENAMES].map(
    (basename) => basename.replace(/\.[^.]+$/, ""),
  ),
]);

export interface CustomAgent {
  name: string;
  configPath: string;
  entry: McpServerEntry;
}

export function validateCustomAgentName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid agent name "${name}": use letters, digits, ".", "_", or "-" ` +
        `(must start with a letter or digit)`,
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`Agent name "${name}" is reserved`);
  }
  return name;
}

export function parseMcpCommand(input: string): McpServerEntry {
  const parts = input.trim().split(/\s+/).filter((part) => part !== "");
  const command = parts[0];
  if (command === undefined) {
    throw new Error("--mcp-command must not be empty");
  }
  return { command, args: parts.slice(1) };
}

export function customAgentConfigPath(
  name: string,
  env: EnvLike = process.env,
): string {
  return path.join(agentsDir(env), `${name}.json`);
}

export async function addCustomAgent(
  opts: { name: string; mcpCommand: string; force?: boolean },
  env: EnvLike = process.env,
): Promise<CustomAgent> {
  const name = validateCustomAgentName(opts.name);
  const entry = parseMcpCommand(opts.mcpCommand);
  await ensureDir(agentsDir(env));
  const configPath = customAgentConfigPath(name, env);
  if (opts.force !== true) {
    let exists = false;
    try {
      await fs.promises.access(configPath, fs.constants.F_OK);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      throw new Error(
        `Custom agent "${name}" already exists at ${configPath} ` +
          `(re-run with --force to overwrite)`,
      );
    }
  }
  await writeFileAtomic(configPath, renderJsonSnippet(entry));
  return { name, configPath, entry };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryFromSnippet(raw: string): McpServerEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    return undefined;
  }
  const entry =
    parsed.mcpServers[MCP_SERVER_NAME] ??
    parsed.mcpServers[LEGACY_MCP_SERVER_NAME];
  if (!isPlainObject(entry) || typeof entry.command !== "string") {
    return undefined;
  }
  const args = Array.isArray(entry.args)
    ? entry.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return { command: entry.command, args };
}

export async function listCustomAgents(
  env: EnvLike = process.env,
): Promise<CustomAgent[]> {
  const primaryDir = agentsDir(env);
  const legacyDirs = legacyAgentsDirs(env);
  const directoryEntries = await Promise.all(
    [primaryDir, ...legacyDirs].map((dir) => listDirSafe(dir)),
  );
  const entries = [...new Set(directoryEntries.flat())].sort();
  const sharedBasenames = new Set<string>([
    ...SHARED_SNIPPET_BASENAMES,
    ...LEGACY_SHARED_SNIPPET_BASENAMES,
  ]);
  const agents: CustomAgent[] = [];
  for (const basename of entries) {
    if (!basename.endsWith(".json") || sharedBasenames.has(basename)) {
      continue;
    }
    const configPath = await resolveReadablePath(
      path.join(primaryDir, basename),
      legacyDirs.map((dir) => path.join(dir, basename)),
    );
    let raw: string;
    try {
      raw = await fs.promises.readFile(configPath, "utf8");
    } catch {
      continue;
    }
    const entry = entryFromSnippet(raw);
    if (entry === undefined) {
      continue;
    }
    agents.push({ name: basename.slice(0, -".json".length), configPath, entry });
  }
  return agents;
}

export async function removeCustomAgent(
  name: string,
  env: EnvLike = process.env,
): Promise<ChangeResult> {
  const validName = validateCustomAgentName(name);
  const listed = (await listCustomAgents(env)).find(
    (agent) => agent.name === validName,
  );
  const configPath = listed?.configPath ?? customAgentConfigPath(validName, env);
  try {
    await fs.promises.unlink(configPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { configPath, changed: false };
    }
    throw error;
  }
  return { configPath, changed: true };
}
