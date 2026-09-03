export const packageName = "@pickforge/lab-agent-installers";

export {
  AGENT_KINDS,
  type AgentKind,
  type AgentStatus,
  type ChangeResult,
  type McpServerEntry,
  type RegistrationState,
} from "./types.js";

export {
  agentsStatePath,
  readAgentsState,
  recordAgentState,
  type AgentsState,
  type AgentStateEntry,
} from "./state.js";

export {
  MCP_SERVER_NAME,
  BROWSER_MCP_SERVER_NAME,
  browserMcpServerEntry,
  mcpServerEntry,
  picklabMcpServerEntries,
  renderJsonSnippet,
  renderTomlSnippet,
  SHARED_SNIPPET_BASENAMES,
  writeSharedSnippets,
  type SharedSnippets,
} from "./snippet.js";

export { backupFile, isBackupPath, BACKUP_PATTERN } from "./backup.js";

export {
  jsonFileHasMcpServer,
  jsonFileMcpServerState,
  mergeMcpServerIntoJsonFile,
  removeMcpServerFromJsonFile,
  type JsonMergeOptions,
  type JsonMcpServerStateOptions,
} from "./jsonConfig.js";

export {
  inspectTomlFile,
  removeTomlMarkerBlock,
  TOML_MARKER_BEGIN,
  TOML_MARKER_END,
  tomlFileHasMcpServer,
  upsertTomlMarkerBlock,
  type TomlInspection,
} from "./tomlConfig.js";

export {
  builtinAgent,
  BUILTIN_AGENTS,
  type BuiltinAgent,
} from "./agents/builtin.js";

export {
  codexConfigPath,
  codexIsRegistered,
  linkCodex,
  unlinkCodex,
} from "./agents/codex.js";

export {
  CLAUDE_CODE_MANUAL_COMMAND,
  claudeCodeConfigPath,
  claudeCodeIsRegistered,
  findClaudeBinary,
  linkClaudeCode,
  unlinkClaudeCode,
} from "./agents/claude-code.js";

export {
  cursorConfigPath,
  cursorIsRegistered,
  linkCursor,
  unlinkCursor,
} from "./agents/cursor.js";

export {
  addCustomAgent,
  customAgentConfigPath,
  listCustomAgents,
  parseMcpCommand,
  removeCustomAgent,
  validateCustomAgentName,
  type CustomAgent,
} from "./agents/custom.js";

export {
  runAgentsDoctor,
  type AgentsDoctorCheck,
  type AgentsDoctorOptions,
  type AgentsDoctorReport,
  type AgentsDoctorStatus,
} from "./doctor.js";
