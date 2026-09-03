import net from "node:net";
import {
  isPidAlive,
  readProcessIdentity,
  startDaemon,
  stopPid,
  type EnvLike,
} from "@pickforge/lab-core";
import { parseDisplayNumber } from "./display.js";
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
}

export interface VncHandle {
  pid: number;
  startTimeTicks: number;
  port: number;
  logPath: string;
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

export async function startVnc(opts: StartVncOptions): Promise<VncHandle> {
  const port = opts.port ?? VNC_BASE_PORT + parseDisplayNumber(opts.display);
  const args = buildVncArgs({
    display: opts.display,
    port,
    viewOnly: opts.viewOnly,
  });
  const binary = detectVncBinary({ ...process.env, ...opts.env });
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
    env: opts.env,
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(daemon.pid)) {
      throw new Error(
        `x11vnc exited during startup on ${opts.display}; ` +
          `check the log at ${daemon.logPath}`,
      );
    }
    if (await isPortListening(port)) {
      await sleep(STARTUP_POLL_INTERVAL_MS);
      if (!isPidAlive(daemon.pid)) {
        throw new Error(
          `x11vnc exited while claiming 127.0.0.1:${port}; ` +
            `check the log at ${daemon.logPath}`,
        );
      }
      if (await isPortListening(port)) {
        const identity = readProcessIdentity(daemon.pid);
        if (identity === undefined) {
          await stopPid(daemon.pid);
          throw new Error(
            `Could not verify x11vnc process identity for pid ${daemon.pid}`,
          );
        }
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

  await stopPid(daemon.pid);
  throw new Error(
    `x11vnc did not start listening on 127.0.0.1:${port} ` +
      `within ${STARTUP_TIMEOUT_MS}ms; check the log at ${daemon.logPath}`,
  );
}
