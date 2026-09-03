import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPickforgeEnv, type EnvLike } from "./env-compat.js";

export type { EnvLike } from "./env-compat.js";

/**
 * The PickLab home root, shared by every product under the Pickforge company
 * root (`~/.pickforge/<product-slug>/`). `PICKFORGE_HOME` remains the override
 * for automation/tests/custom installs.
 */
export function picklabHome(env: EnvLike = process.env): string {
  const fromEnv = readPickforgeEnv(env, "HOME");
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return path.join(os.homedir(), ".pickforge", "picklab");
}

/**
 * The pre-#34 PickLab home (`~/.picklab`). Only meaningful when the caller is
 * on the default root (no explicit `PICKFORGE_HOME`): once a user sets
 * `PICKFORGE_HOME` themselves they have taken explicit control and no legacy
 * fallback applies. Existing global config, agent state, and sessions under
 * this path are never migrated or deleted — callers that read single files or
 * list directories fall back to this path only when the new default has
 * nothing yet, so nothing already there is silently orphaned.
 */
export function legacyPickforgeHome(env: EnvLike = process.env): string | undefined {
  const fromEnv = readPickforgeEnv(env, "HOME");
  if (fromEnv !== undefined && fromEnv !== "") {
    return undefined;
  }
  return path.join(os.homedir(), ".picklab");
}

export function sessionsDir(env: EnvLike = process.env): string {
  return path.join(picklabHome(env), "sessions");
}

export function legacySessionsDir(env: EnvLike = process.env): string | undefined {
  const legacyHome = legacyPickforgeHome(env);
  return legacyHome === undefined ? undefined : path.join(legacyHome, "sessions");
}

export function agentsDir(env: EnvLike = process.env): string {
  return path.join(picklabHome(env), "agents");
}

export function legacyAgentsDir(env: EnvLike = process.env): string | undefined {
  const legacyHome = legacyPickforgeHome(env);
  return legacyHome === undefined ? undefined : path.join(legacyHome, "agents");
}

export function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, ".picklab", "config.json");
}

export function globalConfigPath(env: EnvLike = process.env): string {
  return path.join(picklabHome(env), "config.json");
}

export function legacyGlobalConfigPath(env: EnvLike = process.env): string | undefined {
  const legacyHome = legacyPickforgeHome(env);
  return legacyHome === undefined ? undefined : path.join(legacyHome, "config.json");
}

/** The project-local runs layout (`<project>/.picklab/runs`), used by the
 * `project-local` storage mode and kept, unwritten, as a non-destructive
 * legacy read fallback for every other mode. */
export function runsDir(projectDir: string): string {
  return path.join(projectDir, ".picklab", "runs");
}

export async function ensureDir(dir: string): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Resolve which of a primary path and an optional legacy path to read: the
 * primary wins whenever it exists; otherwise the legacy path is used verbatim
 * so an existing single-file read (global config, agent state) keeps working
 * across the `~/.picklab` → `~/.pickforge/picklab` default-root change without
 * a migration step. Writes always target the primary path (callers never pass
 * this through a writer), so nothing legacy is ever mutated.
 */
export async function resolveReadablePath(
  primaryPath: string,
  legacyPath: string | undefined,
): Promise<string> {
  if (legacyPath === undefined) return primaryPath;
  try {
    await fs.promises.access(primaryPath, fs.constants.F_OK);
    return primaryPath;
  } catch {
    try {
      await fs.promises.access(legacyPath, fs.constants.F_OK);
      return legacyPath;
    } catch {
      return primaryPath;
    }
  }
}

/** Directory listing that returns `[]` instead of throwing when missing. */
export async function listDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

let atomicTmpCounter = 0;

/**
 * Write a file atomically: write to a sibling temp file, preserve the target's
 * existing permission mode (if any), then rename over the destination. The
 * rename is atomic on the same filesystem, so a reader never observes a
 * partially written file. On any failure the temp file is removed rather than
 * left behind.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  atomicTmpCounter += 1;
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${atomicTmpCounter}`,
  );
  let mode: number | undefined;
  try {
    mode = (await fs.promises.stat(filePath)).mode & 0o777;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw error;
    }
  }
  try {
    await fs.promises.writeFile(tmp, content, { encoding: "utf8", mode });
    if (mode !== undefined) {
      await fs.promises.chmod(tmp, mode);
    }
    await fs.promises.rename(tmp, filePath);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Confinement guard for an ephemeral browser profile. In addition to lexical
 * containment, every existing path from the sessions directory through the
 * profile is lstat'd and realpath-checked so a planted symlink can never turn
 * cleanup into an out-of-tree removal. Missing paths are safe: force-removal is
 * already a no-op once the first missing ancestor is reached.
 */
export async function isProfileConfined(
  sessionDir: string,
  profileDir: string,
): Promise<boolean> {
  const base = path.resolve(sessionDir);
  const target = path.resolve(profileDir);
  if (
    target !== path.join(base, "profile") &&
    !target.startsWith(base + path.sep)
  ) {
    return false;
  }

  const root = path.dirname(base);
  const relative = path.relative(root, target);
  const components = relative.split(path.sep);
  try {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const rootReal = await fs.promises.realpath(root);

    let current = root;
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]!);
      try {
        stat = await fs.promises.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        return false;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const currentReal = await fs.promises.realpath(current);
      const expectedReal = path.join(
        rootReal,
        ...components.slice(0, index + 1),
      );
      if (currentReal !== expectedReal) return false;
    }
    return true;
  } catch {
    return false;
  }
}
