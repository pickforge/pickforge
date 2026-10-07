// Vitest global setup that fails the run when the real Pickforge Lab sessions
// directory changes during the tests. Tests must use a temporary
// PICKFORGE_HOME. A test that falls back to the default home writes session
// and permit entries into the user's real state. See #264.
//
// The guard compares the entry names at setup and teardown. It only
// observes. It never creates, repairs, or deletes anything.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPickforgeEnv } from "../packages/core/src/env-compat.js";

export type GuardTeardown = () => void;

/** Entry names in the directory, or undefined when it does not exist. */
export type DirSnapshot = string[] | undefined;

export interface DirChange {
  added: string[];
  removed: string[];
}

/** The default sessions directory and the one the parent env selects. */
export function guardedSessionDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const dirs = [path.join(home, ".pickforge", "lab", "sessions")];
  const override = readPickforgeEnv(env, "HOME");
  if (override !== undefined && override !== "") dirs.push(path.join(override, "sessions"));
  return [...new Set(dirs.map((dir) => path.resolve(dir)))];
}

export function readDirSnapshot(dir: string): DirSnapshot {
  try {
    return fs.readdirSync(dir).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Describes how the entries changed, or returns undefined when they did not. */
export function describeDirChange(before: DirSnapshot, after: DirSnapshot): DirChange | undefined {
  const old = new Set(before ?? []);
  const now = new Set(after ?? []);
  const added = [...now].filter((name) => !old.has(name));
  const removed = [...old].filter((name) => !now.has(name));
  if (added.length === 0 && removed.length === 0 && (before === undefined) === (after === undefined)) {
    return undefined;
  }
  return { added, removed };
}

function listNames(names: string[]): string {
  const shown = names.slice(0, 10).join(", ");
  return names.length > 10 ? `${shown}, and ${names.length - 10} more` : shown;
}

export function dirChangeError(dir: string, change: DirChange): Error {
  const parts: string[] = [];
  if (change.added.length > 0) parts.push(`added ${listNames(change.added)}`);
  if (change.removed.length > 0) parts.push(`removed ${listNames(change.removed)}`);
  if (parts.length === 0) parts.push("created or removed the directory");
  return new Error(
    `The real Pickforge sessions directory ${dir} changed during the test run ` +
      `(${parts.join("; ")}). A test probably ran without a temporary PICKFORGE_HOME. ` +
      `Pickforge use on this host during the run can also cause this. The guard ` +
      `does not remove these entries. See pickforge/pickforge#264.`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Starts guarding the directories and returns the teardown check. */
export function startGuard(dirs: string[]): GuardTeardown | undefined {
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
    const errors: Error[] = [];
    for (const { dir, before } of watched) {
      try {
        const change = describeDirChange(before, readDirSnapshot(dir));
        if (change !== undefined) errors.push(dirChangeError(dir, change));
      } catch (error) {
        errors.push(new Error(
          `The home sessions guard could not read ${dir} at teardown: ` +
            `${errorMessage(error)}. See pickforge/pickforge#264.`,
        ));
      }
    }
    if (errors.length === 0) return;
    // Vitest only logs teardown errors, so set the exit code as well.
    process.exitCode = 1;
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, errors.map((e) => e.message).join("\n"));
  };
}

export default function setup(): GuardTeardown | undefined {
  return startGuard(guardedSessionDirs());
}
