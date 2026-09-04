import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { EnvLike } from "./paths.js";
import { createRun, type RunHandle } from "./run.js";
import { getSession, listSessions, type SessionRecord } from "./session.js";

/**
 * A capability a session record can provide. Resolution keys off which legs a
 * record carries, not its declared `type`: a browser session owns a desktop
 * leg, so it satisfies the `desktop` capability as well as `browser`.
 */
export type SessionCapability = "desktop" | "android" | "browser";

/** Backwards-compatible alias for the capability a consumer resolves against. */
export type RunnableSessionType = SessionCapability;

export function sessionHasCapability(
  record: SessionRecord,
  capability: SessionCapability,
): boolean {
  switch (capability) {
    case "desktop":
      return record.desktop !== undefined;
    case "android":
      return record.android !== undefined;
    case "browser":
      return record.browser !== undefined;
  }
}

export interface ResolveRunnableSessionOptions {
  env?: EnvLike;
  projectDir?: string;
  consumerLabel: string;
  createHint: string;
  selectHint: string;
}

export async function resolveRunnableSession(
  capability: SessionCapability,
  id: string | undefined,
  opts: ResolveRunnableSessionOptions,
): Promise<SessionRecord> {
  const env = opts.env ?? process.env;
  if (id !== undefined) {
    const record = await getSession(id, env);
    if (record === undefined) {
      throw new Error(`Session not found: ${id}`);
    }
    if (!sessionHasCapability(record, capability)) {
      throw new Error(
        `Session ${id} is of type "${record.type}" and has no ${capability} capability, ` +
          `but this ${opts.consumerLabel} needs a ${capability} session`,
      );
    }
    return record;
  }
  let candidates = (await listSessions(env)).filter(
    (record) =>
      record.status === "running" && sessionHasCapability(record, capability),
  );
  let scopeLabel = "found";
  if (opts.projectDir !== undefined) {
    const projectDir = path.resolve(opts.projectDir);
    candidates = candidates.filter(
      (record) => record.projectDir === projectDir,
    );
    scopeLabel = "for this project";
  }
  if (candidates.length === 0) {
    throw new Error(
      `No running ${capability} session ${scopeLabel}; ${opts.createHint}`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple running ${capability} sessions ${scopeLabel} ` +
        `(${candidates.map((record) => record.id).join(", ")}); ` +
        opts.selectHint,
    );
  }
  return candidates[0] as SessionRecord;
}

export interface ResolveDesktopCapableSessionOptions {
  env?: EnvLike;
  projectDir?: string;
}


export async function resolveDesktopCapableSession(
  id: string | undefined,
  opts: ResolveDesktopCapableSessionOptions = {},
): Promise<SessionRecord> {
  const record = await resolveRunnableSession("desktop", id, {
    env: opts.env,
    projectDir: opts.projectDir,
    consumerLabel: "watch",
    createHint: "create one with: pickforge-lab session create --type desktop",
    selectHint: "pick one with --session <id>",
  });
  if (record.status !== "running") {
    throw new Error(`Session ${record.id} is not running`);
  }
  return record;
}

export function requireDisplay(record: SessionRecord): string {
  const display = record.desktop?.display;
  if (display === undefined) {
    throw new Error(`Session ${record.id} has no display recorded`);
  }
  return display;
}

async function realpathNearest(target: string): Promise<string> {
  let probe = target;
  while (true) {
    try {
      const real = await realpath(probe);
      if (probe === target) {
        return real;
      }
      return path.join(real, path.relative(probe, target));
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return target;
      }
      probe = parent;
    }
  }
}

export interface ResolveConfinedPathOptions {
  baseDir: string;
  requestedPath: string;
  errorMessage: string;
  rejectBase?: boolean;
  rejectFinalSymlink?: boolean;
}

function isOutside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

export async function resolveConfinedPath(
  opts: ResolveConfinedPathOptions,
): Promise<string> {
  const base = path.resolve(opts.baseDir);
  const target = path.resolve(base, opts.requestedPath);
  if ((opts.rejectBase === true && target === base) || isOutside(base, target)) {
    throw new Error(opts.errorMessage);
  }
  if (opts.rejectFinalSymlink === true) {
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        throw new Error(opts.errorMessage);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const realBase = await realpathNearest(base);
  const realTarget = await realpathNearest(target);
  if (realTarget !== realBase && isOutside(realBase, realTarget)) {
    throw new Error(opts.errorMessage);
  }
  return target;
}

export interface ScreenshotTarget {
  outPath: string;
  run?: RunHandle;
}

export interface ResolveScreenshotTargetOptions {
  projectDir: string;
  out?: string;
  outBaseDir?: string;
  runSlug?: string;
  defaultSlug: string;
  sessionId?: string;
  conflictError: string;
  env?: EnvLike;
}

export async function resolveScreenshotTarget(
  opts: ResolveScreenshotTargetOptions,
): Promise<ScreenshotTarget> {
  if (opts.out !== undefined && opts.runSlug !== undefined) {
    throw new Error(opts.conflictError);
  }
  if (opts.out !== undefined) {
    if (opts.outBaseDir === undefined) {
      return { outPath: path.resolve(opts.out) };
    }
    const errorMessage =
      `Refusing to write screenshot outside the project directory: ${opts.out}`;
    const outPath = await resolveConfinedPath({
      baseDir: opts.outBaseDir,
      requestedPath: opts.out,
      errorMessage,
      rejectBase: true,
      // A final symlink could be swapped before the subsequent write. Output
      // paths therefore reject it even when its current target is confined.
      rejectFinalSymlink: true,
    });
    return { outPath };
  }
  const run = await createRun(
    opts.projectDir,
    opts.runSlug ?? opts.defaultSlug,
    opts.sessionId === undefined ? {} : { sessionId: opts.sessionId },
    opts.env,
  );
  return {
    outPath: path.join(run.dir, "screenshots", "screenshot.png"),
    run,
  };
}

/**
 * Capture an artifact into a run, bound to the run's verified directory for
 * the whole capture. See {@link RunHandle.captureArtifact}: the destination
 * descriptor is held across the producer's run, so no ancestor swap can
 * redirect the published artifact.
 *
 * Returns the artifact's path inside the run.
 */
export async function captureRunArtifact(
  run: RunHandle,
  subdir: string | undefined,
  name: string,
  capture: (outPath: string) => Promise<void>,
): Promise<string> {
  return run.captureArtifact(subdir, name, capture);
}

/**
 * Run a screenshot capture against a resolved target and record it.
 *
 * `capture` receives the path it must write to. For a run-backed target that
 * is a private staging path whose bytes are published into the run through the
 * verified run directory's descriptor; for an explicit `--out` target it is
 * the confined output path itself.
 */
export async function captureToTarget(
  target: ScreenshotTarget,
  capture: (outPath: string) => Promise<void>,
): Promise<Record<string, unknown>> {
  const run = target.run;
  try {
    if (run === undefined) {
      await capture(target.outPath);
    } else {
      await captureRunArtifact(
        run,
        "screenshots",
        path.basename(target.outPath),
        capture,
      );
    }
  } catch (error) {
    if (run !== undefined) await run.finish("failed").catch(() => {});
    throw error;
  }
  const data: Record<string, unknown> = { path: target.outPath };
  if (run !== undefined) {
    try {
      await run.addArtifact(
        "screenshot",
        path.basename(target.outPath),
        target.outPath,
      );
      await run.finish("completed");
    } catch (error) {
      await run.finish("failed").catch(() => {});
      throw error;
    }
    data.runId = run.runId;
    data.runDir = run.dir;
  }
  return data;
}
