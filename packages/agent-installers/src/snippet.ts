import fs from "node:fs";
import path from "node:path";
import { agentsDir, DEVICE_PASS_WORKFLOW, ensureDir, type EnvLike } from "@pickforge/lab-core";
import type { LinkOptions, McpServerEntry } from "./types.js";

export const MCP_SERVER_NAME = "pickforge-lab";
export const BROWSER_MCP_SERVER_NAME = "pickforge-lab-browser";
export const LEGACY_MCP_SERVER_NAME = "picklab";
export const LEGACY_BROWSER_MCP_SERVER_NAME = "picklab-browser";

export const SHARED_SNIPPET_BASENAMES = [
  "pickforge-mcp.json",
  "pickforge-mcp.toml",
  "device-pass.md",
] as const;
export const LEGACY_SHARED_SNIPPET_BASENAMES = [
  "picklab-mcp.json",
  "picklab-mcp.toml",
] as const;

export function mcpServerEntry(): McpServerEntry {
  return { command: "pickforge-lab", args: ["mcp", "serve"] };
}

export function browserMcpServerEntry(): McpServerEntry {
  return { command: "pickforge-lab", args: ["browser", "devtools-mcp"] };
}

export function pickforgeLabMcpServerEntries(
  opts: LinkOptions = {},
): Record<string, McpServerEntry> {
  return {
    [MCP_SERVER_NAME]: mcpServerEntry(),
    ...(opts.browser === true
      ? { [BROWSER_MCP_SERVER_NAME]: browserMcpServerEntry() }
      : {}),
  };
}

/**
 * Browser is written when requested, or when an owned legacy browser entry is
 * migrated and no current browser entry exists yet. An existing current entry
 * is never overwritten without the explicit flag.
 */
export function wantsBrowserEntry(
  opts: LinkOptions,
  migratedLegacyEntries: string[],
  hasCurrentBrowserEntry: boolean,
): boolean {
  if (opts.browser === true) {
    return true;
  }
  return (
    !hasCurrentBrowserEntry &&
    migratedLegacyEntries.includes(LEGACY_BROWSER_MCP_SERVER_NAME)
  );
}

function snippetEntries(
  entry: McpServerEntry | undefined,
  opts: LinkOptions,
): Record<string, McpServerEntry> {
  return entry === undefined
    ? pickforgeLabMcpServerEntries(opts)
    : { [MCP_SERVER_NAME]: entry };
}

export function legacyMcpServerEntries(): Record<string, McpServerEntry> {
  return {
    [LEGACY_MCP_SERVER_NAME]: {
      command: "picklab",
      args: ["mcp", "serve"],
    },
    [LEGACY_BROWSER_MCP_SERVER_NAME]: {
      command: "picklab",
      args: ["browser", "devtools-mcp"],
    },
  };
}

export function renderJsonSnippet(
  entry?: McpServerEntry,
  opts: LinkOptions = {},
): string {
  const entries = snippetEntries(entry, opts);
  return `${JSON.stringify({ mcpServers: entries }, null, 2)}\n`;
}

export function renderTomlSnippet(
  entry?: McpServerEntry,
  opts: LinkOptions = {},
): string {
  const entries = snippetEntries(entry, opts);
  return Object.entries(entries)
    .map(([name, server]) => {
      const args = server.args.map((arg) => JSON.stringify(arg)).join(", ");
      return (
        `[mcp_servers.${JSON.stringify(name)}]\n` +
        `command = ${JSON.stringify(server.command)}\n` +
        `args = [${args}]\n`
      );
    })
    .join("");
}

export interface SharedSnippets {
  jsonPath: string;
  tomlPath: string;
  devicePassPath: string;
}

export async function writeSharedSnippets(
  env: EnvLike = process.env,
): Promise<SharedSnippets> {
  const dir = await ensureDir(agentsDir(env));
  const jsonPath = path.join(dir, SHARED_SNIPPET_BASENAMES[0]);
  const tomlPath = path.join(dir, SHARED_SNIPPET_BASENAMES[1]);
  await fs.promises.writeFile(jsonPath, renderJsonSnippet(), "utf8");
  await fs.promises.writeFile(tomlPath, renderTomlSnippet(), "utf8");
  const devicePassPath = path.join(dir, SHARED_SNIPPET_BASENAMES[2]);
  await fs.promises.writeFile(devicePassPath, DEVICE_PASS_WORKFLOW, "utf8");
  return { jsonPath, tomlPath, devicePassPath };
}
