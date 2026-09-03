import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  loadConfigLayers,
  resolvedDefaults,
  type StorageConfig,
  type StorageMode,
} from "./config.js";
import { readPickforgeEnv, type EnvLike } from "./env-compat.js";
import { picklabHome, runsDir } from "./paths.js";

export type { StorageConfig, StorageMode } from "./config.js";

const PROJECT_ID_HASH_LENGTH = 16;

function sanitizeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug === "" ? "project" : slug).slice(0, 40);
}

/**
 * Canonical form of a project path used for stable project-id derivation.
 * Resolves symlinks (so a project reached through different paths still gets
 * one id); falls back to the lexically resolved path when the directory does
 * not exist yet (e.g. a not-yet-created target), so id derivation never
 * throws and stays stable once the directory does appear.
 */
export async function canonicalProjectPath(projectDir: string): Promise<string> {
  const resolved = path.resolve(projectDir);
  try {
    return await fs.promises.realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Stable per-project id derived from a canonical project path: a sha256
 * digest (load-bearing for uniqueness) prefixed with a human-readable slug of
 * the directory's basename purely for debuggability (`ls
 * ~/.pickforge/picklab/projects` stays legible). The same canonical path
 * always yields the same id; different paths practically never collide.
 */
export function deriveProjectId(canonicalPath: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(canonicalPath)
    .digest("hex")
    .slice(0, PROJECT_ID_HASH_LENGTH);
  return `${sanitizeSlug(path.basename(canonicalPath))}-${hash}`;
}

export async function projectId(projectDir: string): Promise<string> {
  return deriveProjectId(await canonicalProjectPath(projectDir));
}

export class StorageConfigError extends Error {}

export interface ResolvedRunStorage {
  mode: StorageMode;
  /** Where new runs are written, e.g. `.../runs/<runId>/`. */
  runsDir: string;
  /** Present only for `mode: "home"`. */
  projectId?: string;
  /**
   * Present when the project-committed `.picklab/config.json` requested
   * `storage.mode: "custom"` and it was rejected: a repo-committed config
   * travels with `git clone` and screenshots may carry secrets, so only the
   * user-owned global config or an env override may select `custom` (and
   * supply its path). The resolver falls back to the next layer (global
   * config, then `home`) rather than erroring, so a cloned repo with a
   * hostile or misconfigured project config never bricks `pickforge-lab`; `pickforge-lab
   * doctor` surfaces this field as a warning.
   */
  rejectedProjectCustom?: { requestedPath?: string };
}

function envStorageMode(env: EnvLike): StorageMode | undefined {
  const value = readPickforgeEnv(env, "STORAGE_MODE");
  if (value === "home" || value === "project-local" || value === "custom") {
    return value;
  }
  return undefined;
}

function validateCustomPath(customPath: string | undefined): string {
  if (customPath === undefined || customPath === "") {
    throw new StorageConfigError(
      'storage mode "custom" requires a storage path ' +
        "(storage.path in config, or PICKFORGE_STORAGE_PATH)",
    );
  }
  if (!path.isAbsolute(customPath)) {
    throw new StorageConfigError(
      `storage path must be an absolute path, got "${customPath}"`,
    );
  }
  return path.resolve(customPath);
}

/** Whether `descendant` is `ancestor` itself or strictly nested under it. */
function isSameOrDescendant(ancestor: string, descendant: string): boolean {
  const relative = path.relative(ancestor, descendant);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve where new run artifacts should be written for a project.
 *
 * Reads `storage` from two config layers plus an environment override, in
 * increasing precedence: global config (`<PICKFORGE_HOME>/config.json`),
 * project config (`.picklab/config.json`), then `PICKFORGE_STORAGE_MODE` /
 * `PICKFORGE_STORAGE_PATH` for automation and tests. **`custom` mode is an
 * exception to that precedence**: only the global-config layer or the env
 * override may select it (and supply its path) — project config is
 * repo-committed and travels with `git clone`, so honoring a `custom`
 * selection from it would let a cloned repository silently redirect
 * artifact writes (screenshots, which may carry secrets) to any absolute
 * path with no prompt. A project config requesting `custom` is treated as
 * absent and the resolver falls through to global config, then `home`; see
 * `rejectedProjectCustom` on the result. Project config may still select
 * `project-local` (blast radius already scoped to the project itself) or
 * `home`.
 *
 * - `home` (default): `<picklabHome>/projects/<projectId>/runs`, isolated per
 *   project and outside every target repository.
 * - `project-local`: the pre-#34 `<project>/.picklab/runs` layout.
 * - `custom`: `<storage.path>/runs` under an explicit absolute path outside
 *   the project directory (rejected if it equals or is nested inside it —
 *   that would just reintroduce project pollution, un-namespaced).
 *
 * This is the single resolver every run-creation and artifact-lookup path
 * (core, CLI, MCP) goes through, so they always agree on where runs live.
 */
// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export async function resolveRunStorage(
  projectDir: string,
  env: EnvLike = process.env,
): Promise<ResolvedRunStorage> {
  const { global, project } = await loadConfigLayers(projectDir, env);
  const globalStorage: StorageConfig = global.storage ?? {};
  const projectStorage: StorageConfig = project.storage ?? {};

  const envMode = envStorageMode(env);
  let mode: StorageMode;
  let customPath: string | undefined;
  let rejectedProjectCustom: { requestedPath?: string } | undefined;

  if (envMode !== undefined) {
    // The environment is always user/automation-controlled, never
    // repo-committed: it may select any mode, including custom. Its custom
    // path may come from the env itself or from global config, but never
    // from project config — project config never supplies a custom path,
    // regardless of which layer selected the mode.
    mode = envMode;
    customPath = readPickforgeEnv(env, "STORAGE_PATH") ?? globalStorage.path;
  } else if (projectStorage.mode === "custom") {
    rejectedProjectCustom = { requestedPath: projectStorage.path };
    mode = globalStorage.mode ?? resolvedDefaults.storage.mode;
    customPath = globalStorage.path;
  } else if (projectStorage.mode !== undefined) {
    // Guaranteed not "custom" (handled above), so no path is needed.
    mode = projectStorage.mode;
    customPath = undefined;
  } else {
    mode = globalStorage.mode ?? resolvedDefaults.storage.mode;
    customPath = globalStorage.path;
  }

  if (mode === "project-local") {
    const resolved: ResolvedRunStorage = { mode, runsDir: runsDir(projectDir) };
    if (rejectedProjectCustom !== undefined) {
      resolved.rejectedProjectCustom = rejectedProjectCustom;
    }
    return resolved;
  }

  if (mode === "custom") {
    const resolvedCustomRoot = validateCustomPath(customPath);
    const resolvedProjectDir = path.resolve(projectDir);
    if (isSameOrDescendant(resolvedProjectDir, resolvedCustomRoot)) {
      throw new StorageConfigError(
        `storage path must be outside the project directory, got "${customPath}" ` +
          `under "${resolvedProjectDir}"`,
      );
    }
    const resolved: ResolvedRunStorage = {
      mode,
      runsDir: path.join(resolvedCustomRoot, "runs"),
    };
    if (rejectedProjectCustom !== undefined) {
      resolved.rejectedProjectCustom = rejectedProjectCustom;
    }
    return resolved;
  }

  const id = await projectId(projectDir);
  const resolved: ResolvedRunStorage = {
    mode: "home",
    runsDir: path.join(picklabHome(env), "projects", id, "runs"),
    projectId: id,
  };
  if (rejectedProjectCustom !== undefined) {
    resolved.rejectedProjectCustom = rejectedProjectCustom;
  }
  return resolved;
}
