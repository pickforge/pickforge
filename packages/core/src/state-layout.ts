import type { DirHandle } from "./dir-handle.js";
import { RunStorageAccessError } from "./dir-handle.js";

/**
 * The project-state layout this build reads and writes.
 *
 * Version 1 is the layout alpha.1 and alpha.2 already wrote. It is *described*
 * here rather than changed, so no existing state needs migrating: a directory
 * written by an earlier build is already conformant and is adopted in place by
 * stamping the marker beside what is there.
 *
 * This module must stay in sync with the Rust CLI's `state.rs`; both tools
 * write the same marker bytes and agree on the ownership table below.
 */
export const LAYOUT_VERSION = 1 as const;

/** Discriminator, so an unrelated `layout.json` is not mistaken for ours. */
export const LAYOUT_KIND = "pickforge-project-state";

/** The shared ownership marker inside a project state directory. */
export const LAYOUT_MARKER = "layout.json";

/**
 * Who owns one entry directly inside `<PICKFORGE_HOME>/projects/<projectId>/`.
 *
 * | entry                              | owner         |
 * | ---------------------------------- | ------------- |
 * | `layout.json`                      | `shared`      |
 * | `project.json`                     | `integration` |
 * | `project.json.pickforge-backup-*`  | `integration` |
 * | `.pickforge-tmp-*`                 | `transient`   |
 * | `runs/`                            | `lab`         |
 * | anything else                      | `foreign`     |
 *
 * Ownership is exhaustive and non-overlapping: the Rust integration CLI writes
 * only `integration` entries, the TypeScript lab writes only `lab` entries, and
 * neither writes, moves, or deletes a `foreign` one. A `transient` entry is an
 * in-flight write by either tool, always uniquely named, and safe for the tool
 * that created it to leave behind.
 */
export type StateEntryOwner =
  | "shared"
  | "integration"
  | "lab"
  | "transient"
  | "foreign";

const RECEIPT = "project.json";
const RECEIPT_BACKUP_PREFIX = "project.json.pickforge-backup-";
/** In-flight writes by either tool. Exported so the claim can name one. */
export const TMP_PREFIX = ".pickforge-tmp-";
const LAB_RUNS = "runs";

/**
 * Classify one entry name inside a project state directory. Must stay
 * byte-for-byte equivalent to the Rust `classify_entry`; `test/state-layout`
 * pins the two against one shared table.
 */
export function classifyEntry(name: string): StateEntryOwner {
  if (name === LAYOUT_MARKER) return "shared";
  if (name.startsWith(TMP_PREFIX)) return "transient";
  if (name === RECEIPT || name.startsWith(RECEIPT_BACKUP_PREFIX)) {
    return "integration";
  }
  if (name === LAB_RUNS) return "lab";
  return "foreign";
}

/** The exact marker bytes. Both tools write this, so whichever claims a
 * directory first leaves identical content. */
export function layoutMarkerContent(): string {
  return `{\n  "layout": "${LAYOUT_KIND}",\n  "layoutVersion": ${LAYOUT_VERSION}\n}\n`;
}

/** A layout this build cannot safely write into. Carries the manual action. */
export class StateLayoutError extends Error {}

function unsupported(dir: string, found: number): StateLayoutError {
  return new StateLayoutError(
    `Project state directory ${dir} uses layout version ${found}, but this ` +
      `Pickforge build only understands version ${LAYOUT_VERSION}. Upgrade ` +
      `Pickforge, or run with a different PICKFORGE_HOME.`,
  );
}

function unrecognized(dir: string): StateLayoutError {
  return new StateLayoutError(
    `${dir}/${LAYOUT_MARKER} is not a Pickforge layout marker. Move it aside ` +
      `and re-run, or run with a different PICKFORGE_HOME.`,
  );
}

/** Parse and validate marker content, or throw with the manual action. */
function assertSupported(dir: string, content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw unrecognized(dir);
  }
  if (typeof parsed !== "object" || parsed === null) throw unrecognized(dir);
  const marker = parsed as { layout?: unknown; layoutVersion?: unknown };
  if (marker.layout !== LAYOUT_KIND) throw unrecognized(dir);
  if (typeof marker.layoutVersion !== "number") throw unrecognized(dir);
  if (marker.layoutVersion !== LAYOUT_VERSION) {
    throw unsupported(dir, marker.layoutVersion);
  }
}

/**
 * Read the layout version of an already-open project state directory.
 * `undefined` means the directory predates the marker (alpha.1/alpha.2), which
 * callers treat as version 1 by adoption — never as a reason to rewrite it.
 */
export async function readProjectStateLayout(
  stateDir: DirHandle,
): Promise<number | undefined> {
  const content = await stateDir.readFileIfPresent(LAYOUT_MARKER);
  if (content === undefined) return undefined;
  assertSupported(stateDir.dir, content);
  return LAYOUT_VERSION;
}

let claimTmpCounter = 0;

/**
 * Claim an open project state directory for the shared layout, atomically and
 * at most once.
 *
 * The marker is written to a private temp entry and published with `link(2)`,
 * which fails with `EEXIST` when the marker already exists. That gives both
 * exclusivity *and* full content in one step: the loser of a race with the
 * Rust CLI always reads a complete marker, never the empty file an `O_EXCL`
 * create would expose between creation and write. Everything resolves through
 * the directory's pinned descriptor, so the marker lands in the verified
 * directory or nowhere.
 *
 * A crash before publication leaves at most a `.pickforge-tmp-` entry — which
 * `pickforge init` already tolerates — rather than partial ownership, and the
 * next run claims the directory. An existing marker is never rewritten, so an
 * alpha.1/alpha.2 directory is adopted purely additively.
 *
 * Returns whether this call created the marker.
 */
export async function claimProjectStateLayout(
  stateDir: DirHandle,
): Promise<boolean> {
  claimTmpCounter += 1;
  const temp = `${TMP_PREFIX}layout-${process.pid}-${claimTmpCounter}`;
  try {
    const handle = await stateDir.openFile(temp, "wx");
    try {
      await handle.writeFile(layoutMarkerContent(), "utf8");
    } finally {
      await handle.close();
    }
    await stateDir.linkChild(temp, LAYOUT_MARKER);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      await readProjectStateLayout(stateDir);
      return false;
    }
    if (error instanceof StateLayoutError) throw error;
    throw new RunStorageAccessError(
      `Project state layout marker could not be written in ${stateDir.dir}: ` +
        `${(error as Error).message}`,
    );
  } finally {
    // The temp entry is ours either way; failing to remove it is not a reason
    // to fail the claim, since `pickforge init` tolerates a stray one.
    await stateDir.unlinkChild(temp).catch(() => {});
  }
}
