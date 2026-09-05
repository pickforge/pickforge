import fs from "node:fs";
import path from "node:path";
import { isPathConfined } from "@pickforge/lab-core";

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
  await fs.promises.mkdir(layout.runtimeDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(layout.runtimeDir, 0o700);
}

export interface RuntimeDirRemoval {
  removed: boolean;
  error?: Error;
}

/**
 * Delete a session's runtime directory, refusing any path that is not confined
 * to the session directory. The confinement check follows symlinks so a planted
 * link cannot redirect the delete out of the session tree.
 */
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
    await fs.promises.rm(runtimeDir, { recursive: true, force: true });
    return { removed: true };
  } catch (error) {
    return {
      removed: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
