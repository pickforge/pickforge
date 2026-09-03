import fs from "node:fs";
import path from "node:path";
import { runCommand, type EnvLike } from "@pickforge/lab-core";
import {
  jsonFileMcpServerState,
  mergeMcpServerIntoJsonFile,
  removeMcpServerFromJsonFile,
  replaceOwnedLegacyMcpServersInJsonFile,
} from "../jsonConfig.js";
import {
  BROWSER_MCP_SERVER_NAME,
  MCP_SERVER_NAME,
  browserMcpServerEntry,
  mcpServerEntry,
} from "../snippet.js";
import type { ChangeResult, RegistrationState } from "../types.js";
import { homeDir } from "./home.js";

export const CLAUDE_CODE_MANUAL_COMMAND =
  "claude mcp add --scope user pickforge-lab -- pickforge-lab mcp serve && " +
  "claude mcp add --scope user pickforge-lab-browser -- pickforge-lab browser devtools-mcp";

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

const CLAUDE_SERVERS = [
  { name: MCP_SERVER_NAME, entry: mcpServerEntry() },
  { name: BROWSER_MCP_SERVER_NAME, entry: browserMcpServerEntry() },
] as const;

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
  server: (typeof CLAUDE_SERVERS)[number],
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

export async function linkClaudeCode(
  configPath: string,
  env: EnvLike = process.env,
): Promise<ChangeResult> {
  const claudeBin = findClaudeBinary(env);
  const migration = await replaceOwnedLegacyMcpServersInJsonFile(configPath);
  if (migration.changed) {
    return {
      ...migration,
      warning:
        claudeBin === undefined
          ? DIRECT_EDIT_WARNING
          : "the owned legacy MCP entries were replaced atomically by editing " +
            "the config directly; close Claude Code while linking, or it may " +
            "overwrite the change",
    };
  }
  if (claudeBin !== undefined) {
    if ((await claudeCodeIsRegistered(configPath)) === true) {
      return { configPath, changed: false };
    }
    let changed = false;
    for (const server of CLAUDE_SERVERS) {
      changed =
        (await addClaudeMcpServerOrRepair(
          claudeBin,
          configPath,
          env,
          server,
        )) || changed;
    }
    return { configPath, changed };
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
        `with: ${CLAUDE_CODE_MANUAL_COMMAND}`,
    };
  }
  const result = await mergeMcpServerIntoJsonFile(configPath, {
    createIfMissing: false,
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
