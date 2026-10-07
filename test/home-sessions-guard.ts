// Vitest global setup that fails the run when a real Pickforge Lab sessions
// directory changes during the tests. Tests must use a temporary
// PICKFORGE_HOME. A test that falls back to the default home writes session
// and permit entries into the user's real state. See #264.
//
// The guard records every entry at any depth at setup and compares the
// entries at teardown. It only observes. It never creates, repairs, or
// deletes anything. Set PICKFORGE_TEST_ALLOW_REAL_HOME_CHANGES=1 on a shared
// host where real sessions run during the tests; the guard then only warns.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPickforgeEnv } from "../packages/core/src/env-compat.js";

export type GuardTeardown = () => void;

/**
 * A signature for each entry, keyed by its path relative to the directory,
 * or undefined when the directory does not exist.
 */
export type DirSnapshot = Map<string, string> | undefined;

export interface DirChange {
  added: string[];
  removed: string[];
  modified: string[];
  directory?: "created" | "removed";
}

export interface GuardOptions {
  /** Warn instead of failing when a directory changes. */
  allowChanges?: boolean;
}

export const ALLOW_CHANGES_ENV = "PICKFORGE_TEST_ALLOW_REAL_HOME_CHANGES";
const SHOWN_PATHS = 10;

export function allowRealHomeChanges(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ALLOW_CHANGES_ENV] === "1";
}

/**
 * The default and legacy sessions directories, as in
 * packages/core/src/paths.ts, and the one the parent env selects.
 */
export function guardedSessionDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const dirs = [
    path.join(home, ".pickforge", "lab", "sessions"),
    path.join(home, ".pickforge", "picklab", "sessions"),
    path.join(home, ".picklab", "sessions"),
  ];
  const override = readPickforgeEnv(env, "HOME");
  if (override !== undefined && override !== "") dirs.push(path.join(override, "sessions"));
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Runs read, or returns undefined when the entry has gone. */
function unlessMissing<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function entrySignature(full: string, stat: fs.Stats): string | undefined {
  // The inode shows a replaced directory. The times show entries that were
  // created and removed inside it, even when the final listing is the same.
  if (stat.isDirectory()) return `dir:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (stat.isSymbolicLink()) {
    const target = unlessMissing(() => fs.readlinkSync(full));
    return target === undefined ? undefined : `link:${target}`;
  }
  const kind = stat.isFile() ? "file" : "other";
  return `${kind}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

function addEntries(root: string, rel: string, out: Map<string, string>): void {
  const names = unlessMissing(() => fs.readdirSync(path.join(root, rel))) ?? [];
  for (const name of names) {
    const relPath = rel === "" ? name : path.join(rel, name);
    const full = path.join(root, relPath);
    const stat = unlessMissing(() => fs.lstatSync(full));
    const signature = stat === undefined ? undefined : entrySignature(full, stat);
    if (stat === undefined || signature === undefined) continue;
    out.set(relPath, signature);
    if (stat.isDirectory()) addEntries(root, relPath, out);
  }
}

export function readDirSnapshot(dir: string): DirSnapshot {
  // Read the root first so a missing root and a root that is not a
  // directory differ from an entry that goes away during the walk.
  if (unlessMissing(() => fs.readdirSync(dir)) === undefined) return undefined;
  const entries = new Map<string, string>();
  addEntries(dir, "", entries);
  return entries;
}

/** Describes how the entries changed, or returns undefined when they did not. */
export function describeDirChange(before: DirSnapshot, after: DirSnapshot): DirChange | undefined {
  const old = before ?? new Map<string, string>();
  const now = after ?? new Map<string, string>();
  const added = [...now.keys()].filter((name) => !old.has(name)).sort();
  const removed = [...old.keys()].filter((name) => !now.has(name)).sort();
  const modified = [...now.keys()]
    .filter((name) => old.has(name) && old.get(name) !== now.get(name))
    .sort();
  const change: DirChange = { added, removed, modified };
  if (before === undefined && after !== undefined) change.directory = "created";
  if (before !== undefined && after === undefined) change.directory = "removed";
  const changed = added.length + removed.length + modified.length > 0;
  return changed || change.directory !== undefined ? change : undefined;
}

function listNames(names: string[]): string {
  const shown = names.slice(0, SHOWN_PATHS).join(", ");
  return names.length > SHOWN_PATHS ? `${shown}, and ${names.length - SHOWN_PATHS} more` : shown;
}

/** Describes the change in one message, with paths relative to dir. */
export function dirChangeMessage(dir: string, change: DirChange): string {
  const parts: string[] = [];
  if (change.directory !== undefined) parts.push(`${change.directory} the directory`);
  if (change.added.length > 0) parts.push(`added ${listNames(change.added)}`);
  if (change.removed.length > 0) parts.push(`removed ${listNames(change.removed)}`);
  if (change.modified.length > 0) parts.push(`modified ${listNames(change.modified)}`);
  return (
    `The real Pickforge sessions directory ${dir} changed during the test run ` +
    `(${parts.join("; ")}). A test probably ran without a temporary PICKFORGE_HOME. ` +
    `Pickforge use on this host during the run can also cause this; set ` +
    `${ALLOW_CHANGES_ENV}=1 to only warn. The guard does not remove these ` +
    `entries. See pickforge/pickforge#264.`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function teardownMessages(watched: { dir: string; before: DirSnapshot }[]): string[] {
  const messages: string[] = [];
  for (const { dir, before } of watched) {
    try {
      const change = describeDirChange(before, readDirSnapshot(dir));
      if (change !== undefined) messages.push(dirChangeMessage(dir, change));
    } catch (error) {
      messages.push(
        `The home sessions guard could not read ${dir} at teardown: ` +
          `${errorMessage(error)}. See pickforge/pickforge#264.`,
      );
    }
  }
  return messages;
}

/** Starts guarding the directories and returns the teardown check. */
export function startGuard(dirs: string[], options: GuardOptions = {}): GuardTeardown | undefined {
  const watched: { dir: string; before: DirSnapshot }[] = [];
  for (const dir of dirs) {
    try {
      watched.push({ dir, before: readDirSnapshot(dir) });
    } catch (error) {
      console.warn(`Home sessions guard skips ${dir}: ${errorMessage(error)}.`);
    }
  }
  if (watched.length === 0) return undefined;
  return () => {
    const messages = teardownMessages(watched);
    if (messages.length === 0) return;
    if (options.allowChanges === true) {
      for (const message of messages) console.warn(`Warning: ${message}`);
      return;
    }
    // Vitest only logs teardown errors, so set the exit code as well.
    process.exitCode = 1;
    const errors = messages.map((message) => new Error(message));
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, messages.join("\n"));
  };
}

export default function setup(): GuardTeardown | undefined {
  return startGuard(guardedSessionDirs(), { allowChanges: allowRealHomeChanges() });
}
