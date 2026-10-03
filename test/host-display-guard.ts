// Vitest global setup that fails the run when the host X display socket
// changes during the tests. On some hosts (for example Xwayland under
// Hyprland) the display is served only through its path socket, so a test
// that replaces that file breaks every new X11 app on the host. See #234.
//
// The guard compares the socket at setup and teardown. It also watches the
// socket directory during the run, so a socket that is created and removed,
// or moved away and back, also fails the run.
//
// The guard only observes. It never repairs the socket.

import fs from "node:fs";
import path from "node:path";

export type SocketState =
  | { kind: "absent" }
  | { kind: "present"; dev: number; ino: number };

export type GuardTeardown = () => Promise<void>;

const DISPLAY_RE = /^:(\d+)(?:\.\d+)?$/;
const WATCH_SETTLE_MS = 100;
const WATCHED_CHANGE = "created, removed, or renamed during the run";

/** Returns the path socket for a local DISPLAY such as ":0" or ":1.0". */
export function displaySocketPath(display: string | undefined): string | undefined {
  const match = DISPLAY_RE.exec(display ?? "");
  if (match === null) return undefined;
  // Xlib reads the display number as an integer, so ":061029" is X61029.
  return `/tmp/.X11-unix/X${Number.parseInt(match[1], 10)}`;
}

export function readSocketState(socketPath: string): SocketState {
  try {
    const stat = fs.lstatSync(socketPath);
    return { kind: "present", dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    throw error;
  }
}

/** Describes how the socket changed, or returns undefined when it did not. */
export function describeSocketChange(
  before: SocketState,
  after: SocketState,
): string | undefined {
  if (before.kind === "absent" && after.kind === "absent") return undefined;
  if (before.kind === "absent") return "created";
  if (after.kind === "absent") return "removed";
  if (before.dev === after.dev && before.ino === after.ino) return undefined;
  return "replaced";
}

export function socketChangeError(
  display: string,
  socketPath: string,
  change: string,
): Error {
  return new Error(
    `The host display socket for DISPLAY=${display} changed during the test run ` +
      `(${socketPath} was ${change}). New X11 apps on this host may fail until the ` +
      `display server restarts. See pickforge/pickforge#234.`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SocketWatch {
  /** The first watched change, or undefined when none was seen. */
  change(): string | undefined;
  close(): void;
}

/**
 * Watches the socket directory for rename events on the socket name.
 * Returns undefined when the directory cannot be watched, for example when
 * it does not exist. The guard then relies on snapshots only.
 */
export function watchSocket(socketPath: string): SocketWatch | undefined {
  const name = path.basename(socketPath);
  let change: string | undefined;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(path.dirname(socketPath), { persistent: false }, (event, filename) => {
      if (event === "rename" && filename === name) change ??= WATCHED_CHANGE;
    });
  } catch {
    return undefined;
  }
  // A watch error ends the watch. The final snapshot still runs.
  watcher.on("error", () => watcher.close());
  watcher.unref();
  return { change: () => change, close: () => watcher.close() };
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads the final socket state and returns the first change, if any. */
function findSocketChange(
  socketPath: string,
  before: SocketState,
  watch: SocketWatch | undefined,
): string | undefined {
  const watched = watch?.change();
  if (watched !== undefined) return watched;
  let after: SocketState;
  try {
    after = readSocketState(socketPath);
  } catch (error) {
    throw new Error(
      `The host display guard could not read ${socketPath} at teardown: ` +
        `${errorMessage(error)}. See pickforge/pickforge#234.`,
    );
  }
  return describeSocketChange(before, after);
}

/** Reads the setup state, or warns and returns undefined when it cannot. */
function readSetupState(socketPath: string): SocketState | undefined {
  try {
    return readSocketState(socketPath);
  } catch (error) {
    console.warn(
      `Host display guard inactive: could not read ${socketPath} (${errorMessage(error)}).`,
    );
    return undefined;
  }
}

/** Starts guarding one socket path and returns the teardown check. */
export function startGuard(display: string, socketPath: string): GuardTeardown | undefined {
  const before = readSetupState(socketPath);
  if (before === undefined) return undefined;
  const watch = watchSocket(socketPath);
  return async () => {
    await settle(WATCH_SETTLE_MS);
    watch?.close();
    let change: string | undefined;
    try {
      change = findSocketChange(socketPath, before, watch);
    } catch (error) {
      // Vitest only logs teardown errors, so set the exit code as well.
      process.exitCode = 1;
      throw error;
    }
    if (change !== undefined) {
      process.exitCode = 1;
      throw socketChangeError(display, socketPath, change);
    }
  };
}

export default function setup(): GuardTeardown | undefined {
  const display = process.env.DISPLAY;
  const socketPath = displaySocketPath(display);
  if (display === undefined || socketPath === undefined) return undefined;
  return startGuard(display, socketPath);
}
