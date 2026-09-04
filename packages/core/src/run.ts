import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic, type EnvLike } from "./paths.js";
import {
  assertRunDirIntact,
  bindRunDir,
  ensureVerifiedRunsRoot,
  verifyWritableDir,
  type RunDirIdentity,
  type VerifiedRunRoot,
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

async function writeManifest(
  runDir: string,
  manifest: RunManifest,
  identity: RunDirIdentity | undefined,
): Promise<void> {
  // A handle bound at creation (or adoption) re-verifies the run directory
  // before every manifest write, so a directory swapped for a symlink after
  // verification cannot redirect the write. Unbound handles keep the plain
  // behavior for callers that construct them directly.
  if (identity !== undefined) await assertRunDirIntact(identity);
  const target = path.join(runDir, "manifest.json");
  await writeFileAtomic(target, `${JSON.stringify(manifest, null, 2)}\n`);
}

export class RunHandle {
  readonly dir: string;
  readonly manifest: RunManifest;
  readonly #identity: RunDirIdentity | undefined;

  constructor(dir: string, manifest: RunManifest, identity?: RunDirIdentity) {
    this.dir = dir;
    this.manifest = manifest;
    this.#identity = identity;
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
    await writeManifest(this.dir, this.manifest, this.#identity);
    return artifact;
  }

  async setStatus(status: RunStatus): Promise<void> {
    this.manifest.status = status;
    await writeManifest(this.dir, this.manifest, this.#identity);
  }

  async finish(status: RunStatus = "completed"): Promise<void> {
    await this.setStatus(status);
  }
}

/**
 * Claim a fresh run directory directly under the verified root. A plain
 * `mkdir` never follows a symlink at the final component, so a planted entry
 * with the same name only produces `EEXIST` and the next suffix is tried.
 */
async function claimRunDir(
  root: VerifiedRunRoot,
  baseName: string,
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const runId = attempt === 1 ? baseName : `${baseName}-${attempt}`;
    try {
      await fs.promises.mkdir(path.join(root.dir, runId));
      return runId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

async function createRunLayout(
  identity: RunDirIdentity,
  evidence: boolean,
): Promise<void> {
  const runDir = path.join(identity.root.dir, identity.dirName);
  const realRunDir = path.join(identity.root.realDir, identity.dirName);
  for (const name of RUN_SUBDIRS) {
    await fs.promises.mkdir(path.join(runDir, name));
    await verifyWritableDir(path.join(runDir, name), path.join(realRunDir, name));
  }
  if (evidence) {
    // Create the empty journal up front so appenders open (not create) it and
    // readers see a real file even before the first action lands. `wx` never
    // follows a symlink at the final component.
    await fs.promises.writeFile(path.join(runDir, EVIDENCE_ACTION_LOG), "", {
      encoding: "utf8",
      flag: "wx",
    });
  }
  await assertRunDirIntact(identity);
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
 * Create a new run directory under the project's resolved run storage. The
 * runs root is materialized through {@link ensureVerifiedRunsRoot}, so every
 * ancestor below the trusted directory (project, Pickforge home, or custom
 * base) is verified with the same lstat/realpath discipline the run catalog
 * applies on read. A symlinked `.picklab` or `runs` entry raises instead of
 * redirecting the write, and nothing existing is moved or removed.
 */
export async function createRun(
  projectDir: string,
  slug: string,
  opts: CreateRunOptions = {},
  env: EnvLike = process.env,
): Promise<RunHandle> {
  assertValidSlug(slug);
  const now = opts.now ?? new Date();
  const root = await ensureVerifiedRunsRoot(projectDir, env);
  const runId = await claimRunDir(root, `${formatTimestamp(now)}-${slug}`);
  const identity = await bindRunDir(root, runId);
  await createRunLayout(identity, opts.evidence === true);
  const runDir = path.join(root.dir, runId);
  const manifest = buildManifest(runId, slug, now, opts);
  await writeManifest(runDir, manifest, identity);
  return new RunHandle(runDir, manifest, identity);
}

/**
 * Open a handle on an existing run directory under the project's verified
 * runs root, bound to its current identity. Used when a peer adopts a run it
 * did not create; manifest writes through the handle re-verify the directory.
 */
export async function openRun(
  projectDir: string,
  runId: string,
  manifest: RunManifest,
  env: EnvLike = process.env,
): Promise<RunHandle> {
  const root = await ensureVerifiedRunsRoot(projectDir, env);
  const identity = await bindRunDir(root, runId);
  return new RunHandle(path.join(root.dir, runId), manifest, identity);
}

export { listRuns } from "./run-catalog.js";
