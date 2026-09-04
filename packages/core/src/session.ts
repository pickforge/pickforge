import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { finalizeActiveEvidenceRunHandle } from "./evidence.js";
import { writeEvidenceReport } from "./evidence-render.js";
import {
  ensureDir,
  legacySessionsDirs,
  listDirSafe,
  sessionsDir,
  writeFileAtomic,
  type EnvLike,
} from "./paths.js";
import { isPidAlive, processIdentityMatches } from "./proc.js";

export type SessionType = "desktop" | "android" | "desktop+android" | "browser";
export type SessionStatus = "starting" | "running" | "stopped" | "error";

export interface DesktopSessionInfo {
  display: string;
  xvfbPid?: number;
  xvfbStartTimeTicks?: number;
  vncPid?: number;
  vncStartTimeTicks?: number;
  vncPort?: number;
  vncViewOnly?: boolean;
  width?: number;
  height?: number;
}

export interface AndroidSessionInfo {
  avdName: string;
  serial?: string;
  emulatorPid?: number;
  consolePort?: number;
}

export interface BrowserSessionInfo {
  browserPid: number;
  browserStartTimeTicks: number;
  binaryPath: string;
  profileMode: "ephemeral";
  profileDir: string;
  cdpPort?: number;
}

export interface SessionRecord {
  id: string;
  type: SessionType;
  createdAt: string;
  status: SessionStatus;
  projectDir: string;
  desktop?: DesktopSessionInfo;
  android?: AndroidSessionInfo;
  browser?: BrowserSessionInfo;
  meta?: Record<string, unknown>;
}

export interface CreateSessionInput {
  type: SessionType;
  projectDir: string;
  status?: SessionStatus;
  desktop?: DesktopSessionInfo;
  android?: AndroidSessionInfo;
  browser?: BrowserSessionInfo;
  meta?: Record<string, unknown>;
}

export type SessionLivenessCheck = (
  record: SessionRecord,
) => boolean | Promise<boolean>;

const ID_PREFIXES: Record<SessionType, string> = {
  desktop: "desk",
  android: "andr",
  "desktop+android": "duo",
  browser: "brow",
};

const SESSION_ID_PATTERN = /^(desk|andr|duo|brow)-[0-9a-f]{6,}$/;
const MAX_ID_ATTEMPTS = 5;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

function invalidSessionIdError(id: string): Error {
  return new Error(
    `Invalid session id "${id}": must match ${SESSION_ID_PATTERN}`,
  );
}

function newSessionId(type: SessionType): string {
  return `${ID_PREFIXES[type]}-${randomBytes(4).toString("hex")}`;
}

function sessionPath(id: string, env: EnvLike): string {
  return path.join(sessionsDir(env), `${id}.json`);
}

function sessionPathForRead(id: string, env: EnvLike): string {
  const primary = sessionPath(id, env);
  const candidates = [
    primary,
    ...legacySessionsDirs(env).map((dir) => path.join(dir, `${id}.json`)),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? primary;
}

/** Directory for logs, leases, permits, and runtime data beside a session record. */
export function sessionDataDir(
  id: string,
  env: EnvLike = process.env,
): string {
  return path.join(path.dirname(sessionPathForRead(id, env)), id);
}

function serialize(record: SessionRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export async function createSession(
  input: CreateSessionInput,
  env: EnvLike = process.env,
): Promise<SessionRecord> {
  await ensureDir(sessionsDir(env));
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const record: SessionRecord = {
      id: newSessionId(input.type),
      type: input.type,
      createdAt: new Date().toISOString(),
      status: input.status ?? "starting",
      projectDir: input.projectDir,
    };
    if (input.desktop !== undefined) record.desktop = input.desktop;
    if (input.android !== undefined) record.android = input.android;
    if (input.browser !== undefined) record.browser = input.browser;
    if (input.meta !== undefined) record.meta = input.meta;
    try {
      await fs.promises.writeFile(sessionPath(record.id, env), serialize(record), {
        encoding: "utf8",
        flag: "wx",
      });
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error(
    `Failed to allocate a unique session id after ${MAX_ID_ATTEMPTS} attempts`,
  );
}

export async function getSession(
  id: string,
  env: EnvLike = process.env,
): Promise<SessionRecord | undefined> {
  if (!isValidSessionId(id)) {
    return undefined;
  }
  const filePath = sessionPathForRead(id, env);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as SessionRecord;
  } catch (error) {
    throw new Error(
      `Invalid session record at ${filePath}: ${(error as Error).message}`,
    );
  }
}

export async function listSessions(
  env: EnvLike = process.env,
): Promise<SessionRecord[]> {
  const primaryEntries = await listDirSafe(sessionsDir(env));
  const legacyEntries = await Promise.all(
    legacySessionsDirs(env).map((dir) => listDirSafe(dir)),
  );
  const entries = [...new Set([...primaryEntries, ...legacyEntries.flat()])];

  const records: SessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
    let record: SessionRecord | undefined;
    try {
      record = await getSession(entry.slice(0, -".json".length), env);
    } catch {
      continue;
    }
    if (record !== undefined) records.push(record);
  }
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return records;
}
export function isDisplaySocketAlive(display: string): boolean {
  const match = /^:(\d+)$/.exec(display);
  if (match === null) return false;
  return fs.existsSync(`/tmp/.X11-unix/X${match[1]}`);
}


// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export function isSessionProcessAlive(record: SessionRecord): boolean {
  if (record.type === "desktop") {
    const desktop = record.desktop;
    if (desktop?.xvfbPid === undefined) return false;
    return desktop.xvfbStartTimeTicks === undefined
      ? isPidAlive(desktop.xvfbPid)
      : processIdentityMatches({
          pid: desktop.xvfbPid,
          startTicks: desktop.xvfbStartTimeTicks,
        });
  }
  if (record.type === "android") {
    return (
      record.android?.emulatorPid !== undefined &&
      isPidAlive(record.android.emulatorPid)
    );
  }
  if (record.type === "browser") {
    const browser = record.browser;
    const desktop = record.desktop;
    if (
      browser?.browserPid === undefined ||
      desktop?.xvfbPid === undefined ||
      desktop.xvfbStartTimeTicks === undefined
    ) {
      return false;
    }
    return (
      processIdentityMatches({
        pid: desktop.xvfbPid,
        startTicks: desktop.xvfbStartTimeTicks,
      }) &&
      isDisplaySocketAlive(desktop.display) &&
      processIdentityMatches({
        pid: browser.browserPid,
        startTicks: browser.browserStartTimeTicks,
      })
    );
  }


  const desktop = record.desktop;
  const desktopAlive =
    desktop?.xvfbPid === undefined
      ? false
      : desktop.xvfbStartTimeTicks === undefined
        ? isPidAlive(desktop.xvfbPid)
        : processIdentityMatches({
            pid: desktop.xvfbPid,
            startTicks: desktop.xvfbStartTimeTicks,
          });
  const alive = [
    desktopAlive,
    record.android?.emulatorPid === undefined
      ? false
      : isPidAlive(record.android.emulatorPid),
  ];
  return alive.some(Boolean);
}

export const REAPER_CLEANUP_PENDING_META_KEY = "reaperCleanupPending";

export async function updateSession(
  id: string,
  patch: Partial<Omit<SessionRecord, "id" | "type" | "createdAt">>,
  env: EnvLike = process.env,
): Promise<SessionRecord> {
  if (!isValidSessionId(id)) {
    throw invalidSessionIdError(id);
  }
  const existing = await getSession(id, env);
  if (existing === undefined) {
    throw new Error(`Session not found: ${id}`);
  }
  const updated: SessionRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    type: existing.type,
    createdAt: existing.createdAt,
  };
  await writeFileAtomic(sessionPathForRead(id, env), serialize(updated));
  return updated;
}

export async function destroySessionRecord(
  id: string,
  env: EnvLike = process.env,
  evidenceStatus: "completed" | "failed" = "completed",
): Promise<void> {
  if (!isValidSessionId(id)) {
    throw invalidSessionIdError(id);
  }
  const record = await getSession(id, env);
  if (record !== undefined) {
    const finalized = await finalizeActiveEvidenceRunHandle(
      record.projectDir,
      record.id,
      evidenceStatus,
      env,
    ).catch(() => undefined);
    if (finalized !== undefined) {
      await writeEvidenceReport(finalized).catch(() => {});
    }
  }
  // Remove BOTH the new-home and legacy copies unconditionally. This also
  // cleans up duplicate records left by older releases that wrote updates to
  // the new home after reading a session from a legacy home.
  const legacyPaths = legacySessionsDirs(env).map((dir) =>
    path.join(dir, `${id}.json`),
  );
  await fs.promises.rm(sessionPath(id, env), { force: true });
  for (const legacyPath of legacyPaths) {
    await fs.promises.rm(legacyPath, { force: true });
  }
}
