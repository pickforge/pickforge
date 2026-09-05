import fs from "node:fs";
import path from "node:path";

/**
 * Raised when a run-storage write would go through a symlink, a non-directory,
 * or a directory that no longer resolves where the trusted ancestor says it
 * should. Nothing is moved, rewritten, or removed when this is thrown: the
 * offending entry is the user's (or the repository's) to fix.
 */
export class RunStorageAccessError extends Error {}

/**
 * Directory capability paths.
 *
 * Node exposes no `openat`/`mkdirat`/`renameat` family, so the only way to
 * pin a write to a *directory identity* rather than to a pathname is Linux's
 * `/proc/self/fd/<fd>` capability path: the kernel resolves it through the
 * open file description, i.e. through the exact inode the descriptor holds.
 * Renaming or replacing any ancestor after the descriptor was opened does not
 * move the descriptor, so every write issued through such a path lands in the
 * verified directory or fails (`ENOENT` once the directory is unlinked) — it
 * can never be redirected somewhere else.
 *
 * This is a Linux-only mechanism and the TypeScript lab is Linux-only, so
 * everywhere else run-storage writes fail closed rather than silently falling
 * back to pathname writes that an ancestor swap could redirect.
 */
const PROC_FD_DIR = "/proc/self/fd";

let procFdPresent: boolean | undefined;

/** Whether `/proc/self/fd` capability paths are available on this host. */
export function capabilityPathsSupported(): boolean {
  if (process.platform !== "linux") return false;
  procFdPresent ??= fs.existsSync(PROC_FD_DIR);
  return procFdPresent;
}

function assertCapabilityPathsSupported(dir: string): void {
  if (capabilityPathsSupported()) return;
  throw new RunStorageAccessError(
    `Refusing to write run artifacts under ${dir}: binding a write to a ` +
      "verified directory needs Linux /proc/self/fd capability paths, which " +
      `are unavailable on ${process.platform}. The Pickforge lab is ` +
      "Linux-only; nothing was written, moved, or removed.",
  );
}

/**
 * One path component that may be resolved relative to an open directory.
 * Separators, `.`, `..`, and NUL are refused, so a name can never walk out of
 * the directory the descriptor pins.
 */
const UNSAFE_ENTRY_NAME = /^$|^\.{1,2}$|[/\\\0]/;

export function assertSafeEntryName(name: string, what = "entry name"): void {
  if (UNSAFE_ENTRY_NAME.test(name)) {
    throw new RunStorageAccessError(
      `Invalid ${what} "${name}": must be a single path component ` +
        '(no separators, "." or "..")',
    );
  }
}

async function isSymlink(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(dir)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Turn an `open` failure into the error the storage boundary reports. Linux
 * answers `O_DIRECTORY|O_NOFOLLOW` on a symlink with either `ELOOP` or
 * `ENOTDIR` depending on what the link points at, so the entry is lstat'd once
 * — only on the failure path — to name the actual problem.
 */
async function translateOpenError(
  error: unknown,
  dir: string,
): Promise<unknown> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ELOOP" || (code === "ENOTDIR" && (await isSymlink(dir)))) {
    return new RunStorageAccessError(
      `Refusing to write run artifacts through a symlink at ${dir}; ` +
        "replace it with a real directory (nothing was written, moved, or removed)",
    );
  }
  if (code === "ENOTDIR") {
    return new RunStorageAccessError(
      `Refusing to write run artifacts: ${dir} exists but is not a directory`,
    );
  }
  if (code === "ENOENT") {
    return new RunStorageAccessError(
      `Run storage path disappeared while being verified: ${dir}`,
    );
  }
  return error;
}

export interface OpenDirOptions {
  /**
   * Real path the opened directory must resolve to, read back *from the
   * descriptor* rather than from the pathname. This is what anchors a
   * directory reached through untrusted ancestors to the trusted ancestor's
   * real path: verification and every later write share one descriptor, so
   * they cannot disagree.
   */
  expectedRealDir?: string;
  /**
   * Allow a symlink at the final component. Only used for trusted ancestors a
   * user legitimately reaches through a link (the project directory, the
   * Pickforge home, a custom storage base).
   */
  followFinal?: boolean;
  /** Identity (`dev`/`ino`) the opened directory must still have. */
  expectedIdentity?: fs.Stats;
}

/**
 * An open directory descriptor plus the capability path that addresses it.
 * Every mutation offered here resolves through the descriptor, so it is bound
 * to the directory identity verified when the handle was opened.
 *
 * Handles own a file descriptor: close them (`close()`, or use
 * {@link withDirHandle}) or the process leaks descriptors.
 */
export class DirHandle {
  /** Logical path the directory was opened through, used in messages only. */
  readonly dir: string;
  /** Real path of the opened directory, read back from the descriptor. */
  readonly realDir: string;
  /** Identity of the opened directory (`fstat`, never a pathname `stat`). */
  readonly stat: fs.Stats;
  #handle: fs.promises.FileHandle | undefined;

  private constructor(
    dir: string,
    realDir: string,
    stat: fs.Stats,
    handle: fs.promises.FileHandle,
  ) {
    this.dir = dir;
    this.realDir = realDir;
    this.stat = stat;
    this.#handle = handle;
  }

  /**
   * Open and verify a directory by pathname. `O_NOFOLLOW` refuses a symlink at
   * the final component and `O_DIRECTORY` refuses a non-directory, both inside
   * the single `open` call; the real path is then read back from the resulting
   * descriptor, which is also the descriptor all later writes go through.
   */
  static async open(
    dir: string,
    opts: OpenDirOptions = {},
  ): Promise<DirHandle> {
    assertCapabilityPathsSupported(dir);
    let flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY;
    if (opts.followFinal !== true) flags |= fs.constants.O_NOFOLLOW;
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(dir, flags);
    } catch (error) {
      throw await translateOpenError(error, dir);
    }
    try {
      const stat = await handle.stat();
      const realDir = await fs.promises.realpath(`${PROC_FD_DIR}/${handle.fd}`);
      if (
        opts.expectedRealDir !== undefined &&
        realDir !== opts.expectedRealDir
      ) {
        throw new RunStorageAccessError(
          `Refusing to write run artifacts: ${dir} resolves to ${realDir}, ` +
            `expected ${opts.expectedRealDir}`,
        );
      }
      if (
        opts.expectedIdentity !== undefined &&
        (opts.expectedIdentity.dev !== stat.dev ||
          opts.expectedIdentity.ino !== stat.ino)
      ) {
        throw new RunStorageAccessError(
          `Run directory was replaced while in use: ${dir}`,
        );
      }
      return new DirHandle(dir, realDir, stat, handle);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  #fd(): number {
    if (this.#handle === undefined) {
      throw new RunStorageAccessError(
        `Run storage directory handle for ${this.dir} is already closed`,
      );
    }
    return this.#handle.fd;
  }

  /** Whether the descriptor is still open. */
  get open(): boolean {
    return this.#handle !== undefined;
  }

  /**
   * Capability path of this directory, or of an entry directly inside it. The
   * kernel resolves it through the pinned descriptor, so no ancestor of
   * {@link dir} takes part in the lookup.
   */
  resolve(name?: string): string {
    const base = `${PROC_FD_DIR}/${this.#fd()}`;
    if (name === undefined) return base;
    assertSafeEntryName(name);
    return `${base}/${name}`;
  }

  /** Open a subdirectory relative to this one; a symlink is refused. */
  async openChild(name: string): Promise<DirHandle> {
    assertSafeEntryName(name);
    const child = await DirHandle.open(this.resolve(name));
    return new DirHandle(
      path.join(this.dir, name),
      child.realDir,
      child.stat,
      child.#takeHandle(),
    );
  }

  /** Create a subdirectory relative to this one. `EEXIST` propagates. */
  async mkdirChild(name: string): Promise<void> {
    await fs.promises.mkdir(this.resolve(name));
  }

  /** Create the subdirectory if missing, then open it; a symlink is refused. */
  async ensureChildDir(name: string): Promise<DirHandle> {
    try {
      await this.mkdirChild(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return this.openChild(name);
  }

  /** `fs.open` on an entry of this directory, through the pinned descriptor. */
  openFile(
    name: string,
    flags: number | string,
    mode?: number,
  ): Promise<fs.promises.FileHandle> {
    return fs.promises.open(this.resolve(name), flags, mode);
  }

  /** `lstat` an entry of this directory, or `undefined` when it is missing. */
  async lstatChild(name: string): Promise<fs.Stats | undefined> {
    try {
      return await fs.promises.lstat(this.resolve(name));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  }

  /** Names of the entries directly inside this directory, through the pinned
   * descriptor. */
  readEntryNames(): Promise<string[]> {
    return fs.promises.readdir(this.resolve());
  }

  /** Read an entry of this directory, or `undefined` when it is missing. */
  async readFileIfPresent(name: string): Promise<string | undefined> {
    try {
      return await fs.promises.readFile(this.resolve(name), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  }

  /** Unlink an entry of this directory; returns whether one was removed. */
  async unlinkChild(name: string): Promise<boolean> {
    try {
      await fs.promises.unlink(this.resolve(name));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
  }

  /**
   * Hard-link `from` to `to` inside this directory, through the pinned
   * descriptor. Unlike a rename this *fails* with `EEXIST` when `to` already
   * exists, which is what makes it a create-at-most-once publish of content
   * that is already complete on disk.
   */
  async linkChild(from: string, to: string): Promise<void> {
    assertSafeEntryName(from);
    assertSafeEntryName(to);
    await fs.promises.link(this.resolve(from), this.resolve(to));
  }

  /**
   * Atomically publish `content` as `name` inside this directory: an exclusive
   * (`wx`) temp file, then a rename over the destination. Both steps resolve
   * through the pinned descriptor, so the bytes land in the verified directory
   * or nowhere. The destination's existing permission mode is preserved.
   */
  async writeFileAtomic(name: string, content: string): Promise<void> {
    assertSafeEntryName(name);
    atomicTmpCounter += 1;
    const tmp = `.${name}.tmp-${process.pid}-${atomicTmpCounter}`;
    const existing = await this.lstatChild(name);
    const mode =
      existing !== undefined && existing.isFile()
        ? existing.mode & 0o777
        : undefined;
    const tmpPath = this.resolve(tmp);
    try {
      await fs.promises.writeFile(tmpPath, content, {
        encoding: "utf8",
        flag: "wx",
        mode,
      });
      if (mode !== undefined) await fs.promises.chmod(tmpPath, mode);
      await fs.promises.rename(tmpPath, this.resolve(name));
    } catch (error) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Copy an outside file into this directory under `name`, atomically and
   * bound to the pinned descriptor: the bytes go to an exclusive temp entry
   * inside this directory and are renamed into place, so a planted symlink at
   * `name` is replaced rather than followed.
   */
  async importFileAtomic(name: string, sourcePath: string): Promise<void> {
    assertSafeEntryName(name);
    atomicTmpCounter += 1;
    const tmp = `.${name}.tmp-${process.pid}-${atomicTmpCounter}`;
    const tmpPath = this.resolve(tmp);
    try {
      // `COPYFILE_EXCL` creates the temp entry exclusively, so the copy can
      // never land on a pre-existing entry (a planted symlink included).
      await fs.promises.copyFile(
        sourcePath,
        tmpPath,
        fs.constants.COPYFILE_EXCL,
      );
      await fs.promises.rename(tmpPath, this.resolve(name));
    } catch (error) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  #takeHandle(): fs.promises.FileHandle {
    const handle = this.#handle;
    if (handle === undefined) {
      throw new RunStorageAccessError(
        `Run storage directory handle for ${this.dir} is already closed`,
      );
    }
    this.#handle = undefined;
    return handle;
  }

  /**
   * Release the descriptor. Idempotent, and the handle refuses every later
   * operation: a closed descriptor number can be reused by an unrelated open,
   * so a stale capability path must never be built.
   */
  async close(): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined) return;
    this.#handle = undefined;
    await handle.close();
  }
}

let atomicTmpCounter = 0;

/** Run `fn` with an open directory handle, always closing the descriptor. */
export async function withDirHandle<T>(
  handle: DirHandle | Promise<DirHandle>,
  fn: (dir: DirHandle) => Promise<T>,
): Promise<T> {
  const dir = await handle;
  try {
    return await fn(dir);
  } finally {
    await dir.close().catch(() => {});
  }
}
