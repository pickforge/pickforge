import fs from "node:fs";
import path from "node:path";
import { agentsDir, ensureDir, type EnvLike } from "@pickforge/lab-core";
import type { McpServerEntry } from "./types.js";

export const MCP_SERVER_NAME = "pickforge-lab";
export const BROWSER_MCP_SERVER_NAME = "pickforge-lab-browser";
export const LEGACY_MCP_SERVER_NAME = "picklab";
export const LEGACY_BROWSER_MCP_SERVER_NAME = "picklab-browser";

export const SHARED_SNIPPET_BASENAMES = [
  "pickforge-mcp.json",
  "pickforge-mcp.toml",
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

export function pickforgeLabMcpServerEntries(): Record<string, McpServerEntry> {
  return {
    [MCP_SERVER_NAME]: mcpServerEntry(),
    [BROWSER_MCP_SERVER_NAME]: browserMcpServerEntry(),
  };
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

export function renderJsonSnippet(entry?: McpServerEntry): string {
  const entries =
    entry === undefined
      ? pickforgeLabMcpServerEntries()
      : { [MCP_SERVER_NAME]: entry };
  return `${JSON.stringify({ mcpServers: entries }, null, 2)}\n`;
}

export function renderTomlSnippet(entry?: McpServerEntry): string {
  const entries =
    entry === undefined
      ? pickforgeLabMcpServerEntries()
      : { [MCP_SERVER_NAME]: entry };
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
}

export async function writeSharedSnippets(
  env: EnvLike = process.env,
): Promise<SharedSnippets> {
  const dir = await ensureDir(agentsDir(env));
  const jsonPath = path.join(dir, SHARED_SNIPPET_BASENAMES[0]);
  const tomlPath = path.join(dir, SHARED_SNIPPET_BASENAMES[1]);
  await fs.promises.writeFile(jsonPath, renderJsonSnippet(), "utf8");
  await fs.promises.writeFile(tomlPath, renderTomlSnippet(), "utf8");
  return { jsonPath, tomlPath };
}
