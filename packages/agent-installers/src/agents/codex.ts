import path from "node:path";
import type { EnvLike } from "@pickforge/lab-core";
import {
  removeTomlMarkerBlock,
  tomlFileHasMcpServer,
  upsertTomlMarkerBlock,
} from "../tomlConfig.js";
import type { ChangeResult } from "../types.js";
import { homeDir } from "./home.js";

export function codexConfigPath(env: EnvLike = process.env): string {
  const codexHome = env.CODEX_HOME;
  if (codexHome !== undefined && codexHome !== "") {
    return path.join(codexHome, "config.toml");
  }
  return path.join(homeDir(env), ".codex", "config.toml");
}

export async function codexIsRegistered(configPath: string): Promise<boolean> {
  return tomlFileHasMcpServer(configPath);
}

export async function linkCodex(configPath: string): Promise<ChangeResult> {
  return upsertTomlMarkerBlock(configPath);
}

export async function unlinkCodex(configPath: string): Promise<ChangeResult> {
  return removeTomlMarkerBlock(configPath);
}
