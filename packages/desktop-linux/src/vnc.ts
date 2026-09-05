import net from "node:net";
import {
  isPidAlive,
  readProcessIdentity,
  startDaemon,
  stopOwnedDaemonGroup,
  type EnvLike,
  type OwnedDaemonHandle,
} from "@pickforge/lab-core";
import { parseDisplayNumber } from "./display.js";
import { createIsolatedDesktopEnvironment } from "./environment.js";
import type { DesktopRuntimeLayout } from "./runtime.js";
import { findOnPath, sleep } from "./util.js";

const VNC_BASE_PORT = 5900;
const STARTUP_TIMEOUT_MS = 5_000;
const STARTUP_POLL_INTERVAL_MS = 100;

export interface VncArgsOptions {
  display: string;
  port: number;
  viewOnly?: boolean;
}

export interface StartVncOptions {
  display: string;
  port?: number;
  logDir: string;
  env?: EnvLike;
  viewOnly?: boolean;
  /** Per-session runtime dir and D-Bus endpoints (#86). */
  runtime?: DesktopRuntimeLayout;
}

export interface VncHandle {
  pid: number;
  startTimeTicks: number;
  port: number;
  logPath: string;
}

/**
 * What is known about an x11vnc that was spawned but never became a usable
 * server, mirroring `XvfbPartialStart` (#57): the caller owns this pid whether
 * or not startup succeeded, so a failed create must be able to record it and
 * to know whether its cleanup was confirmed.
 */
export interface VncPartialStart {
  pid: number;
  /** Only when `/proc` was still readable when the failure was handled. */
  startTimeTicks?: number;
  port: number;
  logPath: string;
  /** True only when the whole spawned process group is confirmed gone. */
  cleanupConfirmed: boolean;
}

export type VncStartFailureReason = "exited" | "identity" | "timeout";

export class VncStartError extends Error {
  readonly reason: VncStartFailureReason;
  readonly partial: VncPartialStart | undefined;

  constructor(
    reason: VncStartFailureReason,
    message: string,
    partial?: VncPartialStart,
  ) {
    super(message);
    this.name = "VncStartError";
    this.reason = reason;
    this.partial = partial;
  }
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port ${port}: expected an integer in 1-65535`);
  }
}

export function buildVncArgs(opts: VncArgsOptions): string[] {
  parseDisplayNumber(opts.display);
  assertValidPort(opts.port);
  const args = [
    "-display",
    opts.display,
    "-rfbport",
    String(opts.port),
    "-localhost",
    "-forever",
    "-shared",
    "-nopw",
  ];
  if (opts.viewOnly !== false) {
    args.push("-viewonly");
  }
  args.push("-quiet");
  return args;
}

export function buildVncEnv(
  display: string,
  source: EnvLike = process.env,
  runtime?: DesktopRuntimeLayout,
): EnvLike {
  const env = createIsolatedDesktopEnvironment(
    display,
    source,
    runtime === undefined ? {} : { runtime },
  );
  // x11vnc treats any WAYLAND_DISPLAY value as a Wayland session, including
  // the sentinel used to keep GUI toolkits away from the host compositor.
  delete env.WAYLAND_DISPLAY;
  return env;
}

export function detectVncBinary(env: EnvLike = process.env): string | null {
  return findOnPath("x11vnc", env);
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Give up on a spawned x11vnc: stop its whole process group and report what is
 * known about it, including whether the group is confirmed empty. A server
 * that forked before failing must never be reported as cleaned up, because a
 * failed create's rollback deletes the session runtime on that answer.
 */
async function abandonStartup(
  daemon: OwnedDaemonHandle,
  port: number,
  reason: VncStartFailureReason,
  message: string,
): Promise<VncStartError> {
  const identity = readProcessIdentity(daemon.pid);
  const cleanupConfirmed = await stopOwnedDaemonGroup(daemon);
  return new VncStartError(reason, message, {
    pid: daemon.pid,
    ...(identity === undefined ? {} : { startTimeTicks: identity.startTicks }),
    port,
    logPath: daemon.logPath,
    cleanupConfirmed,
  });
}

export async function startVnc(opts: StartVncOptions): Promise<VncHandle> {
  const port = opts.port ?? VNC_BASE_PORT + parseDisplayNumber(opts.display);
  const args = buildVncArgs({
    display: opts.display,
    port,
    viewOnly: opts.viewOnly,
  });
  const env = buildVncEnv(
    opts.display,
    { ...process.env, ...opts.env },
    opts.runtime,
  );
  const binary = detectVncBinary(env);
  if (binary === null) {
    throw new Error(
      "x11vnc was not found on PATH; install x11vnc to enable VNC",
    );
  }
  if (await isPortListening(port)) {
    throw new Error(
      `VNC endpoint 127.0.0.1:${port} is already in use; refusing to claim ownership`,
    );
  }
  const daemon = await startDaemon(binary, args, {
    logDir: opts.logDir,
    name: "x11vnc",
    env,
    cleanEnv: true,
    owned: true,
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(daemon.pid)) {
      // Even an x11vnc that died can have left a child of its own behind, so
      // this path cleans up the group rather than trusting the dead leader.
      throw await abandonStartup(
        daemon,
        port,
        "exited",
        `x11vnc exited during startup on ${opts.display}; ` +
          `check the log at ${daemon.logPath}`,
      );
    }
    if (await isPortListening(port)) {
      await sleep(STARTUP_POLL_INTERVAL_MS);
      if (!isPidAlive(daemon.pid)) {
        throw await abandonStartup(
          daemon,
          port,
          "exited",
          `x11vnc exited while claiming 127.0.0.1:${port}; ` +
            `check the log at ${daemon.logPath}`,
        );
      }
      if (await isPortListening(port)) {
        const identity = readProcessIdentity(daemon.pid);
        if (identity === undefined) {
          throw await abandonStartup(
            daemon,
            port,
            "identity",
            `Could not verify x11vnc process identity for pid ${daemon.pid}`,
          );
        }
        daemon.release();
        return {
          pid: daemon.pid,
          startTimeTicks: identity.startTicks,
          port,
          logPath: daemon.logPath,
        };
      }
    }
    await sleep(STARTUP_POLL_INTERVAL_MS);
  }

  throw await abandonStartup(
    daemon,
    port,
    "timeout",
    `x11vnc did not start listening on 127.0.0.1:${port} ` +
      `within ${STARTUP_TIMEOUT_MS}ms; check the log at ${daemon.logPath}`,
  );
}
