import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
 * `test/fixtures/state-layout.json` is the one table both test suites check.
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
 * | `runs/`                            | `shared`      |
 * | `project.json`                     | `integration` |
 * | `project.json.pickforge-backup-*`  | `integration` |
 * | `.pickforge-tmp-*`                 | `transient`   |
 * | anything else                      | `foreign`     |
 *
 * Ownership is exhaustive and non-overlapping. `runs/` is shared because both
 * tools write into it: the lab creates run directories there, and `pickforge
 * evidence record` writes its own. Each tool writes only its own entries
 * below it, and neither writes, moves, or deletes the other's — or anything
 * `foreign`. A `transient` entry is an in-flight write by either tool, always
 * uniquely and unpredictably named, and never adopted by another invocation.
 */
export type StateEntryOwner =
  | "shared"
  | "integration"
  | "transient"
  | "foreign";

const RECEIPT = "project.json";
const RECEIPT_BACKUP_PREFIX = "project.json.pickforge-backup-";
/** In-flight writes by either tool. Exported so the claim can name one. */
export const TMP_PREFIX = ".pickforge-tmp-";
const RUNS = "runs";

/** A marker larger than this is not one of ours; refuse it unread. */
const MAX_MARKER_BYTES = 64 * 1024;

/**
 * A marker is briefly multiply linked while its writer publishes it with
 * `link(2)` and unlinks the staging entry. Readers wait out that window before
 * concluding a marker is a planted hard link.
 */
const LINK_SETTLE_ATTEMPTS = 40;
const LINK_SETTLE_PAUSE_MS = 5;

/** How many unpredictable staging names to try before giving up. */
const STAGING_ATTEMPTS = 8;

/**
 * Classify one entry name inside a project state directory. Must stay
 * byte-for-byte equivalent to the Rust `classify_entry`; both suites check the
 * same `test/fixtures/state-layout.json` table.
 */
export function classifyEntry(name: string): StateEntryOwner {
  if (name === LAYOUT_MARKER || name === RUNS) return "shared";
  if (name.startsWith(TMP_PREFIX)) return "transient";
  if (name === RECEIPT || name.startsWith(RECEIPT_BACKUP_PREFIX)) {
    return "integration";
  }
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

/**
 * The exact manual action for anything the lab will not adopt. It never moves
 * or deletes state it does not own, so the remedy is always the user's; the
 * command is shell-quoted and never clobbers. A name that cannot be rendered
 * as a safe shell word is described instead of being offered as a command.
 */
export function manualAction(entryPath: string, reason: string): string {
  const remedy = shellCommand(entryPath);
  return (
    `${entryPath} ${reason}. Pickforge will not move or delete it. ` +
    `${remedy} and re-run, or run with a different PICKFORGE_HOME.`
  );
}

const UNSAFE_SHELL_WORD =
  /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function shellQuote(value: string): string | undefined {
  if (UNSAFE_SHELL_WORD.test(value)) return undefined;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function unusedBackupPath(entryPath: string): string {
  for (let attempt = 1; attempt <= 64; attempt += 1) {
    const candidate =
      attempt === 1 ? `${entryPath}.bak` : `${entryPath}.bak-${attempt}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${entryPath}.bak-new`;
}

function shellCommand(entryPath: string): string {
  const source = shellQuote(entryPath);
  const destination = shellQuote(unusedBackupPath(entryPath));
  if (source === undefined || destination === undefined) {
    return "Move it aside yourself — its name cannot be shown as a safe shell command —";
  }
  return `Move it aside (\`mv -n -- ${source} ${destination}\`)`;
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the marker as a regular, singly linked file, without following a link
 * at the final component. `undefined` means there is no marker; a symlink, a
 * non-regular file, an oversized one, or a hard link is refused with the
 * manual action rather than read.
 */
async function readMarkerFile(
  stateDir: DirHandle,
): Promise<string | undefined> {
  const markerPath = path.join(stateDir.dir, LAYOUT_MARKER);
  const refuse = (reason: string): StateLayoutError =>
    new StateLayoutError(manualAction(markerPath, reason));
  for (let attempt = 0; attempt < LINK_SETTLE_ATTEMPTS; attempt += 1) {
    let handle: fs.promises.FileHandle;
    try {
      handle = await stateDir.openFile(
        LAYOUT_MARKER,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      if (code === "ELOOP") {
        throw refuse(
          "is a symbolic link where the Pickforge layout marker must be a regular file",
        );
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw refuse(
          "is not a regular file where the Pickforge layout marker must be one",
        );
      }
      if (stat.size > MAX_MARKER_BYTES) {
        throw refuse("is too large to be a Pickforge layout marker");
      }
      if (stat.nlink === 1) return await handle.readFile("utf8");
    } finally {
      await handle.close().catch(() => {});
    }
    await sleep(LINK_SETTLE_PAUSE_MS);
  }
  throw refuse(
    "is a hard link to another file, where the Pickforge layout marker must be " +
      "a regular file with exactly one name",
  );
}

/**
 * Read the layout version of an already-open project state directory.
 * `undefined` means the directory predates the marker (alpha.1/alpha.2), which
 * callers treat as version 1 by adoption — never as a reason to rewrite it.
 */
export async function readProjectStateLayout(
  stateDir: DirHandle,
): Promise<number | undefined> {
  const content = await readMarkerFile(stateDir);
  if (content === undefined) return undefined;
  assertSupported(stateDir.dir, content);
  return LAYOUT_VERSION;
}

/**
 * The one direct-entry rule, applied before any first adoption: a directory
 * about to be claimed may hold only entries the table assigns to an owner. A
 * foreign entry is refused with the exact manual action and nothing is
 * written.
 *
 * Once a directory carries a marker this is not re-run: ownership was settled
 * when it was claimed, and re-policing it would let an entry created later
 * break a tool that never reads it.
 */
async function assertAdoptable(stateDir: DirHandle): Promise<void> {
  for (const name of await stateDir.readEntryNames()) {
    if (classifyEntry(name) !== "foreign") continue;
    throw new StateLayoutError(
      manualAction(
        path.join(stateDir.dir, name),
        "is not owned by Pickforge or the Pickforge lab",
      ),
    );
  }
}

/** A staging entry this invocation created, tracked by identity. */
interface Staged {
  name: string;
  identity: fs.Stats;
}

/**
 * Stage the marker bytes in an unpredictable, exclusively created entry, with
 * the content complete and flushed before anything can link to it. Only
 * `EEXIST` on the *staging* name is retried; every other failure — and every
 * failure of the publication that follows — is reported as itself.
 */
async function stageMarker(stateDir: DirHandle): Promise<Staged> {
  for (let attempt = 0; attempt < STAGING_ATTEMPTS; attempt += 1) {
    const name = `${TMP_PREFIX}layout-${crypto.randomBytes(16).toString("hex")}`;
    let handle: fs.promises.FileHandle;
    try {
      handle = await stateDir.openFile(name, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(layoutMarkerContent(), "utf8");
      await handle.sync();
      return { name, identity: await handle.stat() };
    } finally {
      await handle.close();
    }
  }
  throw new RunStorageAccessError(
    `Could not create a staging entry for the project state layout marker in ${stateDir.dir}`,
  );
}

/**
 * Remove the staging entry only when its name still resolves to the entry this
 * invocation created. A pre-existing entry is never deleted.
 */
async function discardStaged(
  stateDir: DirHandle,
  staged: Staged,
): Promise<void> {
  try {
    const current = await stateDir.lstatChild(staged.name);
    if (
      current === undefined ||
      !current.isFile() ||
      current.dev !== staged.identity.dev ||
      current.ino !== staged.identity.ino
    ) {
      return;
    }
    await stateDir.unlinkChild(staged.name);
  } catch {
    // The staging entry is inert and uniquely named; failing to remove it is
    // not a reason to fail a claim that otherwise succeeded.
  }
}

/**
 * Claim an open project state directory for the shared layout, atomically and
 * at most once.
 *
 * The marker is staged in an unpredictable, exclusively created entry and
 * published with `link(2)`, which fails with `EEXIST` when the marker already
 * exists. That gives both exclusivity *and* full content in one step: the
 * loser of a race with the Rust CLI always reads a complete marker, never the
 * empty file an `O_EXCL` create would expose between creation and write.
 * Everything resolves through the directory's pinned descriptor, so the marker
 * lands in the verified directory or nowhere.
 *
 * Whoever ends up owning the marker, it is read back and validated before this
 * returns, so a claim never continues into a directory with no marker or one
 * this build does not understand. A crash before publication leaves at most an
 * inert `.pickforge-tmp-` entry, which is never adopted as a later
 * invocation's staging file. An existing marker is never rewritten, so an
 * alpha.1/alpha.2 directory is adopted purely additively.
 *
 * Returns whether this call created the marker.
 */
export async function claimProjectStateLayout(
  stateDir: DirHandle,
): Promise<boolean> {
  if ((await readProjectStateLayout(stateDir)) !== undefined) return false;
  await assertAdoptable(stateDir);
  const staged = await stageMarker(stateDir);
  let claimed: boolean;
  try {
    await stateDir.linkChild(staged.name, LAYOUT_MARKER);
    claimed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await discardStaged(stateDir, staged);
      throw new RunStorageAccessError(
        `Project state layout marker could not be written in ${stateDir.dir}: ` +
          `${(error as Error).message}`,
      );
    }
    claimed = false;
  }
  await discardStaged(stateDir, staged);
  // Winner or loser, the marker that is actually there is what the rest of
  // this process trusts, so it must exist and validate.
  if ((await readProjectStateLayout(stateDir)) === undefined) {
    throw new RunStorageAccessError(
      `The project state layout marker in ${stateDir.dir} disappeared while it ` +
        `was being claimed`,
    );
  }
  return claimed;
}
