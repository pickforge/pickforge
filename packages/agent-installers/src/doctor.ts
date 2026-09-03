import fs from "node:fs";
import path from "node:path";
import { agentsDir, type EnvLike } from "@pickforge/lab-core";
import { BUILTIN_AGENTS } from "./agents/builtin.js";
import { isBackupPath } from "./backup.js";
import {
  jsonFileMcpServerState,
  ownedLegacyMcpServerNamesInJsonFile,
} from "./jsonConfig.js";
import { readAgentsState, type AgentStateEntry } from "./state.js";
import { inspectTomlFile } from "./tomlConfig.js";
import type { AgentKind, RegistrationState } from "./types.js";

export type AgentsDoctorStatus = "ok" | "warn" | "problem";

export interface AgentsDoctorCheck {
  id: string;
  status: AgentsDoctorStatus;
  detail: string;
}

export interface AgentsDoctorReport {
  ok: boolean;
  checks: AgentsDoctorCheck[];
}

export interface AgentsDoctorOptions {
  env?: EnvLike;
  configPaths?: Partial<Record<AgentKind, string>>;
}

const BACKUP_CLUTTER_THRESHOLD = 3;

async function checkAgentsDir(
  env: EnvLike,
  checks: AgentsDoctorCheck[],
): Promise<void> {
  const dir = agentsDir(env);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      checks.push({
        id: "agents-dir",
        status: "ok",
        detail: `${dir} does not exist yet (created on first link)`,
      });
      return;
    }
    throw error;
  }
  const broken: string[] = [];
  for (const basename of entries.sort()) {
    const entryPath = path.join(dir, basename);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(entryPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        continue;
      }
      throw error;
    }
    if (!stat.isSymbolicLink()) {
      continue;
    }
    try {
      await fs.promises.stat(entryPath);
    } catch {
      broken.push(entryPath);
    }
  }
  if (broken.length > 0) {
    checks.push({
      id: "agents-dir",
      status: "problem",
      detail: `broken symlink(s): ${broken.join(", ")}`,
    });
    return;
  }
  checks.push({ id: "agents-dir", status: "ok", detail: dir });
}

async function countBackups(configPath: string): Promise<number> {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  return entries.filter(
    (entry) => entry.startsWith(`${base}.`) && isBackupPath(entry),
  ).length;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function stateEntryForPath(
  stateEntry: AgentStateEntry | undefined,
  configPath: string,
): AgentStateEntry | undefined {
  if (stateEntry === undefined) {
    return undefined;
  }
  return path.resolve(stateEntry.configPath) === path.resolve(configPath)
    ? stateEntry
    : undefined;
}

async function checkBuiltinAgent(
  name: AgentKind,
  configPath: string,
  checks: AgentsDoctorCheck[],
  recordedEntry: AgentStateEntry | undefined,
): Promise<void> {
  const id = `agent-${name}`;
  const stateEntry = stateEntryForPath(recordedEntry, configPath);
  const exists = await fileExists(configPath);
  const backups = await countBackups(configPath);
  if (!exists) {
    if (stateEntry?.registered === true) {
      checks.push({
        id,
        status: "problem",
        detail:
          `stale: Pickforge linked ${configPath} but the file no longer ` +
          `exists (re-run: pickforge-lab agents link)`,
      });
      return;
    }
    checks.push({
      id,
      status: "ok",
      detail: `not registered (${configPath} does not exist)`,
    });
    return;
  }
  if (name === "codex") {
    const inspection = await inspectTomlFile(configPath);
    if (inspection.legacyMarkersPresent) {
      checks.push({
        id,
        status: "problem",
        detail:
          `stale: ${configPath} has an owned legacy picklab entry ` +
          `(re-run: pickforge-lab agents link codex)`,
      });
      return;
    }
    if (inspection.markersPresent && !inspection.markersHaveSection) {
      checks.push({
        id,
        status: "problem",
        detail:
          `stale: ${configPath} has pickforge-lab markers without a ` +
          `[mcp_servers."pickforge-lab"] section ` +
          `(re-run: pickforge-lab agents link codex)`,
      });
      return;
    }
    if (inspection.foreignSection && !inspection.markersPresent) {
      checks.push({
        id,
        status: "warn",
        detail:
          `${configPath} has a Pickforge Lab MCP section that Pickforge ` +
          `does not manage`,
      });
      return;
    }
    pushRegistrationCheck(
      checks,
      id,
      configPath,
      inspection.markersHaveSection,
      backups,
      stateEntry,
    );
    return;
  }
  const registered = await jsonFileMcpServerState(configPath);
  const ownedLegacyEntries =
    await ownedLegacyMcpServerNamesInJsonFile(configPath);
  if (registered === false && ownedLegacyEntries.length > 0) {
    checks.push({
      id,
      status: "problem",
      detail:
        `stale: ${configPath} has an owned legacy picklab entry ` +
        `(re-run: pickforge-lab agents link ${name})`,
    });
    return;
  }
  pushRegistrationCheck(checks, id, configPath, registered, backups, stateEntry);
}

function pushRegistrationCheck(
  checks: AgentsDoctorCheck[],
  id: string,
  configPath: string,
  registered: RegistrationState,
  backups: number,
  stateEntry: AgentStateEntry | undefined,
): void {
  if (registered === "unknown") {
    checks.push({
      id,
      status: "warn",
      detail:
        `${configPath} exists but is not parseable as strict JSON ` +
        `(JSONC comments or trailing commas?); cannot tell whether pickforge-lab ` +
        `is registered`,
    });
    return;
  }
  if (!registered && stateEntry?.registered === true) {
    checks.push({
      id,
      status: "problem",
      detail:
        `stale: Pickforge linked ${configPath} but the pickforge-lab entry is gone ` +
        `(re-run: pickforge-lab agents link)`,
    });
    return;
  }
  if (backups > BACKUP_CLUTTER_THRESHOLD) {
    checks.push({
      id,
      status: "warn",
      detail: `${backups} pickforge-lab backups next to ${configPath}; consider pruning`,
    });
    return;
  }
  if (!registered && stateEntry === undefined && backups > 0) {
    checks.push({
      id,
      status: "warn",
      detail:
        `${configPath} has ${backups} pickforge-lab backup(s) but no pickforge-lab ` +
        `entry; it may have been edited outside Pickforge ` +
        `(re-link with: pickforge-lab agents link)`,
    });
    return;
  }
  checks.push({
    id,
    status: "ok",
    detail: registered
      ? `registered in ${configPath}`
      : stateEntry?.registered === false
        ? `not registered in ${configPath} (unlinked by pickforge-lab)`
        : `not registered in ${configPath}`,
  });
}

function checkPickforgeOnPath(env: EnvLike, checks: AgentsDoctorCheck[]): void {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = path.join(dir, "pickforge-lab");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        checks.push({ id: "pickforge-lab-bin", status: "ok", detail: candidate });
        return;
      }
    } catch {
      continue;
    }
  }
  checks.push({
    id: "pickforge-lab-bin",
    status: "warn",
    detail:
      "pickforge-lab is not on PATH; registered agents will fail to start the MCP " +
      "server (install globally or adjust PATH)",
  });
}

export async function runAgentsDoctor(
  opts: AgentsDoctorOptions = {},
): Promise<AgentsDoctorReport> {
  const env = opts.env ?? process.env;
  const checks: AgentsDoctorCheck[] = [];
  await checkAgentsDir(env, checks);
  const state = await readAgentsState(env);
  for (const agent of Object.values(BUILTIN_AGENTS)) {
    const configPath =
      opts.configPaths?.[agent.name] ?? agent.defaultConfigPath(env);
    await checkBuiltinAgent(
      agent.name,
      configPath,
      checks,
      state.agents[agent.name],
    );
  }
  checkPickforgeOnPath(env, checks);
  return {
    ok: !checks.some((check) => check.status === "problem"),
    checks,
  };
}
