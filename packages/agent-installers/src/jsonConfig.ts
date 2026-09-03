import fs from "node:fs";
import { writeFileAtomic } from "@pickforge/lab-core";
import { backupFile } from "./backup.js";
import {
  BROWSER_MCP_SERVER_NAME,
  MCP_SERVER_NAME,
  picklabMcpServerEntries,
} from "./snippet.js";
import type {
  ChangeResult,
  McpServerEntry,
  RegistrationState,
} from "./types.js";

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

async function readJsonObject(
  filePath: string,
): Promise<JsonObject | undefined> {
  const raw = await readTextIfExists(filePath);
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Refusing to edit ${filePath}: invalid JSON ` +
        `(${(error as Error).message}). Fix the file and retry.`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `Refusing to edit ${filePath}: expected a top-level JSON object`,
    );
  }
  return parsed;
}

async function writeJsonObject(
  filePath: string,
  value: JsonObject,
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function entryMatches(current: unknown, entry: McpServerEntry): boolean {
  if (!isPlainObject(current)) {
    return false;
  }
  return (
    current.command === entry.command &&
    JSON.stringify(current.args) === JSON.stringify(entry.args)
  );
}

export interface JsonMergeOptions {
  createIfMissing: boolean;
  entry?: McpServerEntry;
}

export async function mergeMcpServerIntoJsonFile(
  filePath: string,
  opts: JsonMergeOptions,
): Promise<ChangeResult> {
  const entries =
    opts.entry === undefined
      ? picklabMcpServerEntries()
      : { [MCP_SERVER_NAME]: opts.entry };
  const existing = await readJsonObject(filePath);
  if (existing === undefined && !opts.createIfMissing) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const config = existing ?? {};
  const servers = isPlainObject(config.mcpServers) ? config.mcpServers : {};
  if (
    Object.entries(entries).every(([name, entry]) =>
      entryMatches(servers[name], entry),
    )
  ) {
    return { configPath: filePath, changed: false };
  }
  const backupPath =
    existing === undefined ? undefined : await backupFile(filePath);
  const next: JsonObject = {
    ...config,
    mcpServers: {
      ...servers,
      ...Object.fromEntries(
        Object.entries(entries).map(([name, entry]) => [
          name,
          { command: entry.command, args: entry.args },
        ]),
      ),
    },
  };
  await writeJsonObject(filePath, next);
  return { configPath: filePath, changed: true, backupPath };
}

export async function removeMcpServerFromJsonFile(
  filePath: string,
): Promise<ChangeResult> {
  const existing = await readJsonObject(filePath);
  if (existing === undefined || !isPlainObject(existing.mcpServers)) {
    return { configPath: filePath, changed: false };
  }
  if (
    !(MCP_SERVER_NAME in existing.mcpServers) &&
    !(BROWSER_MCP_SERVER_NAME in existing.mcpServers)
  ) {
    return { configPath: filePath, changed: false };
  }
  const backupPath = await backupFile(filePath);
  const servers = { ...existing.mcpServers };
  delete servers[MCP_SERVER_NAME];
  delete servers[BROWSER_MCP_SERVER_NAME];
  const next: JsonObject = { ...existing };
  if (Object.keys(servers).length === 0) {
    delete next.mcpServers;
  } else {
    next.mcpServers = servers;
  }
  await writeJsonObject(filePath, next);
  return { configPath: filePath, changed: true, backupPath };
}

export interface JsonMcpServerStateOptions {
  expected?: McpServerEntry;
  serverName?: string;
}

export async function jsonFileMcpServerState(
  filePath: string,
  opts: JsonMcpServerStateOptions = {},
): Promise<RegistrationState> {
  let config: JsonObject | undefined;
  try {
    config = await readJsonObject(filePath);
  } catch {
    return "unknown";
  }
  if (config === undefined || !isPlainObject(config.mcpServers)) {
    return false;
  }
  const servers = config.mcpServers;
  const expected =
    opts.expected === undefined
      ? picklabMcpServerEntries()
      : { [opts.serverName ?? MCP_SERVER_NAME]: opts.expected };
  return Object.entries(expected).every(([name, entry]) =>
    entryMatches(servers[name], entry),
  );
}

export async function jsonFileHasMcpServer(
  filePath: string,
  opts?: JsonMcpServerStateOptions,
): Promise<boolean> {
  return (await jsonFileMcpServerState(filePath, opts)) === true;
}
