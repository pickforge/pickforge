import fs from "node:fs";
import path from "node:path";
import {
  legacyPickforgeHomes,
  pickforgeHome,
  runsDir,
  type EnvLike,
} from "./paths.js";
import { resolveRunStorage } from "./storage.js";
import {
  isMissing,
  sameIdentity,
  verifyExistingRoot,
  type RunStorageRoot,
} from "./run-root.js";
import { DirHandle, withDirHandle } from "./dir-handle.js";
import type { RunManifest } from "./run.js";

const SAFE_ENTRY_PATTERN = /^[A-Za-z0-9._-]+$/;
const MANIFEST_FILE = "manifest.json";

/**
 * One trusted run-storage root. Roots are read in array order; the first valid
 * occurrence of a run id wins. `expectedRealDir` lets the resolver authorize a
 * canonical location without making the catalog trust symlinked ancestors.
 * The same shape anchors the write path in `run-root.ts`.
 */
export type RunCatalogRoot = RunStorageRoot;

/** A manifest bound to the real directory entry it was read from. */
export interface RunCatalogEntry {
  dirName: string;
  dir: string;
  rootDir: string;
  rootPrecedence: number;
  manifest: RunManifest;
}

interface CatalogIdentity {
  root: fs.Stats;
  run: fs.Stats;
}

const ENTRY_IDENTITY = Symbol("runCatalogIdentity");
type BoundRunCatalogEntry = RunCatalogEntry & {
  [ENTRY_IDENTITY]: CatalogIdentity;
};

class RunCatalogAccessError extends Error {
  readonly missing: boolean;

  constructor(message: string, missing = false) {
    super(message);
    this.missing = missing;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSafeEntryName(name: string): boolean {
  return (
    SAFE_ENTRY_PATTERN.test(name) &&
    name !== "." &&
    name !== ".." &&
    !name.includes("..")
  );
}

function parseManifest(raw: string, dirName: string): RunManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const manifest = parsed as RunManifest;
  if (
    typeof manifest.runId !== "string" ||
    typeof manifest.createdAt !== "string" ||
    !Array.isArray(manifest.artifacts)
  ) {
    return undefined;
  }
  // Identity is fail-closed: a manifest can describe only the directory entry
  // that physically contains it. Mismatches are corrupt catalog entries.
  if (manifest.runId !== dirName) return undefined;
  return manifest;
}

/** The read-side trust boundary, shared with the write path in `run-root.ts`. */
async function verifiedRoot(
  root: RunCatalogRoot,
): Promise<{ stat: fs.Stats; realDir: string } | undefined> {
  return verifyExistingRoot(root);
}

async function rootAndRunStillMatch(
  root: RunCatalogRoot,
  dirName: string,
  rootStat: fs.Stats,
  runStat: fs.Stats,
): Promise<boolean> {
  try {
    const currentRoot = await verifiedRoot(root);
    if (
      currentRoot === undefined ||
      !sameIdentity(rootStat, currentRoot.stat)
    ) {
      return false;
    }
    const runDir = path.join(root.dir, dirName);
    const currentRun = await fs.promises.lstat(runDir);
    return (
      !currentRun.isSymbolicLink() &&
      currentRun.isDirectory() &&
      sameIdentity(runStat, currentRun) &&
      (await fs.promises.realpath(runDir)) ===
        path.join(currentRoot.realDir, dirName)
    );
  } catch {
    return false;
  }
}

function requireSafeCatalogNames(dirName: string, fileName: string): void {
  if (!isSafeEntryName(dirName) || !isSafeEntryName(fileName)) {
    throw new RunCatalogAccessError("Unsafe run catalog entry");
  }
}

async function requireVerifiedCatalogRoot(
  root: RunCatalogRoot,
  expectedIdentity?: CatalogIdentity,
): Promise<{ stat: fs.Stats; realDir: string }> {
  const rootBefore = await verifiedRoot(root);
  if (rootBefore === undefined) {
    throw new RunCatalogAccessError("Unsafe run catalog root");
  }
  if (
    expectedIdentity !== undefined &&
    !sameIdentity(rootBefore.stat, expectedIdentity.root)
  ) {
    throw new RunCatalogAccessError("Run catalog root changed");
  }
  return rootBefore;
}

interface CatalogFileSnapshot {
  root: RunCatalogRoot;
  dirName: string;
  fileName: string;
  rootBefore: { stat: fs.Stats; realDir: string };
  runBefore: fs.Stats;
  fileBefore: fs.Stats;
}

async function lstatVerifiedRunDirectory(
  snapshot: Pick<CatalogFileSnapshot, "root" | "dirName" | "rootBefore">,
  expectedIdentity?: CatalogIdentity,
): Promise<fs.Stats> {
  const runDir = path.join(snapshot.root.dir, snapshot.dirName);
  const runBefore = await fs.promises.lstat(runDir);
  if (runBefore.isSymbolicLink() || !runBefore.isDirectory()) {
    throw new RunCatalogAccessError("Unsafe run catalog directory");
  }
  if (
    expectedIdentity !== undefined &&
    !sameIdentity(runBefore, expectedIdentity.run)
  ) {
    throw new RunCatalogAccessError("Run catalog directory changed");
  }
  if (
    (await fs.promises.realpath(runDir)) !==
    path.join(snapshot.rootBefore.realDir, snapshot.dirName)
  ) {
    throw new RunCatalogAccessError("Unsafe run catalog directory");
  }
  return runBefore;
}

async function lstatVerifiedCatalogFile(
  snapshot: Pick<CatalogFileSnapshot, "root" | "dirName" | "fileName" | "rootBefore">,
): Promise<fs.Stats> {
  const filePath = path.join(snapshot.root.dir, snapshot.dirName, snapshot.fileName);
  const fileBefore = await fs.promises.lstat(filePath);
  if (fileBefore.isSymbolicLink() || !fileBefore.isFile()) {
    throw new RunCatalogAccessError("Unsafe run catalog file");
  }
  if (
    (await fs.promises.realpath(filePath)) !==
    path.join(snapshot.rootBefore.realDir, snapshot.dirName, snapshot.fileName)
  ) {
    throw new RunCatalogAccessError("Unsafe run catalog file");
  }
  return fileBefore;
}

async function snapshotCatalogFile(
  root: RunCatalogRoot,
  dirName: string,
  fileName: string,
  rootBefore: { stat: fs.Stats; realDir: string },
  expectedIdentity?: CatalogIdentity,
): Promise<CatalogFileSnapshot> {
  let runBefore: fs.Stats | undefined;
  const partial = { root, dirName, fileName, rootBefore };
  try {
    runBefore = await lstatVerifiedRunDirectory(partial, expectedIdentity);
    const fileBefore = await lstatVerifiedCatalogFile(partial);
    return { ...partial, runBefore, fileBefore };
  } catch (error) {
    if (error instanceof RunCatalogAccessError) throw error;
    if (isMissing(error)) {
      const unchanged =
        runBefore !== undefined &&
        (await rootAndRunStillMatch(root, dirName, rootBefore.stat, runBefore));
      throw new RunCatalogAccessError(
        unchanged ? "Run catalog file not found" : "Run catalog directory changed",
        unchanged,
      );
    }
    throw new RunCatalogAccessError("Could not verify run catalog file");
  }
}

async function openCatalogFileNoFollow(
  snapshot: CatalogFileSnapshot,
): Promise<fs.promises.FileHandle> {
  const filePath = path.join(
    snapshot.root.dir,
    snapshot.dirName,
    snapshot.fileName,
  );
  try {
    return await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    const missing = isMissing(error);
    const unchanged =
      missing &&
      (await rootAndRunStillMatch(
        snapshot.root,
        snapshot.dirName,
        snapshot.rootBefore.stat,
        snapshot.runBefore,
      ));
    throw new RunCatalogAccessError(
      missing && unchanged
        ? "Run catalog file not found"
        : "Could not open run catalog file",
      missing && unchanged,
    );
  }
}

function catalogRunOrFileChanged(
  snapshot: CatalogFileSnapshot,
  runAfter: fs.Stats,
  opened: fs.Stats,
  fileAfter: fs.Stats,
): boolean {
  if (runAfter.isSymbolicLink() || !runAfter.isDirectory()) return true;
  if (!sameIdentity(snapshot.runBefore, runAfter)) return true;
  if (fileAfter.isSymbolicLink() || !fileAfter.isFile()) return true;
  return !sameIdentity(opened, fileAfter);
}

async function catalogPathsEscaped(
  snapshot: CatalogFileSnapshot,
  realDir: string,
): Promise<boolean> {
  const runDir = path.join(snapshot.root.dir, snapshot.dirName);
  const filePath = path.join(runDir, snapshot.fileName);
  const runReal = await fs.promises.realpath(runDir);
  if (runReal !== path.join(realDir, snapshot.dirName)) return true;
  const fileReal = await fs.promises.realpath(filePath);
  return fileReal !== path.join(realDir, snapshot.dirName, snapshot.fileName);
}

async function readAndRevalidateCatalogFile(
  handle: fs.promises.FileHandle,
  snapshot: CatalogFileSnapshot,
  readContents: boolean,
): Promise<{ value: Buffer | true; identity: CatalogIdentity }> {
  const opened = await handle.stat();
  if (!opened.isFile() || !sameIdentity(opened, snapshot.fileBefore)) {
    throw new RunCatalogAccessError("Run catalog file changed during read");
  }
  const value = readContents ? await handle.readFile() : true;

  const rootAfter = await verifiedRoot(snapshot.root);
  if (
    rootAfter === undefined ||
    !sameIdentity(snapshot.rootBefore.stat, rootAfter.stat)
  ) {
    throw new RunCatalogAccessError("Run catalog root changed during read");
  }
  const runDir = path.join(snapshot.root.dir, snapshot.dirName);
  const filePath = path.join(runDir, snapshot.fileName);
  const runAfter = await fs.promises.lstat(runDir);
  const fileAfter = await fs.promises.lstat(filePath);
  if (catalogRunOrFileChanged(snapshot, runAfter, opened, fileAfter)) {
    throw new RunCatalogAccessError("Run catalog entry changed during read");
  }
  if (await catalogPathsEscaped(snapshot, rootAfter.realDir)) {
    throw new RunCatalogAccessError("Run catalog entry escaped during read");
  }
  return {
    value,
    identity: { root: snapshot.rootBefore.stat, run: snapshot.runBefore },
  };
}

async function readVerifiedRootFile(
  root: RunCatalogRoot,
  dirName: string,
  fileName: string,
  readContents: boolean,
  expectedIdentity?: CatalogIdentity,
): Promise<{ value: Buffer | true; identity: CatalogIdentity }> {
  requireSafeCatalogNames(dirName, fileName);
  const rootBefore = await requireVerifiedCatalogRoot(root, expectedIdentity);
  const snapshot = await snapshotCatalogFile(
    root,
    dirName,
    fileName,
    rootBefore,
    expectedIdentity,
  );
  const handle = await openCatalogFileNoFollow(snapshot);
  try {
    return await readAndRevalidateCatalogFile(handle, snapshot, readContents);
  } catch (error) {
    if (error instanceof RunCatalogAccessError) throw error;
    throw new RunCatalogAccessError("Could not read run catalog file");
  } finally {
    await handle.close();
  }
}

async function readBoundManifest(
  root: RunCatalogRoot,
  dirName: string,
  expectedIdentity?: CatalogIdentity,
): Promise<{ manifest: RunManifest; identity: CatalogIdentity } | undefined> {
  try {
    const result = await readVerifiedRootFile(
      root,
      dirName,
      MANIFEST_FILE,
      true,
      expectedIdentity,
    );
    if (!Buffer.isBuffer(result.value)) return undefined;
    const manifest = parseManifest(result.value.toString("utf8"), dirName);
    return manifest === undefined
      ? undefined
      : { manifest, identity: result.identity };
  } catch {
    return undefined;
  }
}

/**
 * Verified run catalog over an ordered set of storage roots. Corrupt entries,
 * symlinks, directory/manifest identity mismatches, and duplicate ids from
 * lower-precedence roots are omitted. Ordering is newest-first with run-id and
 * root-precedence tie breakers, independent of filesystem enumeration order.
 */
/** Whether the entry still names one safe directory under the root it came from. */
function entryAddressesRoot(entry: RunCatalogEntry, root: RunCatalogRoot): boolean {
  if (!isSafeEntryName(entry.dirName)) return false;
  return entry.rootDir === root.dir && entry.dir === path.join(root.dir, entry.dirName);
}

function identityOf(entry: RunCatalogEntry): CatalogIdentity | undefined {
  return (entry as BoundRunCatalogEntry)[ENTRY_IDENTITY];
}

export class RunCatalog {
  readonly roots: readonly RunCatalogRoot[];

  constructor(roots: readonly RunCatalogRoot[]) {
    this.roots = roots.map((root) => ({
      dir: path.resolve(root.dir),
      expectedRealDir: path.resolve(root.expectedRealDir),
    }));
  }

  async list(): Promise<RunCatalogEntry[]> {
    const entries: BoundRunCatalogEntry[] = [];
    const seenRunIds = new Set<string>();

    for (
      let rootPrecedence = 0;
      rootPrecedence < this.roots.length;
      rootPrecedence += 1
    ) {
      const root = this.roots[rootPrecedence]!;
      if ((await verifiedRoot(root)) === undefined) continue;

      let dirEntries: fs.Dirent[];
      try {
        dirEntries = await fs.promises.readdir(root.dir, {
          withFileTypes: true,
        });
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      dirEntries.sort((left, right) => compareText(left.name, right.name));

      for (const dirEntry of dirEntries) {
        if (
          dirEntry.isSymbolicLink() ||
          !dirEntry.isDirectory() ||
          !isSafeEntryName(dirEntry.name) ||
          seenRunIds.has(dirEntry.name)
        ) {
          continue;
        }
        const bound = await readBoundManifest(root, dirEntry.name);
        if (bound === undefined) continue;
        seenRunIds.add(dirEntry.name);
        entries.push({
          dirName: dirEntry.name,
          dir: path.join(root.dir, dirEntry.name),
          rootDir: root.dir,
          rootPrecedence,
          manifest: bound.manifest,
          [ENTRY_IDENTITY]: bound.identity,
        });
      }
    }

    entries.sort(
      (left, right) =>
        compareText(right.manifest.createdAt, left.manifest.createdAt) ||
        compareText(left.manifest.runId, right.manifest.runId) ||
        left.rootPrecedence - right.rootPrecedence,
    );
    return entries;
  }

  async find(runId?: string): Promise<RunCatalogEntry | undefined> {
    if (runId !== undefined && !isSafeEntryName(runId)) return undefined;
    const entries = await this.list();
    return runId === undefined
      ? entries[0]
      : entries.find((entry) => entry.manifest.runId === runId);
  }

  async refresh(entry: RunCatalogEntry): Promise<RunManifest | undefined> {
    const root = this.roots[entry.rootPrecedence];
    const identity = identityOf(entry);
    if (
      root === undefined ||
      identity === undefined ||
      entry.rootDir !== root.dir ||
      entry.dir !== path.join(root.dir, entry.dirName)
    ) {
      return undefined;
    }
    return (await readBoundManifest(root, entry.dirName, identity))?.manifest;
  }

  /**
   * Open the entry's run directory as a pinned handle and run `fn` with it.
   * Both identities recorded when the entry was listed are checked against the
   * descriptors actually opened, so a root or run directory replaced after
   * `list()` yields `undefined` instead of another directory's contents.
   */
  async withRunDir<T>(
    entry: RunCatalogEntry,
    fn: (dir: DirHandle) => Promise<T>,
  ): Promise<T | undefined> {
    const root = this.roots[entry.rootPrecedence];
    const identity = identityOf(entry);
    if (root === undefined || identity === undefined) return undefined;
    if (!entryAddressesRoot(entry, root)) return undefined;
    const opened = DirHandle.open(root.dir, {
      expectedRealDir: root.expectedRealDir,
      expectedIdentity: identity.root,
    });
    return withDirHandle(opened, (rootDir) =>
      withDirHandle(rootDir.openChild(entry.dirName), async (runDir) =>
        sameIdentity(runDir.stat, identity.run) ? fn(runDir) : undefined,
      ),
    );
  }

  async hasRootFile(entry: RunCatalogEntry, fileName: string): Promise<boolean> {
    const root = this.roots[entry.rootPrecedence];
    const identity = identityOf(entry);
    if (
      root === undefined ||
      identity === undefined ||
      (await this.refresh(entry)) === undefined
    ) {
      return false;
    }
    try {
      await readVerifiedRootFile(
        root,
        entry.dirName,
        fileName,
        false,
        identity,
      );
      return (await this.refresh(entry)) !== undefined;
    } catch {
      return false;
    }
  }

  async readRootFile(entry: RunCatalogEntry, fileName: string): Promise<Buffer> {
    const root = this.roots[entry.rootPrecedence];
    const identity = identityOf(entry);
    if (
      root === undefined ||
      identity === undefined ||
      (await this.refresh(entry)) === undefined
    ) {
      throw new RunCatalogAccessError(`Run not found: ${entry.dirName}`);
    }
    const result = await readVerifiedRootFile(
      root,
      entry.dirName,
      fileName,
      true,
      identity,
    );
    if (
      !Buffer.isBuffer(result.value) ||
      (await this.refresh(entry)) === undefined
    ) {
      throw new RunCatalogAccessError(`Run not found: ${entry.dirName}`);
    }
    return result.value;
  }

  async readRootText(entry: RunCatalogEntry, fileName: string): Promise<string> {
    return (await this.readRootFile(entry, fileName)).toString("utf8");
  }

  async readRootTextIfPresent(
    entry: RunCatalogEntry,
    fileName: string,
  ): Promise<string | undefined> {
    try {
      return await this.readRootText(entry, fileName);
    } catch (error) {
      if (error instanceof RunCatalogAccessError && error.missing) {
        return undefined;
      }
      throw error;
    }
  }
}

async function realpathIfExists(dir: string): Promise<string | undefined> {
  try {
    return await fs.promises.realpath(dir);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** The project-local `.picklab/runs` root, verified against the project
 * directory's own real path. Used as the `project-local` mode's root, and as
 * a non-destructive legacy discovery root for every other mode so runs
 * written before #34 (or by an explicit project-local opt-out) stay
 * discoverable without a migration. */
async function projectLocalRoot(
  projectDir: string,
): Promise<RunCatalogRoot | undefined> {
  const realProject = await realpathIfExists(projectDir);
  if (realProject === undefined) return undefined;
  return {
    dir: runsDir(projectDir),
    expectedRealDir: path.join(realProject, ".picklab", "runs"),
  };
}

async function homeRunRoot(
  home: string,
  projectId: string,
): Promise<RunCatalogRoot | undefined> {
  const homeReal = await realpathIfExists(home);
  if (homeReal === undefined) return undefined;
  return {
    dir: path.join(home, "projects", projectId, "runs"),
    expectedRealDir: path.join(homeReal, "projects", projectId, "runs"),
  };
}

/**
 * Open the run catalog for a project: the resolved storage mode's root as the
 * highest-precedence source, plus (unless that root already is the
 * project-local layout) the legacy project-local root as a read-only
 * fallback. A root whose directory does not exist yet is simply absent from
 * the catalog, not an error — the same behavior `RunCatalog.list()` already
 * has for a missing root.
 */
export async function openRunCatalog(
  projectDir: string,
  env: EnvLike = process.env,
): Promise<RunCatalog> {
  const resolved = await resolveRunStorage(projectDir, env);
  const roots: RunCatalogRoot[] = [];

  if (resolved.mode === "project-local") {
    const root = await projectLocalRoot(projectDir);
    if (root !== undefined) roots.push(root);
  } else if (resolved.mode === "home" && resolved.projectId !== undefined) {
    const homes = [pickforgeHome(env), ...legacyPickforgeHomes(env)];
    for (const home of homes) {
      const root = await homeRunRoot(home, resolved.projectId);
      if (root !== undefined) roots.push(root);
    }
  } else {
    // custom: the configured absolute path is the trusted ancestor to verify
    // the runs dir against (there is no project- or home-rooted ancestor to
    // lean on for a fully user-specified location).
    const customBase = path.dirname(resolved.runsDir);
    const baseReal = await realpathIfExists(customBase);
    if (baseReal !== undefined) {
      roots.push({
        dir: resolved.runsDir,
        expectedRealDir: path.join(baseReal, "runs"),
      });
    }
  }

  if (resolved.mode !== "project-local") {
    const legacyRoot = await projectLocalRoot(projectDir);
    if (legacyRoot !== undefined) roots.push(legacyRoot);
  }

  return new RunCatalog(roots);
}

/** Compatibility projection for callers that only need manifests. */
export async function listRuns(
  projectDir: string,
  env: EnvLike = process.env,
): Promise<RunManifest[]> {
  return (await (await openRunCatalog(projectDir, env)).list()).map(
    (entry) => entry.manifest,
  );
}
