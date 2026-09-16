import fs from "node:fs";
import path from "node:path";
import { DirHandle, isPathConfined } from "@pickforge/lab-core";

/**
 * Per-session runtime layout for desktop sessions (pickforge/pickforge#86).
 *
 * Desktop apps used to inherit the invoking user's `XDG_RUNTIME_DIR` and D-Bus
 * addresses, so a toolkit, a portal, or an app's own single-instance check
 * could route work straight back into the real user session — the exact escape
 * an isolated display is supposed to prevent. Every session gets its own
 * runtime directory, mode 0700, inside the session directory, so one recursive
 * delete removes every trace when the session is destroyed.
 *
 * The D-Bus addresses point at socket paths inside that directory which
 * Pickforge never creates. That is deliberate: an app fails to connect to a bus
 * instead of silently reaching the user's. Leaving `DBUS_SESSION_BUS_ADDRESS`
 * unset would not be equivalent — libdbus then falls back to
 * `$XDG_RUNTIME_DIR/bus` and, failing that, to X11 autolaunch, which would
 * start a stray bus daemon.
 */
export interface DesktopRuntimeLayout {
  /** `XDG_RUNTIME_DIR` for everything the session starts. */
  runtimeDir: string;
  /** `DBUS_SESSION_BUS_ADDRESS` socket path (never created). */
  dbusSessionPath: string;
  /** `DBUS_SYSTEM_BUS_ADDRESS` socket path (never created). */
  dbusSystemPath: string;
}

export const DESKTOP_RUNTIME_DIR_NAME = "runtime";

export function desktopRuntimeLayout(sessionDir: string): DesktopRuntimeLayout {
  const runtimeDir = path.join(sessionDir, DESKTOP_RUNTIME_DIR_NAME);
  return {
    runtimeDir,
    dbusSessionPath: path.join(runtimeDir, "bus"),
    dbusSystemPath: path.join(runtimeDir, "system_bus_socket"),
  };
}

/**
 * Create the runtime directory with private permissions. `mkdir`'s mode is
 * filtered by the umask and does not change an existing directory, so the mode
 * is enforced with an explicit `chmod` as well.
 */
export async function createDesktopRuntimeDir(
  layout: DesktopRuntimeLayout,
): Promise<void> {
  const sessionDir = path.dirname(layout.runtimeDir);
  const parent = await DirHandle.open(path.dirname(sessionDir));
  try {
    const session = await parent.ensureChildDir(path.basename(sessionDir), 0o700);
    try {
      await tightenOwnedDirectory(session);
      await createPrivateRuntime(session, path.basename(layout.runtimeDir));
    } finally {
      await session.close();
    }
  } finally {
    await parent.close();
  }
}

async function tightenOwnedDirectory(dir: DirHandle): Promise<void> {
  if (dir.stat.uid !== process.getuid?.()) {
    throw new Error(`Refusing to chmod a directory with uncertain ownership: ${dir.dir}`);
  }
  // This resolves through the verified descriptor, never a replaceable pathname.
  await fs.promises.chmod(dir.resolve(), 0o700);
}

async function createPrivateRuntime(session: DirHandle, name: string): Promise<void> {
  const runtime = await session.ensureChildDir(name, 0o700);
  try {
    await tightenOwnedDirectory(runtime);
    const home = await runtime.ensureChildDir("home", 0o700);
    try {
      await tightenOwnedDirectory(home);
      for (const name of ["config", "data", "cache", "state"]) {
        const child = await home.ensureChildDir(name, 0o700);
        try {
          await tightenOwnedDirectory(child);
        } finally {
          await child.close();
        }
      }
    } finally {
      await home.close();
    }
  } finally {
    await runtime.close();
  }
}

export interface RuntimeDirRemoval {
  removed: boolean;
  error?: Error;
}

async function assertOwnedEntry(parent: DirHandle, name: string, expected: fs.Stats): Promise<void> {
  const current = await parent.lstatChild(name);
  if (current?.dev !== expected.dev || current?.ino !== expected.ino) {
    throw new Error(`Refusing to delete a replaced runtime entry: ${parent.dir}/${name}`);
  }
}

/** Descend only through verified handles; never give recursive rm a pathname. */
async function removeOwnedEntry(parent: DirHandle, name: string, expectedRoot?: fs.Stats): Promise<void> {
  const stat = await parent.lstatChild(name);
  if (stat === undefined) return;
  if (expectedRoot !== undefined &&
      (!stat.isDirectory() || stat.dev !== expectedRoot.dev || stat.ino !== expectedRoot.ino)) {
    throw new Error(`Refusing to delete a replaced runtime entry: ${parent.dir}/${name}`);
  }
  if (stat.uid !== process.getuid?.()) {
    throw new Error(`Refusing to delete a runtime entry with uncertain ownership: ${parent.dir}/${name}`);
  }
  if (!stat.isDirectory()) {
    // lstat proves ownership of the leaf, including a symlink, not its target.
    await assertOwnedEntry(parent, name, stat);
    await parent.unlinkChild(name);
    return;
  }
  const child = await DirHandle.open(parent.resolve(name), { expectedIdentity: stat });
  try {
    await assertOwnedEntry(parent, name, child.stat);
    for (const entry of await child.readEntryNames()) {
      await removeOwnedEntry(child, entry);
    }
    await assertOwnedEntry(parent, name, child.stat);
    await fs.promises.rmdir(parent.resolve(name));
  } finally {
    await child.close();
  }
}

/** Delete only the owned runtime tree. Refusals can leave a partially cleaned tree. */
export async function removeDesktopRuntimeDir(
  sessionDir: string,
  runtimeDir: string,
): Promise<RuntimeDirRemoval> {
  if (!(await isPathConfined(sessionDir, runtimeDir))) {
    return {
      removed: false,
      error: new Error(
        `Refusing to delete a runtime directory outside the session directory: ${runtimeDir}`,
      ),
    };
  }
  try {
    if (path.resolve(runtimeDir) !== path.resolve(sessionDir, DESKTOP_RUNTIME_DIR_NAME)) {
      throw new Error(`Refusing to delete an unexpected runtime directory: ${runtimeDir}`);
    }
    const parent = await DirHandle.open(path.dirname(sessionDir));
    try {
      const session = await parent.openChild(path.basename(sessionDir));
      try {
        const stat = await session.lstatChild(DESKTOP_RUNTIME_DIR_NAME);
        if (stat !== undefined && (!stat.isDirectory() || stat.uid !== process.getuid?.())) {
          throw new Error(`Refusing to delete a runtime directory with uncertain ownership: ${runtimeDir}`);
        }
        // An absent root needs no cleanup; never adopt an entry arriving afterward.
        if (stat !== undefined) await removeOwnedEntry(session, DESKTOP_RUNTIME_DIR_NAME, stat);
      } finally {
        await session.close();
      }
    } finally {
      await parent.close();
    }
    return { removed: true };
  } catch (error) {
    return {
      removed: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
