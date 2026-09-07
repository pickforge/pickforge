import fs from "node:fs";
import path from "node:path";
import { runCommand, type EnvLike } from "@pickforge/lab-core";
import {
  jsonFileMcpServerState,
  jsonFileRetainedMcpServerNames,
  mergeMcpServerIntoJsonFile,
  ownedLegacyMcpServerNamesInJsonFile,
  removeMcpServerFromJsonFile,
  replaceOwnedLegacyMcpServersInJsonFile,
} from "../jsonConfig.js";
import {
  BROWSER_MCP_SERVER_NAME,
  MCP_SERVER_NAME,
  browserMcpServerEntry,
  mcpServerEntry,
  wantsBrowserEntry,
} from "../snippet.js";
import type {
  ChangeResult,
  LinkOptions,
  McpServerEntry,
  RegistrationState,
} from "../types.js";
import { homeDir } from "./home.js";

export const CLAUDE_CODE_MANUAL_COMMAND =
  "claude mcp add --scope user pickforge-lab -- pickforge-lab mcp serve";
export const CLAUDE_CODE_BROWSER_MANUAL_COMMAND =
  "claude mcp add --scope user pickforge-lab-browser -- pickforge-lab browser devtools-mcp";

function manualCommand(browser: boolean): string {
  return browser
    ? `${CLAUDE_CODE_MANUAL_COMMAND} && ${CLAUDE_CODE_BROWSER_MANUAL_COMMAND}`
    : CLAUDE_CODE_MANUAL_COMMAND;
}

const DIRECT_EDIT_WARNING =
  "the claude binary was not found on PATH, so the config file was edited " +
  "directly; close Claude Code while linking, or it may overwrite the change";

export function claudeCodeConfigPath(env: EnvLike = process.env): string {
  return path.join(homeDir(env), ".claude.json");
}

export function findClaudeBinary(
  env: EnvLike = process.env,
): string | undefined {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = path.join(dir, "claude");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function commandFailure(
  action: string,
  name: string,
  result: { code: number | null; stdout: string; stderr: string },
): Error {
  const output = result.stderr.trim() || result.stdout.trim();
  return new Error(
    `"claude mcp ${action}" failed for ${name} (exit code ${result.code ?? "unknown"})` +
      (output === "" ? "" : `: ${output}`),
  );
}

function isAlreadyRegisteredAddFailure(
  name: string,
  result: { stdout: string; stderr: string },
): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    output.includes("mcp") &&
    output.includes(name.toLowerCase()) &&
    output.includes("already exists")
  );
}

function isNotFoundRemoveFailure(result: {
  stdout: string;
  stderr: string;
}): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes("not found") || output.includes("no mcp server");
}

interface ClaudeServer {
  name: string;
  entry: McpServerEntry;
}

const CLAUDE_SERVERS: readonly ClaudeServer[] = [
  { name: MCP_SERVER_NAME, entry: mcpServerEntry() },
  { name: BROWSER_MCP_SERVER_NAME, entry: browserMcpServerEntry() },
];

function claudeServers(browser: boolean): readonly ClaudeServer[] {
  return browser
    ? CLAUDE_SERVERS
    : CLAUDE_SERVERS.filter((server) => server.name === MCP_SERVER_NAME);
}

async function removeClaudeMcpServer(
  claudeBin: string,
  env: EnvLike,
  name: string,
): Promise<boolean> {
  const result = await runCommand(
    claudeBin,
    ["mcp", "remove", "--scope", "user", name],
    { env: { ...env }, cleanEnv: true },
  );
  if (result.ok) {
    return true;
  }
  if (isNotFoundRemoveFailure(result)) {
    return false;
  }
  throw commandFailure("remove", name, result);
}

async function addClaudeMcpServerOrRepair(
  claudeBin: string,
  configPath: string,
  env: EnvLike,
  server: ClaudeServer,
): Promise<boolean> {
  const add = async () =>
    runCommand(
      claudeBin,
      [
        "mcp",
        "add",
        "--scope",
        "user",
        server.name,
        "--",
        server.entry.command,
        ...server.entry.args,
      ],
      { env: { ...env }, cleanEnv: true },
    );
  const result = await add();
  if (result.ok) {
    return true;
  }
  if (!isAlreadyRegisteredAddFailure(server.name, result)) {
    throw commandFailure("add", server.name, result);
  }
  const registered = await jsonFileMcpServerState(configPath, {
    expected: server.entry,
    serverName: server.name,
  });
  if (registered === true) {
    return false;
  }
  await removeClaudeMcpServer(claudeBin, env, server.name);
  const retry = await add();
  if (retry.ok) {
    return true;
  }
  throw commandFailure("add", server.name, retry);
}

async function removeClaudeMcpServers(
  claudeBin: string,
  env: EnvLike,
): Promise<boolean> {
  let changed = false;
  for (const { name } of CLAUDE_SERVERS) {
    changed = (await removeClaudeMcpServer(claudeBin, env, name)) || changed;
  }
  return changed;
}

export async function claudeCodeIsRegistered(
  configPath: string,
): Promise<RegistrationState> {
  return jsonFileMcpServerState(configPath);
}

async function allClaudeServersRegistered(
  configPath: string,
  servers: readonly ClaudeServer[],
): Promise<boolean> {
  for (const server of servers) {
    const state = await jsonFileMcpServerState(configPath, {
      expected: server.entry,
      serverName: server.name,
    });
    if (state !== true) {
      return false;
    }
  }
  return true;
}

async function linkClaudeCodeWithBinary(
  claudeBin: string,
  configPath: string,
  env: EnvLike,
  opts: LinkOptions,
): Promise<ChangeResult> {
  const migratedLegacyEntries =
    await ownedLegacyMcpServerNamesInJsonFile(configPath);
  const currentBrowserEntries = await jsonFileRetainedMcpServerNames(configPath);
  const browser = wantsBrowserEntry(
    opts,
    migratedLegacyEntries,
    currentBrowserEntries.length > 0,
  );
  const servers = claudeServers(browser);
  const retainedEntries = browser ? [] : currentBrowserEntries;
  const retained = retainedEntries.length === 0 ? {} : { retainedEntries };
  if (
    migratedLegacyEntries.length === 0 &&
    (await allClaudeServersRegistered(configPath, servers))
  ) {
    return { configPath, changed: false, ...retained };
  }
  let changed = false;
  for (const name of migratedLegacyEntries) {
    changed = (await removeClaudeMcpServer(claudeBin, env, name)) || changed;
  }
  for (const server of servers) {
    changed =
      (await addClaudeMcpServerOrRepair(claudeBin, configPath, env, server)) ||
      changed;
  }
  return {
    configPath,
    changed,
    ...(migratedLegacyEntries.length === 0 ? {} : { migratedLegacyEntries }),
    ...retained,
  };
}

export async function linkClaudeCode(
  configPath: string,
  env: EnvLike = process.env,
  opts: LinkOptions = {},
): Promise<ChangeResult> {
  const claudeBin = findClaudeBinary(env);
  if (claudeBin !== undefined) {
    return linkClaudeCodeWithBinary(claudeBin, configPath, env, opts);
  }
  const migration = await replaceOwnedLegacyMcpServersInJsonFile(
    configPath,
    opts,
  );
  if (migration.changed) {
    return { ...migration, warning: DIRECT_EDIT_WARNING };
  }
  let exists = false;
  try {
    await fs.promises.access(configPath, fs.constants.F_OK);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) {
    return {
      configPath,
      changed: false,
      instructions:
        `Claude Code config not found at ${configPath}; register manually ` +
        `with: ${manualCommand(opts.browser === true)}`,
    };
  }
  const result = await mergeMcpServerIntoJsonFile(configPath, {
    createIfMissing: false,
    browser: opts.browser,
  });
  return result.changed ? { ...result, warning: DIRECT_EDIT_WARNING } : result;
}

export async function unlinkClaudeCode(
  configPath: string,
  env: EnvLike = process.env,
): Promise<ChangeResult> {
  const claudeBin = findClaudeBinary(env);
  if (claudeBin !== undefined) {
    return {
      configPath,
      changed: await removeClaudeMcpServers(claudeBin, env),
    };
  }
  const result = await removeMcpServerFromJsonFile(configPath);
  return result.changed ? { ...result, warning: DIRECT_EDIT_WARNING } : result;
}
