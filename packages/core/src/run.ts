import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type EnvLike } from "./paths.js";
import type { DirHandle } from "./dir-handle.js";
import { RunStorageAccessError } from "./dir-handle.js";
import {
  bindingFor,
  openRunDirIn,
  withBoundRunDir,
  withRunsRootDir,
  type RunDirBinding,
} from "./run-root.js";

export type RunStatus = "running" | "completed" | "failed";
export type ArtifactType = "screenshot" | "log" | "report" | "other";

/**
 * Evidence storage constants. Kept in `run.ts` (not `evidence.ts`) so that
 * `createRun` can stamp the manifest without importing the evidence module,
 * avoiding an import cycle: `evidence.ts` depends on `run.ts`, never the
 * reverse.
 */
export const EVIDENCE_VERSION = 1 as const;
export const EVIDENCE_ACTION_LOG = "actions.jsonl";

export interface RunArtifact {
  type: ArtifactType;
  name: string;
  path: string;
  createdAt: string;
}

export interface RunManifest {
  runId: string;
  slug: string;
  createdAt: string;
  sessionId?: string;
  status: RunStatus;
  artifacts: RunArtifact[];
  meta?: Record<string, unknown>;
  /**
   * Evidence marker. Present (value `1`) only on computer-use runs that carry
   * an append-only action journal. Absent on legacy/plain screenshot runs,
   * which keeps them listing and reading unchanged.
   */
  evidenceVersion?: typeof EVIDENCE_VERSION;
  /** Journal file name relative to the run dir, e.g. `actions.jsonl`. */
  actionLog?: string;
  /**
   * Summary flag copied from the authoritative journal by a finalizer once the
   * evidence cap is hit. The journal (its truncation marker) remains the source
   * of truth; appends never rewrite the manifest to set this.
   */
  evidenceTruncated?: boolean;
}

export interface CreateRunOptions {
  now?: Date;
  sessionId?: string;
  meta?: Record<string, unknown>;
  /**
   * When true, stamp the manifest with evidence fields and create an empty
   * append-only action journal. Plain runs omit this and stay non-evidence.
   */
  evidence?: boolean;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const RUN_SUBDIRS = ["screenshots", "logs"] as const;

function assertValidSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug) || slug.includes("..")) {
    throw new Error(
      `Invalid run slug "${slug}": must start with a letter or digit and ` +
        `contain only letters, digits, ".", "_", or "-" (no path separators or "..")`,
    );
  }
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function serializeManifest(manifest: RunManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * A handle on one run directory. Every manifest write re-opens the directory
 * through its binding — the runs root is re-verified against the real path it
 * was verified at, the run directory against the identity it was bound at —
 * and the write is then issued through *that* descriptor. Verification and
 * write therefore share one directory identity: an ancestor swapped after the
 * open cannot redirect the write, and a swap before it makes the open fail.
 */
export class RunHandle {
  readonly dir: string;
  readonly manifest: RunManifest;
  readonly #binding: RunDirBinding;

  constructor(dir: string, manifest: RunManifest, binding: RunDirBinding) {
    this.dir = dir;
    this.manifest = manifest;
    this.#binding = binding;
  }

  /** @internal Binding used by evidence writers that need the same descriptor. */
  get binding(): RunDirBinding {
    return this.#binding;
  }

  /**
   * Capture an artifact into this run, bound to the verified run directory for
   * the whole capture.
   *
   * The destination directory is opened and verified *before* the producer
   * runs and its descriptor is held until the bytes are published, so an
   * ancestor swapped while the producer works cannot redirect the artifact.
   * The producer itself writes into a process-private staging directory (it
   * cannot be handed a descriptor, and a plain path under the run directory
   * would be exactly the redirectable pathname this avoids); those bytes are
   * then copied to an exclusive temp entry through the held descriptor and
   * renamed into place, so a planted symlink at the destination is replaced
   * rather than followed.
   *
   * Returns the artifact's path inside the run.
   */
  async captureArtifact(
    subdir: string | undefined,
    name: string,
    capture: (outPath: string) => Promise<void>,
  ): Promise<string> {
    await withBoundRunDir(this.#binding, async (runDir) => {
      const target =
        subdir === undefined ? runDir : await runDir.openChild(subdir);
      const staging = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pickforge-capture-"),
      );
      try {
        const stagedPath = path.join(staging, name);
        await capture(stagedPath);
        await target.importFileAtomic(name, stagedPath);
      } finally {
        await fs.promises
          .rm(staging, { recursive: true, force: true })
          .catch(() => {});
        if (target !== runDir) await target.close();
      }
    });
    return subdir === undefined
      ? path.join(this.dir, name)
      : path.join(this.dir, subdir, name);
  }

  async #writeManifest(): Promise<void> {
    const content = serializeManifest(this.manifest);
    await withBoundRunDir(this.#binding, (runDir) =>
      runDir.writeFileAtomic("manifest.json", content),
    );
  }

  get runId(): string {
    return this.manifest.runId;
  }

  async addArtifact(
    type: ArtifactType,
    name: string,
    artifactPath: string,
  ): Promise<RunArtifact> {
    const relative = path.isAbsolute(artifactPath)
      ? path.relative(this.dir, artifactPath)
      : artifactPath;
    const artifact: RunArtifact = {
      type,
      name,
      path: relative,
      createdAt: new Date().toISOString(),
    };
    this.manifest.artifacts.push(artifact);
    await this.#writeManifest();
    return artifact;
  }

  async setStatus(status: RunStatus): Promise<void> {
    this.manifest.status = status;
    await this.#writeManifest();
  }

  async finish(status: RunStatus = "completed"): Promise<void> {
    await this.setStatus(status);
  }
}

/**
 * Claim a fresh run directory directly under the verified root, through the
 * root's own descriptor. `mkdir` never follows a symlink at the final
 * component, so a planted entry with the same name only produces `EEXIST` and
 * the next suffix is tried.
 */
async function claimRunDir(root: DirHandle, baseName: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const runId = attempt === 1 ? baseName : `${baseName}-${attempt}`;
    try {
      await root.mkdirChild(runId);
      return runId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * Create the run's subdirectories and (for evidence runs) its empty journal
 * through the run directory's own descriptor, so the whole layout is created
 * inside the directory that was just verified — not at a pathname that an
 * ancestor swap could re-point between two steps.
 */
async function createRunLayout(
  runDir: DirHandle,
  evidence: boolean,
): Promise<void> {
  for (const name of RUN_SUBDIRS) {
    await runDir.mkdirChild(name);
  }
  if (evidence) {
    // Create the empty journal up front so appenders open (not create) it and
    // readers see a real file even before the first action lands. `wx` never
    // follows a symlink at the final component.
    const handle = await runDir.openFile(EVIDENCE_ACTION_LOG, "wx", 0o600);
    await handle.close();
  }
}

function buildManifest(
  runId: string,
  slug: string,
  now: Date,
  opts: CreateRunOptions,
): RunManifest {
  const manifest: RunManifest = {
    runId,
    slug,
    createdAt: now.toISOString(),
    status: "running",
    artifacts: [],
  };
  if (opts.sessionId !== undefined) manifest.sessionId = opts.sessionId;
  if (opts.meta !== undefined) manifest.meta = opts.meta;
  if (opts.evidence === true) {
    manifest.evidenceVersion = EVIDENCE_VERSION;
    manifest.actionLog = EVIDENCE_ACTION_LOG;
  }
  return manifest;
}

/**
 * Create a new run directory under the project's resolved run storage.
 *
 * The runs root is materialized descriptor by descriptor from the trusted
 * ancestor (project, Pickforge home, or custom base) with the same
 * lstat/realpath trust boundary the run catalog applies on read, and the run
 * directory, its layout, its journal, and its first manifest are all created
 * through those descriptors. A symlinked `.picklab` or `runs` entry raises
 * instead of redirecting the write, and nothing existing is moved or removed.
 */
export async function createRun(
  projectDir: string,
  slug: string,
  opts: CreateRunOptions = {},
  env: EnvLike = process.env,
): Promise<RunHandle> {
  assertValidSlug(slug);
  const now = opts.now ?? new Date();
  return withRunsRootDir(projectDir, env, async (root) => {
    const runId = await claimRunDir(root, `${formatTimestamp(now)}-${slug}`);
    const runDir = await openRunDirIn(root, runId);
    try {
      await createRunLayout(runDir, opts.evidence === true);
      const manifest = buildManifest(runId, slug, now, opts);
      await runDir.writeFileAtomic("manifest.json", serializeManifest(manifest));
      return new RunHandle(
        path.join(root.dir, runId),
        manifest,
        bindingFor(root, runDir),
      );
    } finally {
      await runDir.close();
    }
  });
}

/**
 * Adopt an existing run directory under an already verified runs root: the
 * single internal adoption helper for peers that take over a run they did not
 * create. `runId` must be one path component naming a real directory directly
 * under the root, and must be the run the manifest describes — so a
 * traversing or mismatched id is refused instead of adopting a directory
 * outside the verified root.
 *
 * Deliberately not part of the package's public API: adoption is internal to
 * evidence bookkeeping, and a path-bearing export would invite exactly the
 * out-of-root adoption this rejects.
 */
export async function adoptRunIn(
  root: DirHandle,
  runId: string,
  manifest: RunManifest,
): Promise<RunHandle> {
  if (manifest.runId !== runId) {
    throw new RunStorageAccessError(
      `Refusing to adopt run "${runId}": its manifest reports ` +
        `"${manifest.runId}"`,
    );
  }
  const runDir = await openRunDirIn(root, runId);
  try {
    return new RunHandle(
      path.join(root.dir, runId),
      manifest,
      bindingFor(root, runDir),
    );
  } finally {
    await runDir.close();
  }
}

/**
 * Adopt a run under the project's verified runs root. Thin wrapper over
 * {@link adoptRunIn} for callers that hold no root descriptor yet.
 */
export async function adoptRun(
  projectDir: string,
  runId: string,
  manifest: RunManifest,
  env: EnvLike = process.env,
): Promise<RunHandle> {
  return withRunsRootDir(projectDir, env, (root) =>
    adoptRunIn(root, runId, manifest),
  );
}

export { listRuns } from "./run-catalog.js";
