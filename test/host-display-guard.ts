// Vitest global setup that fails the run when the host X display socket
// changes during the tests. On some hosts (for example Xwayland under
// Hyprland) the display is served only through its path socket, so a test
// that replaces that file breaks every new X11 app on the host. See #234.
//
// The guard only observes. It never repairs the socket.

import fs from "node:fs";

export type SocketState =
  | { kind: "absent" }
  | { kind: "present"; dev: number; ino: number };

const DISPLAY_RE = /^:(\d+)(?:\.\d+)?$/;

/** Returns the path socket for a local DISPLAY such as ":0" or ":1.0". */
export function displaySocketPath(display: string | undefined): string | undefined {
  const match = DISPLAY_RE.exec(display ?? "");
  return match === null ? undefined : `/tmp/.X11-unix/X${match[1]}`;
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
    `The host display socket for DISPLAY=${display} was replaced during the test run ` +
      `(${socketPath} was ${change}). New X11 apps on this host may fail until the ` +
      `display server restarts. See pickforge/pickforge#234.`,
  );
}

export default function setup(): (() => void) | undefined {
  const display = process.env.DISPLAY;
  const socketPath = displaySocketPath(display);
  if (display === undefined || socketPath === undefined) return undefined;
  const before = readSocketState(socketPath);
  return () => {
    const change = describeSocketChange(before, readSocketState(socketPath));
    if (change !== undefined) {
      // Vitest only logs teardown errors, so set the exit code as well.
      process.exitCode = 1;
      throw socketChangeError(display, socketPath, change);
    }
  };
}
