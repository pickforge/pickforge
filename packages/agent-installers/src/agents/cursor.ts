import path from "node:path";
import type { EnvLike } from "@pickforge/lab-core";
import {
  jsonFileMcpServerState,
  mergeMcpServerIntoJsonFile,
  removeMcpServerFromJsonFile,
} from "../jsonConfig.js";
import type { ChangeResult, RegistrationState } from "../types.js";
import { homeDir } from "./home.js";

export function cursorConfigPath(env: EnvLike = process.env): string {
  return path.join(homeDir(env), ".cursor", "mcp.json");
}

export async function cursorIsRegistered(
  configPath: string,
): Promise<RegistrationState> {
  return jsonFileMcpServerState(configPath);
}

export async function linkCursor(configPath: string): Promise<ChangeResult> {
  return mergeMcpServerIntoJsonFile(configPath, { createIfMissing: true });
}

export async function unlinkCursor(configPath: string): Promise<ChangeResult> {
  return removeMcpServerFromJsonFile(configPath);
}
