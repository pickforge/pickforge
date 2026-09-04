import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPickforgeEnv, type EnvLike } from "./env-compat.js";

export type { EnvLike } from "./env-compat.js";

/**
 * The Pickforge Lab state root. `PICKFORGE_HOME` remains the override for
 * automation, tests, and custom installs.
 */
export function pickforgeHome(env: EnvLike = process.env): string {
  const fromEnv = readPickforgeEnv(env, "HOME");
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return path.join(os.homedir(), ".pickforge", "lab");
}

/**
 * Earlier default state roots, in read precedence order. They apply only when
 * no home override is set. Callers never migrate, rewrite, or remove them as
 * part of fallback discovery.
 */
export function legacyPickforgeHomes(
  env: EnvLike = process.env,
): string[] {
  const fromEnv = readPickforgeEnv(env, "HOME");
  if (fromEnv !== undefined && fromEnv !== "") {
    return [];
  }
  return [
    path.join(os.homedir(), ".pickforge", "picklab"),
    path.join(os.homedir(), ".picklab"),
  ];
}

export function sessionsDir(env: EnvLike = process.env): string {
  return path.join(pickforgeHome(env), "sessions");
}

export function legacySessionsDirs(env: EnvLike = process.env): string[] {
  return legacyPickforgeHomes(env).map((home) => path.join(home, "sessions"));
}

export function agentsDir(env: EnvLike = process.env): string {
  return path.join(pickforgeHome(env), "agents");
}

export function legacyAgentsDirs(env: EnvLike = process.env): string[] {
  return legacyPickforgeHomes(env).map((home) => path.join(home, "agents"));
}

export function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, ".picklab", "config.json");
}

export function globalConfigPath(env: EnvLike = process.env): string {
  return path.join(pickforgeHome(env), "config.json");
}

export function legacyGlobalConfigPaths(env: EnvLike = process.env): string[] {
  return legacyPickforgeHomes(env).map((home) => path.join(home, "config.json"));
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

/** Resolve the first existing path without moving or changing any candidate. */
export async function resolveReadablePath(
  primaryPath: string,
  legacyPaths: string | readonly string[] | undefined,
): Promise<string> {
  const fallbacks =
    legacyPaths === undefined
      ? []
      : typeof legacyPaths === "string"
        ? [legacyPaths]
        : legacyPaths;
  for (const candidate of [primaryPath, ...fallbacks]) {
    try {
      await fs.promises.access(candidate, fs.constants.F_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return primaryPath;
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
