import fs from "node:fs";
import path from "node:path";
import { picklabHome, runsDir, type EnvLike } from "./paths.js";
import { resolveRunStorage } from "./storage.js";
import type { RunManifest } from "./run.js";

const SAFE_ENTRY_PATTERN = /^[A-Za-z0-9._-]+$/;
const MANIFEST_FILE = "manifest.json";

/**
 * One trusted run-storage root. Roots are read in array order; the first valid
 * occurrence of a run id wins. `expectedRealDir` lets the resolver authorize a
 * canonical location without making the catalog trust symlinked ancestors.
 */
export interface RunCatalogRoot {
  dir: string;
  expectedRealDir: string;
}

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

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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

async function verifiedRoot(
  root: RunCatalogRoot,
): Promise<{ stat: fs.Stats; realDir: string } | undefined> {
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
  return { stat, realDir };
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

// eslint-disable-next-line max-lines-per-function, complexity -- Legacy gate debt: pickforge/pickforge#60
async function readVerifiedRootFile(
  root: RunCatalogRoot,
  dirName: string,
  fileName: string,
  readContents: boolean,
  expectedIdentity?: CatalogIdentity,
): Promise<{ value: Buffer | true; identity: CatalogIdentity }> {
  if (!isSafeEntryName(dirName) || !isSafeEntryName(fileName)) {
    throw new RunCatalogAccessError("Unsafe run catalog entry");
  }

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

  const runDir = path.join(root.dir, dirName);
  const filePath = path.join(runDir, fileName);
  let runBefore: fs.Stats | undefined;
  let fileBefore: fs.Stats;
  try {
    runBefore = await fs.promises.lstat(runDir);
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
      path.join(rootBefore.realDir, dirName)
    ) {
      throw new RunCatalogAccessError("Unsafe run catalog directory");
    }
    fileBefore = await fs.promises.lstat(filePath);
    if (fileBefore.isSymbolicLink() || !fileBefore.isFile()) {
      throw new RunCatalogAccessError("Unsafe run catalog file");
    }
    if (
      (await fs.promises.realpath(filePath)) !==
      path.join(rootBefore.realDir, dirName, fileName)
    ) {
      throw new RunCatalogAccessError("Unsafe run catalog file");
    }
  } catch (error) {
    if (error instanceof RunCatalogAccessError) throw error;
    if (isMissing(error)) {
      const unchanged =
        runBefore !== undefined &&
        (await rootAndRunStillMatch(
          root,
          dirName,
          rootBefore.stat,
          runBefore,
        ));
      throw new RunCatalogAccessError(
        unchanged
          ? "Run catalog file not found"
          : "Run catalog directory changed",
        unchanged,
      );
    }
    throw new RunCatalogAccessError("Could not verify run catalog file");
  }

  if (runBefore === undefined) {
    throw new RunCatalogAccessError("Run catalog directory not found");
  }

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    const missing = isMissing(error);
    const unchanged =
      missing &&
      (await rootAndRunStillMatch(
        root,
        dirName,
        rootBefore.stat,
        runBefore,
      ));
    throw new RunCatalogAccessError(
      missing && unchanged
        ? "Run catalog file not found"
        : "Could not open run catalog file",
      missing && unchanged,
    );
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(opened, fileBefore)) {
      throw new RunCatalogAccessError("Run catalog file changed during read");
    }
    const value = readContents ? await handle.readFile() : true;

    const rootAfter = await verifiedRoot(root);
    if (
      rootAfter === undefined ||
      !sameIdentity(rootBefore.stat, rootAfter.stat)
    ) {
      throw new RunCatalogAccessError("Run catalog root changed during read");
    }
    const runAfter = await fs.promises.lstat(runDir);
    const fileAfter = await fs.promises.lstat(filePath);
    if (
      runAfter.isSymbolicLink() ||
      !runAfter.isDirectory() ||
      !sameIdentity(runBefore, runAfter) ||
      fileAfter.isSymbolicLink() ||
      !fileAfter.isFile() ||
      !sameIdentity(opened, fileAfter)
    ) {
      throw new RunCatalogAccessError("Run catalog entry changed during read");
    }
    if (
      (await fs.promises.realpath(runDir)) !==
        path.join(rootAfter.realDir, dirName) ||
      (await fs.promises.realpath(filePath)) !==
        path.join(rootAfter.realDir, dirName, fileName)
    ) {
      throw new RunCatalogAccessError("Run catalog entry escaped during read");
    }
    return {
      value,
      identity: { root: rootBefore.stat, run: runBefore },
    };
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
  } else if (resolved.mode === "home") {
    const homeReal = await realpathIfExists(picklabHome(env));
    if (homeReal !== undefined && resolved.projectId !== undefined) {
      roots.push({
        dir: resolved.runsDir,
        expectedRealDir: path.join(
          homeReal,
          "projects",
          resolved.projectId,
          "runs",
        ),
      });
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
