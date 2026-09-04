import fs from "node:fs";
import path from "node:path";
import { pickforgeHome, type EnvLike } from "./paths.js";
import { resolveRunStorage, type ResolvedRunStorage } from "./storage.js";

/**
 * One trusted run-storage root. `expectedRealDir` is derived from the trusted
 * ancestor's real path (the project directory, the Pickforge home, or the
 * custom base), so a symlinked `.picklab`, `runs`, or project-id component can
 * never pass verification even when it currently points somewhere harmless.
 */
export interface RunStorageRoot {
  dir: string;
  expectedRealDir: string;
}

/** A root that passed verification, bound to the directory identity seen. */
export interface VerifiedRunRoot {
  dir: string;
  realDir: string;
  stat: fs.Stats;
}

/** A run directory bound to the verified root and identity it was created in. */
export interface RunDirIdentity {
  root: VerifiedRunRoot;
  dirName: string;
  stat: fs.Stats;
}

/**
 * Raised when a run-storage write would go through a symlink, a non-directory,
 * or a directory that no longer resolves where the trusted ancestor says it
 * should. Nothing is moved, rewritten, or removed when this is thrown: the
 * offending entry is the user's (or the repository's) to fix.
 */
export class RunStorageAccessError extends Error {}

export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Read-side root verification: the root must exist as a real (non-symlink)
 * directory whose real path is exactly the one derived from the trusted
 * ancestor. Missing or unsafe roots are reported as `undefined` so readers
 * skip them; other I/O errors propagate.
 */
export async function verifyExistingRoot(
  root: RunStorageRoot,
): Promise<VerifiedRunRoot | undefined> {
  let stat: fs.Stats;
  let realDir: string;
  try {
    stat = await fs.promises.lstat(root.dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
    realDir = await fs.promises.realpath(root.dir);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (realDir !== root.expectedRealDir) return undefined;
  return { dir: root.dir, realDir, stat };
}

/**
 * Write-side check for one directory: it must be a real (non-symlink)
 * directory resolving exactly to `expectedRealDir`. Unlike the read side this
 * fails loudly, because a write that silently lands elsewhere is the bug #54
 * exists to prevent.
 */
export async function verifyWritableDir(
  dir: string,
  expectedRealDir: string,
): Promise<fs.Stats> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(dir);
  } catch (error) {
    if (isMissing(error)) {
      throw new RunStorageAccessError(
        `Run storage path disappeared while being verified: ${dir}`,
      );
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new RunStorageAccessError(
      `Refusing to write run artifacts through a symlink at ${dir}; ` +
        "replace it with a real directory (nothing was written, moved, or removed)",
    );
  }
  if (!stat.isDirectory()) {
    throw new RunStorageAccessError(
      `Refusing to write run artifacts: ${dir} exists but is not a directory`,
    );
  }
  const realDir = await fs.promises.realpath(dir);
  if (realDir !== expectedRealDir) {
    throw new RunStorageAccessError(
      `Refusing to write run artifacts: ${dir} resolves to ${realDir}, ` +
        `expected ${expectedRealDir}`,
    );
  }
  return stat;
}

interface RunWriteSpec {
  /** The ancestor whose real path anchors verification. */
  trustedDir: string;
  /** Whether the ancestor may be created (user-owned roots) or must already exist. */
  createTrusted: boolean;
  /** Components below the ancestor that must be real, unlinked directories. */
  components: string[];
}

function writeSpecFor(
  resolved: ResolvedRunStorage,
  projectDir: string,
  env: EnvLike,
): RunWriteSpec {
  if (resolved.mode === "project-local") {
    // The project directory is the trust boundary, exactly as the catalog's
    // read root: anything committed below it (`.picklab`, `runs`) is untrusted.
    return {
      trustedDir: projectDir,
      createTrusted: false,
      components: [".picklab", "runs"],
    };
  }
  if (resolved.mode === "home" && resolved.projectId !== undefined) {
    return {
      trustedDir: pickforgeHome(env),
      createTrusted: true,
      components: ["projects", resolved.projectId, "runs"],
    };
  }
  return {
    trustedDir: path.dirname(resolved.runsDir),
    createTrusted: true,
    components: ["runs"],
  };
}

async function realTrustedDir(spec: RunWriteSpec): Promise<string> {
  if (spec.createTrusted) {
    await fs.promises.mkdir(spec.trustedDir, { recursive: true });
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(spec.trustedDir);
  } catch (error) {
    if (isMissing(error)) {
      throw new RunStorageAccessError(
        `Run storage root does not exist: ${spec.trustedDir}`,
      );
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new RunStorageAccessError(
      `Run storage root is not a directory: ${spec.trustedDir}`,
    );
  }
  return fs.promises.realpath(spec.trustedDir);
}

/**
 * Create `dir` if missing, then verify it. A plain (non-recursive) `mkdir`
 * never follows a symlink at the final component: a planted link, dangling or
 * not, yields `EEXIST` and is then rejected by the `lstat` check.
 */
async function createVerifiedDir(
  dir: string,
  expectedRealDir: string,
): Promise<fs.Stats> {
  try {
    await fs.promises.mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return verifyWritableDir(dir, expectedRealDir);
}

/**
 * Materialize and verify the runs root for a project, mirroring the trust
 * boundary the run catalog applies when reading. Every component between the
 * trusted ancestor and the runs directory is created one level at a time and
 * checked with `lstat` plus `realpath`, so a symlinked `.picklab` committed in
 * a target repository cannot redirect `project-local` writes. Existing user
 * data is never migrated or deleted: an unsafe entry raises
 * {@link RunStorageAccessError} and leaves the tree untouched.
 */
export async function ensureVerifiedRunsRoot(
  projectDir: string,
  env: EnvLike = process.env,
): Promise<VerifiedRunRoot> {
  const resolved = await resolveRunStorage(projectDir, env);
  const spec = writeSpecFor(resolved, projectDir, env);
  const expectedDir = path.join(spec.trustedDir, ...spec.components);
  if (expectedDir !== resolved.runsDir) {
    throw new RunStorageAccessError(
      `Run storage resolver disagreement: ${resolved.runsDir} vs ${expectedDir}`,
    );
  }
  let dir = spec.trustedDir;
  let realDir = await realTrustedDir(spec);
  let stat: fs.Stats | undefined;
  for (const component of spec.components) {
    dir = path.join(dir, component);
    realDir = path.join(realDir, component);
    stat = await createVerifiedDir(dir, realDir);
  }
  if (stat === undefined) {
    throw new RunStorageAccessError(`Run storage root has no components: ${dir}`);
  }
  return { dir, realDir, stat };
}

/**
 * Bind an existing run directory under a verified root: the root must still be
 * the same directory (identity and real path) and the run directory must be a
 * real directory resolving directly below it.
 */
export async function bindRunDir(
  root: VerifiedRunRoot,
  dirName: string,
): Promise<RunDirIdentity> {
  const rootNow = await verifyWritableDir(root.dir, root.realDir);
  if (!sameIdentity(root.stat, rootNow)) {
    throw new RunStorageAccessError(
      `Run storage root was replaced while in use: ${root.dir}`,
    );
  }
  const stat = await verifyWritableDir(
    path.join(root.dir, dirName),
    path.join(root.realDir, dirName),
  );
  return { root, dirName, stat };
}

/** Re-check a bound run directory before writing into it. */
export async function assertRunDirIntact(
  identity: RunDirIdentity,
): Promise<void> {
  const current = await bindRunDir(identity.root, identity.dirName);
  if (!sameIdentity(identity.stat, current.stat)) {
    throw new RunStorageAccessError(
      `Run directory was replaced while in use: ${path.join(identity.root.dir, identity.dirName)}`,
    );
  }
}
