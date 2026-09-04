import { spawn } from "node:child_process";
import { once } from "node:events";
import type { EnvLike } from "@pickforge/lab-core";
import { findOnPath } from "./util.js";

const VIEWER_BINARIES = [
  "remote-viewer",
  "xtigervncviewer",
  "tigervncviewer",
  "vncviewer",
] as const;

export type VncViewerName = (typeof VIEWER_BINARIES)[number];

export interface DetectedVncViewer {
  name: VncViewerName;
  binary: string;
}

export interface OpenVncViewerOptions {
  port: number;
  env?: EnvLike;
  waitForExit?: boolean;
}

export interface OpenVncViewerResult {
  opened: boolean;
  endpoint: string;
  viewer?: VncViewerName;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  guidance?: string;
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port ${port}: expected an integer in 1-65535`);
  }
}

export function detectVncViewer(
  env: EnvLike = process.env,
): DetectedVncViewer | null {
  for (const name of VIEWER_BINARIES) {
    const binary = findOnPath(name, env);
    if (binary !== null) return { name, binary };
  }
  return null;
}

export function buildVncViewerArgs(name: VncViewerName, port: number): string[] {
  assertValidPort(port);
  if (name === "remote-viewer") {
    return [`vnc://127.0.0.1:${port}`];
  }
  return [`127.0.0.1::${port}`];
}

export async function openVncViewer(
  opts: OpenVncViewerOptions,
): Promise<OpenVncViewerResult> {
  assertValidPort(opts.port);
  const endpoint = `vnc://127.0.0.1:${opts.port}`;
  const env = { ...process.env, ...opts.env };
  const hasGui =
    (env.DISPLAY !== undefined && env.DISPLAY !== "") ||
    (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== "");
  const viewer = detectVncViewer(env);
  if (!hasGui || viewer === null) {
    const reason = !hasGui
      ? "No graphical host session is available."
      : "No supported VNC viewer was found on PATH.";
    return {
      opened: false,
      endpoint,
      guidance:
        `${reason} Install virt-viewer or TigerVNC, or connect remotely with ` +
        `ssh -N -L ${opts.port}:127.0.0.1:${opts.port} <host> and open ${endpoint}.`,
    };
  }

  const args = buildVncViewerArgs(viewer.name, opts.port);
  const waitForExit = opts.waitForExit !== false;
  const child = spawn(viewer.binary, args, {
    env,
    shell: false,
    stdio: "ignore",
  });
  let result: {
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
  } = {};
  if (waitForExit) {
    const [exitCode, signal] = await once(child, "close");
    result = { exitCode, signal };
  } else {
    await once(child, "spawn");
    child.unref();
  }
  return {
    opened: true,
    endpoint,
    viewer: viewer.name,
    ...result,
  };
}
