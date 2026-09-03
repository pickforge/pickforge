import fs from "node:fs";
import path from "node:path";
import {
  isPidAlive,
  picklabHome,
  runCommand,
  startDaemon,
  stopPid,
  type EnvLike,
} from "@pickforge/lab-core";
import {
  assertSerial,
  listDevices,
  resolveAdb,
  type AdbDevice,
} from "./adb.js";
import { assertAvdName, DEFAULT_AVD_NAME } from "./avd.js";
import { findSdkTool, resolveSdkRoot } from "./sdk.js";
import { sleep } from "./util.js";

export const MIN_CONSOLE_PORT = 5554;
export const AUTO_MIN_CONSOLE_PORT = 5556;
export const MAX_CONSOLE_PORT = 5682;

const DEFAULT_BOOT_TIMEOUT_MS = 180_000;
const DEFAULT_BOOT_POLL_INTERVAL_MS = 2_000;
const GETPROP_TIMEOUT_MS = 10_000;
const EMU_KILL_TIMEOUT_MS = 10_000;
const EMU_KILL_POLL_INTERVAL_MS = 200;

export interface EmulatorArgsOptions {
  avdName: string;
  headless?: boolean;
  port?: number;
}

export interface StartEmulatorOptions {
  avdName?: string;
  sdk?: string | null;
  headless?: boolean;
  port?: number;
  logDir: string;
  env?: EnvLike;
  registryEnv?: EnvLike;
  bootTimeoutMs?: number;
  bootPollIntervalMs?: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface EmulatorHandle {
  pid: number;
  serial: string;
  consolePort: number;
  logPath: string;
}

export interface WaitForBootOptions {
  serial: string;
  adbPath: string;
  env?: EnvLike;
  timeoutMs?: number;
  pollIntervalMs?: number;
  isEmulatorAlive?: () => boolean;
  logPath?: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface StopEmulatorOptions {
  serial?: string;
  pid?: number;
  sdk?: string | null;
  env?: EnvLike;
  registryEnv?: EnvLike;
  timeoutMs?: number;
}

export function assertConsolePort(port: number): void {
  if (
    !Number.isInteger(port) ||
    port < MIN_CONSOLE_PORT ||
    port > MAX_CONSOLE_PORT ||
    port % 2 !== 0
  ) {
    throw new Error(
      `Invalid console port ${port}: expected an even integer between ` +
        `${MIN_CONSOLE_PORT} and ${MAX_CONSOLE_PORT}`,
    );
  }
}

export function emulatorSerial(consolePort: number): string {
  assertConsolePort(consolePort);
  return `emulator-${consolePort}`;
}

export function buildEmulatorArgs(opts: EmulatorArgsOptions): string[] {
  assertAvdName(opts.avdName);
  const port = opts.port ?? MIN_CONSOLE_PORT;
  assertConsolePort(port);
  const args = ["-avd", opts.avdName];
  if (opts.headless !== false) {
    args.push("-no-window");
  }
  args.push("-no-audio", "-no-boot-anim", "-port", String(port));
  return args;
}

export function pickConsolePort(usedSerials: readonly string[]): number {
  const used = new Set<number>();
  for (const serial of usedSerials) {
    const match = /^emulator-(\d+)$/.exec(serial);
    if (match !== null) {
      used.add(Number(match[1]));
    }
  }
  for (let port = AUTO_MIN_CONSOLE_PORT; port <= MAX_CONSOLE_PORT; port += 2) {
    if (!used.has(port)) {
      return port;
    }
  }
  throw new Error(
    `No free emulator console port between ${AUTO_MIN_CONSOLE_PORT} and ` +
      `${MAX_CONSOLE_PORT} for automatic allocation`,
  );
}

// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export async function waitForBoot(opts: WaitForBootOptions): Promise<void> {
  assertSerial(opts.serial);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_BOOT_POLL_INTERVAL_MS;
  const logHint =
    opts.logPath !== undefined ? `; check the log at ${opts.logPath}` : "";
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    if (opts.signal?.aborted === true) {
      throw new Error(
        `Aborted while waiting for emulator ${opts.serial} to boot${logHint}`,
      );
    }
    if (opts.isEmulatorAlive !== undefined && !opts.isEmulatorAlive()) {
      throw new Error(
        `Emulator for ${opts.serial} exited before finishing boot${logHint}`,
      );
    }
    opts.onProgress?.(
      `waiting for emulator ${opts.serial} to boot ` +
        `(${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`,
    );
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Emulator ${opts.serial} did not finish booting within ${timeoutMs}ms${logHint}`,
      );
    }
    const result = await runCommand(
      opts.adbPath,
      ["-s", opts.serial, "shell", "getprop", "sys.boot_completed"],
      { env: opts.env, timeoutMs: Math.min(GETPROP_TIMEOUT_MS, remainingMs) },
    );
    if (result.ok && result.stdout.trim() === "1") {
      if (opts.isEmulatorAlive !== undefined && !opts.isEmulatorAlive()) {
        throw new Error(
          `Emulator for ${opts.serial} exited before finishing boot${logHint}`,
        );
      }
      return;
    }
    if (Date.now() + pollIntervalMs > deadline) {
      throw new Error(
        `Emulator ${opts.serial} did not finish booting within ${timeoutMs}ms${logHint}`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

export function consolePortLockPath(
  port: number,
  registryEnv: EnvLike = process.env,
): string {
  return path.join(picklabHome(registryEnv), "ports", `emulator-${port}.lock`);
}

function readLockOwnerPid(lockPath: string): number | null {
  try {
    const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function tryReserveConsolePort(
  port: number,
  registryEnv: EnvLike = process.env,
  ownerPid: number = process.pid,
): boolean {
  assertConsolePort(port);
  const lockPath = consolePortLockPath(port, registryEnv);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, `${ownerPid}\n`, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = readLockOwnerPid(lockPath);
      if (owner !== null && isPidAlive(owner)) {
        return false;
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  return false;
}

export function releaseConsolePort(
  port: number,
  registryEnv: EnvLike = process.env,
): void {
  try {
    fs.rmSync(consolePortLockPath(port, registryEnv), { force: true });
  } catch {
    // releasing a reservation must never mask the original failure
  }
}

function claimConsolePort(
  port: number,
  ownerPid: number,
  registryEnv: EnvLike,
): void {
  try {
    fs.writeFileSync(consolePortLockPath(port, registryEnv), `${ownerPid}\n`);
  } catch {
    // the wx reservation already exists; ownership transfer is best-effort
  }
}

async function allocateConsolePort(opts: {
  sdk?: string | null;
  env?: EnvLike;
  registryEnv?: EnvLike;
}): Promise<number> {
  let devices: AdbDevice[];
  try {
    devices = await listDevices(opts);
  } catch (error) {
    throw new Error(
      "Failed to list adb devices while allocating an emulator console port",
      { cause: error },
    );
  }
  const used = new Set<number>();
  for (const device of devices) {
    const match = /^emulator-(\d+)$/.exec(device.serial);
    if (match !== null) {
      used.add(Number(match[1]));
    }
  }
  const registryEnv = opts.registryEnv ?? process.env;
  for (let port = AUTO_MIN_CONSOLE_PORT; port <= MAX_CONSOLE_PORT; port += 2) {
    if (used.has(port)) {
      continue;
    }
    if (tryReserveConsolePort(port, registryEnv)) {
      return port;
    }
  }
  throw new Error(
    `No free emulator console port between ${AUTO_MIN_CONSOLE_PORT} and ` +
      `${MAX_CONSOLE_PORT} for automatic allocation`,
  );
}

export async function startEmulator(
  opts: StartEmulatorOptions,
): Promise<EmulatorHandle> {
  const avdName = opts.avdName ?? DEFAULT_AVD_NAME;
  const env = opts.env ?? process.env;
  const registryEnv = opts.registryEnv ?? process.env;
  const sdk = resolveSdkRoot(opts.sdk, env);
  const emulator = findSdkTool(sdk, "emulator", env);
  if (emulator === null) {
    throw new Error(
      "Android emulator binary not found (<sdk>/emulator/emulator or PATH); " +
        'install it with: sdkmanager "emulator", or set ANDROID_HOME',
    );
  }
  const adbPath = resolveAdb({ sdk, env: opts.env });

  let port: number;
  if (opts.port !== undefined) {
    assertConsolePort(opts.port);
    if (!tryReserveConsolePort(opts.port, registryEnv)) {
      throw new Error(
        `Console port ${opts.port} is already reserved by another ` +
          `PickLab emulator (${consolePortLockPath(opts.port, registryEnv)})`,
      );
    }
    port = opts.port;
  } else {
    port = await allocateConsolePort({ sdk, env: opts.env, registryEnv });
  }

  try {
    const args = buildEmulatorArgs({
      avdName,
      headless: opts.headless,
      port,
    });
    const serial = emulatorSerial(port);

    const sdkEnv: EnvLike =
      sdk !== null ? { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } : {};
    if (opts.signal?.aborted === true) {
      throw new Error(
        `Aborted before starting the emulator for AVD ${avdName}`,
      );
    }
    opts.onProgress?.(`starting emulator for AVD ${avdName} (${serial})`);
    const daemon = await startDaemon(emulator, args, {
      logDir: opts.logDir,
      name: "emulator",
      env: { ...sdkEnv, ...opts.env },
    });
    claimConsolePort(port, daemon.pid, registryEnv);

    try {
      await waitForBoot({
        serial,
        adbPath,
        env: opts.env,
        timeoutMs: opts.bootTimeoutMs,
        pollIntervalMs: opts.bootPollIntervalMs,
        isEmulatorAlive: () => isPidAlive(daemon.pid),
        logPath: daemon.logPath,
        onProgress: opts.onProgress,
        signal: opts.signal,
      });
    } catch (error) {
      await stopPid(daemon.pid).catch(() => {});
      throw error;
    }

    return {
      pid: daemon.pid,
      serial,
      consolePort: port,
      logPath: daemon.logPath,
    };
  } catch (error) {
    releaseConsolePort(port, registryEnv);
    throw error;
  }
}

export async function stopEmulator(
  opts: StopEmulatorOptions,
): Promise<boolean> {
  const stopped = await stopEmulatorProcess(opts);
  if (stopped && opts.serial !== undefined) {
    const match = /^emulator-(\d+)$/.exec(opts.serial);
    if (match !== null) {
      releaseConsolePort(Number(match[1]), opts.registryEnv ?? process.env);
    }
  }
  return stopped;
}

// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
async function stopEmulatorProcess(
  opts: StopEmulatorOptions,
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? EMU_KILL_TIMEOUT_MS;
  if (opts.pid !== undefined && !isPidAlive(opts.pid)) {
    return true;
  }
  let adbPath: string | null = null;
  try {
    adbPath = resolveAdb(opts);
  } catch {
    adbPath = null;
  }

  let sentEmuKill = false;
  if (opts.serial !== undefined && adbPath !== null) {
    assertSerial(opts.serial);
    const killResult = await runCommand(
      adbPath,
      ["-s", opts.serial, "emu", "kill"],
      { env: opts.env, timeoutMs: 5_000 },
    ).catch(() => null);
    sentEmuKill = killResult !== null && killResult.ok;
  }

  if (opts.pid !== undefined) {
    if (sentEmuKill) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && isPidAlive(opts.pid)) {
        await sleep(EMU_KILL_POLL_INTERVAL_MS);
      }
    }
    if (isPidAlive(opts.pid)) {
      return stopPid(opts.pid);
    }
    return true;
  }

  if (opts.serial !== undefined && adbPath !== null) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const devices = await listDevices(opts);
        if (!devices.some((device) => device.serial === opts.serial)) {
          return true;
        }
      } catch {
        return false;
      }
      await sleep(EMU_KILL_POLL_INTERVAL_MS);
    }
    return false;
  }

  return true;
}
