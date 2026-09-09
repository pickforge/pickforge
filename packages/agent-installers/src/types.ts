export type AgentKind = "codex" | "claude-code" | "cursor" | "pi";

export const AGENT_KINDS: readonly AgentKind[] = [
  "codex",
  "claude-code",
  "cursor",
  "pi",
];

export interface McpServerEntry {
  command: string;
  args: string[];
}

export interface LinkOptions {
  /** Also register the pickforge-lab-browser DevTools relay (opt-in). */
  browser?: boolean;
}

export interface ChangeResult {
  configPath: string;
  changed: boolean;
  backupPath?: string;
  migratedLegacyEntries?: string[];
  /** Pickforge-named entries left untouched because they were not requested. */
  retainedEntries?: string[];
  instructions?: string;
  warning?: string;
}

export type RegistrationState = boolean | "unknown";

export interface AgentStatus {
  name: string;
  kind: AgentKind | "custom";
  configPath: string;
  configExists: boolean;
  registered: RegistrationState;
}
