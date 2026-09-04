import fs from "node:fs";
import path from "node:path";
import {
  DirHandle,
  RunStorageAccessError,
  assertSafeEntryName,
  withDirHandle,
} from "./dir-handle.js";
import { pickforgeHome, type EnvLike } from "./paths.js";
import { resolveRunStorage, type ResolvedRunStorage } from "./storage.js";

export { RunStorageAccessError, withDirHandle } from "./dir-handle.js";
export type { DirHandle } from "./dir-handle.js";

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

/**
 * Everything needed to re-open one run directory *as the identity it was
 * verified at*: the runs root's logical path and verified real path, the run
 * directory's name, and its `fstat` identity. Re-opening through
 * {@link withBoundRunDir} yields a descriptor, and every write goes through
 * that descriptor's capability path — so verification and write share one
 * directory identity and no ancestor swap can separate them.
 */
export interface RunDirBinding {
  rootDir: string;
  realRootDir: string;
  runId: string;
  identity: fs.Stats;
}

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

async function resolveWriteSpec(
  projectDir: string,
  env: EnvLike,
): Promise<RunWriteSpec> {
  const resolved = await resolveRunStorage(projectDir, env);
  const spec = writeSpecFor(resolved, projectDir, env);
  const expectedDir = path.join(spec.trustedDir, ...spec.components);
  if (expectedDir !== resolved.runsDir) {
    throw new RunStorageAccessError(
      `Run storage resolver disagreement: ${resolved.runsDir} vs ${expectedDir}`,
    );
  }
  return spec;
}

/**
 * Open the trusted ancestor. A user may legitimately reach it through a
 * symlink (a linked project directory or Pickforge home), exactly as the
 * catalog's read side allows, so the final component may be followed here —
 * and only here. Its real path, read back from the descriptor, anchors every
 * component below it.
 */
async function openTrustedDir(
  spec: RunWriteSpec,
  create: boolean,
): Promise<DirHandle> {
  if (spec.createTrusted && create) {
    await fs.promises.mkdir(spec.trustedDir, { recursive: true });
  }
  try {
    return await DirHandle.open(spec.trustedDir, { followFinal: true });
  } catch (error) {
    if (
      error instanceof RunStorageAccessError &&
      /disappeared while being verified/.test(error.message)
    ) {
      throw new RunStorageAccessError(
        `Run storage root does not exist: ${spec.trustedDir}`,
      );
    }
    if (
      error instanceof RunStorageAccessError &&
      /is not a directory/.test(error.message)
    ) {
      throw new RunStorageAccessError(
        `Run storage root is not a directory: ${spec.trustedDir}`,
      );
    }
    throw error;
  }
}

/**
 * Walk from the trusted ancestor down to the runs directory one descriptor at
 * a time: each component is created (when it may be) and opened *relative to
 * the descriptor of its parent* with `O_NOFOLLOW`, so a symlinked `.picklab`,
 * `runs`, or project-id component is refused and no lookup ever re-traverses
 * an ancestor that could have been swapped meanwhile.
 */
async function openChain(
  spec: RunWriteSpec,
  create: boolean,
): Promise<DirHandle | undefined> {
  let current = await openTrustedDir(spec, create);
  let logical = spec.trustedDir;
  let handedOver = false;
  try {
    for (const component of spec.components) {
      logical = path.join(logical, component);
      let next: DirHandle;
      try {
        next = create
          ? await current.ensureChildDir(component)
          : await current.openChild(component);
      } catch (error) {
        if (!create && isAbsent(error)) return undefined;
        throw rewriteChildError(error, logical);
      }
      await current.close();
      current = next;
    }
    handedOver = true;
    return current;
  } finally {
    if (!handedOver) await current.close().catch(() => {});
  }
}

/** Whether an error means "this component simply is not there (yet)". */
function isAbsent(error: unknown): boolean {
  if (isMissing(error)) return true;
  return (
    error instanceof RunStorageAccessError &&
    /disappeared while being verified/.test(error.message)
  );
}

/** Re-label an error raised for a capability path with the logical path. */
function rewriteChildError(error: unknown, logical: string): unknown {
  if (!(error instanceof RunStorageAccessError)) return error;
  return new RunStorageAccessError(
    error.message.replace(/\/proc\/self\/fd\/\d+\/[^\s,;]*/g, logical),
  );
}

/**
 * Materialize the runs root for a project and return an open descriptor on it,
 * mirroring the trust boundary the run catalog applies when reading. Existing
 * user data is never migrated or deleted: an unsafe entry raises
 * {@link RunStorageAccessError} and leaves the tree untouched.
 *
 * The caller owns the returned handle and must close it; prefer
 * {@link withRunsRootDir}.
 */
export async function openRunsRootDir(
  projectDir: string,
  env: EnvLike = process.env,
): Promise<DirHandle> {
  const spec = await resolveWriteSpec(projectDir, env);
  const handle = await openChain(spec, true);
  if (handle === undefined) {
    throw new RunStorageAccessError(
      `Run storage root could not be created: ${spec.trustedDir}`,
    );
  }
  return handle;
}

/** Run `fn` with an open, verified runs root, always closing the descriptor. */
export function withRunsRootDir<T>(
  projectDir: string,
  env: EnvLike,
  fn: (root: DirHandle) => Promise<T>,
): Promise<T> {
  return withDirHandle(openRunsRootDir(projectDir, env), fn);
}

/**
 * Like {@link openRunsRootDir}, but never creates anything: a missing root
 * yields `undefined` so read-mostly callers (pointer inspection) can report
 * "absent" without materializing storage. Unsafe entries still raise.
 */
export async function openExistingRunsRootDir(
  projectDir: string,
  env: EnvLike = process.env,
): Promise<DirHandle | undefined> {
  const spec = await resolveWriteSpec(projectDir, env);
  try {
    return await openChain(spec, false);
  } catch (error) {
    if (
      error instanceof RunStorageAccessError &&
      /does not exist|disappeared while being verified/.test(error.message)
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Run `fn` with the existing verified runs root, or with `undefined` when the
 * project has none yet. Always closes the descriptor.
 */
export async function withExistingRunsRootDir<T>(
  projectDir: string,
  env: EnvLike,
  fn: (root: DirHandle | undefined) => Promise<T>,
): Promise<T> {
  const root = await openExistingRunsRootDir(projectDir, env);
  try {
    return await fn(root);
  } finally {
    if (root !== undefined) await root.close().catch(() => {});
  }
}

/**
 * Materialize and verify the runs root for a project. This reports the root's
 * verified location and identity; it holds no descriptor, so it is a *read* of
 * the trust boundary. Writes must go through {@link withRunsRootDir} or a
 * {@link RunDirBinding}, which bind the write to the descriptor they verified.
 */
export async function ensureVerifiedRunsRoot(
  projectDir: string,
  env: EnvLike = process.env,
): Promise<VerifiedRunRoot> {
  return withRunsRootDir(projectDir, env, async (root) => ({
    dir: root.dir,
    realDir: root.realDir,
    stat: root.stat,
  }));
}

/** Describe an open run directory so it can be re-opened at the same identity. */
export function bindingFor(root: DirHandle, runDir: DirHandle): RunDirBinding {
  return {
    rootDir: root.dir,
    realRootDir: root.realDir,
    runId: path.basename(runDir.dir),
    identity: runDir.stat,
  };
}

/**
 * Open a run directory as a child of the verified runs root, refusing a
 * symlink, a non-directory, and any name that is not a single path component.
 */
export async function openRunDirIn(
  root: DirHandle,
  runId: string,
): Promise<DirHandle> {
  assertSafeEntryName(runId, "run id");
  try {
    return await root.openChild(runId);
  } catch (error) {
    throw rewriteChildError(error, path.join(root.dir, runId));
  }
}

/**
 * Re-open a bound run directory and run `fn` against its descriptor. The runs
 * root is re-verified against the real path recorded when the binding was
 * made, the run directory is re-checked against the identity recorded then,
 * and `fn` writes exclusively through the descriptor that passed those checks.
 * A swapped ancestor makes the *open* fail; it can never redirect a write that
 * the open already accepted.
 */
export async function withBoundRunDir<T>(
  binding: RunDirBinding,
  fn: (runDir: DirHandle) => Promise<T>,
): Promise<T> {
  const root = await DirHandle.open(binding.rootDir, {
    expectedRealDir: binding.realRootDir,
  });
  let runDir: DirHandle;
  try {
    runDir = await openRunDirIn(root, binding.runId);
  } finally {
    await root.close().catch(() => {});
  }
  try {
    if (!sameIdentity(binding.identity, runDir.stat)) {
      throw new RunStorageAccessError(
        `Run directory was replaced while in use: ` +
          `${path.join(binding.rootDir, binding.runId)}`,
      );
    }
    return await fn(runDir);
  } finally {
    await runDir.close().catch(() => {});
  }
}
