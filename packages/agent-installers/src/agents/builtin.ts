import type { EnvLike } from "@pickforge/lab-core";
import type { AgentKind, ChangeResult, RegistrationState } from "../types.js";
import {
  claudeCodeConfigPath,
  claudeCodeIsRegistered,
  linkClaudeCode,
  unlinkClaudeCode,
} from "./claude-code.js";
import {
  codexConfigPath,
  codexIsRegistered,
  linkCodex,
  unlinkCodex,
} from "./codex.js";
import {
  cursorConfigPath,
  cursorIsRegistered,
  linkCursor,
  unlinkCursor,
} from "./cursor.js";

export interface BuiltinAgent {
  name: AgentKind;
  defaultConfigPath(env: EnvLike): string;
  isRegistered(configPath: string): Promise<RegistrationState>;
  link(configPath: string, env?: EnvLike): Promise<ChangeResult>;
  unlink(configPath: string, env?: EnvLike): Promise<ChangeResult>;
}

export const BUILTIN_AGENTS: Record<AgentKind, BuiltinAgent> = {
  codex: {
    name: "codex",
    defaultConfigPath: codexConfigPath,
    isRegistered: codexIsRegistered,
    link: linkCodex,
    unlink: unlinkCodex,
  },
  "claude-code": {
    name: "claude-code",
    defaultConfigPath: claudeCodeConfigPath,
    isRegistered: claudeCodeIsRegistered,
    link: linkClaudeCode,
    unlink: unlinkClaudeCode,
  },
  cursor: {
    name: "cursor",
    defaultConfigPath: cursorConfigPath,
    isRegistered: cursorIsRegistered,
    link: linkCursor,
    unlink: unlinkCursor,
  },
};

export function builtinAgent(name: string): BuiltinAgent | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_AGENTS, name)
    ? BUILTIN_AGENTS[name as AgentKind]
    : undefined;
}
