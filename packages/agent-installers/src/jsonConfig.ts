import fs from "node:fs";
import { writeFileAtomic } from "@pickforge/lab-core";
import { backupFile } from "./backup.js";
import {
  BROWSER_MCP_SERVER_NAME,
  MCP_SERVER_NAME,
  legacyMcpServerEntries,
  pickforgeLabMcpServerEntries,
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

function ownedLegacyEntryNames(servers: JsonObject): string[] {
  return Object.entries(legacyMcpServerEntries())
    .filter(([name, entry]) => entryMatches(servers[name], entry))
    .map(([name]) => name);
}

export async function ownedLegacyMcpServerNamesInJsonFile(
  filePath: string,
): Promise<string[]> {
  let config: JsonObject | undefined;
  try {
    config = await readJsonObject(filePath);
  } catch {
    return [];
  }
  return config !== undefined && isPlainObject(config.mcpServers)
    ? ownedLegacyEntryNames(config.mcpServers)
    : [];
}

function normalizedEntry(entry: McpServerEntry): McpServerEntry {
  return { command: entry.command, args: entry.args };
}

function mergedServers(
  servers: JsonObject,
  entries: Record<string, McpServerEntry>,
  legacyNames: string[],
): JsonObject {
  const next = { ...servers };
  for (const name of legacyNames) {
    delete next[name];
  }
  for (const [name, entry] of Object.entries(entries)) {
    next[name] = normalizedEntry(entry);
  }
  return next;
}

function withServers(config: JsonObject, servers: JsonObject): JsonObject {
  return { ...config, mcpServers: servers };
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
      ? pickforgeLabMcpServerEntries()
      : { [MCP_SERVER_NAME]: opts.entry };
  const existing = await readJsonObject(filePath);
  if (existing === undefined && !opts.createIfMissing) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const config = existing ?? {};
  const servers = isPlainObject(config.mcpServers) ? config.mcpServers : {};
  const migratedLegacyEntries = ownedLegacyEntryNames(servers);
  const alreadyCurrent = Object.entries(entries).every(([name, entry]) =>
    entryMatches(servers[name], entry),
  );
  if (alreadyCurrent && migratedLegacyEntries.length === 0) {
    return { configPath: filePath, changed: false };
  }
  const backupPath =
    existing === undefined ? undefined : await backupFile(filePath);
  const nextServers = mergedServers(servers, entries, migratedLegacyEntries);
  await writeJsonObject(filePath, withServers(config, nextServers));
  return {
    configPath: filePath,
    changed: true,
    backupPath,
    migratedLegacyEntries,
  };
}

/** Replace only owned legacy entries, without creating or otherwise editing a config. */
export async function replaceOwnedLegacyMcpServersInJsonFile(
  filePath: string,
): Promise<ChangeResult> {
  let config: JsonObject | undefined;
  try {
    config = await readJsonObject(filePath);
  } catch {
    return { configPath: filePath, changed: false };
  }
  if (config === undefined || !isPlainObject(config.mcpServers)) {
    return { configPath: filePath, changed: false };
  }
  const migratedLegacyEntries = ownedLegacyEntryNames(config.mcpServers);
  if (migratedLegacyEntries.length === 0) {
    return { configPath: filePath, changed: false };
  }
  const backupPath = await backupFile(filePath);
  const nextServers = mergedServers(
    config.mcpServers,
    pickforgeLabMcpServerEntries(),
    migratedLegacyEntries,
  );
  await writeJsonObject(filePath, withServers(config, nextServers));
  return {
    configPath: filePath,
    changed: true,
    backupPath,
    migratedLegacyEntries,
  };
}

export async function removeMcpServerFromJsonFile(
  filePath: string,
): Promise<ChangeResult> {
  const existing = await readJsonObject(filePath);
  if (existing === undefined || !isPlainObject(existing.mcpServers)) {
    return { configPath: filePath, changed: false };
  }
  const existingServers = existing.mcpServers;
  const migratedLegacyEntries = ownedLegacyEntryNames(existingServers);
  const currentNames = [MCP_SERVER_NAME, BROWSER_MCP_SERVER_NAME].filter(
    (name) => name in existingServers,
  );
  const names = [...currentNames, ...migratedLegacyEntries];
  if (names.length === 0) {
    return { configPath: filePath, changed: false };
  }
  const backupPath = await backupFile(filePath);
  const servers = { ...existingServers };
  for (const name of names) {
    delete servers[name];
  }
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
      ? pickforgeLabMcpServerEntries()
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
