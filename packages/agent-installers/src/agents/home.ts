import os from "node:os";
import type { EnvLike } from "@pickforge/lab-core";

export function homeDir(env: EnvLike): string {
  const fromEnv = env.HOME;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return os.homedir();
}
