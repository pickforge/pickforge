import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  isPidAlive,
  pickforgeHome,
  runCommand,
  startDaemon,
  stopPid,
  type EnvLike,
} from "@pickforge/lab-core";
import {
  assertSerial,
  listDevices,
  parseAdbDevices,
  resolveAdb,
  type AdbDevice,
} from "./adb.js";
import {
  assertAvdName,
  avdExists,
  avdHomeDir,
  avdIniPath,
  avdLockPath,
  avdToolEnv,
  DEFAULT_AVD_NAME,
  readAvdLockOwner,
  scanAvdHome,
} from "./avd.js";
import {
  AVD_SHARING_POLICY,
  classifyEmulatorLog,
  describeDeviceState,
  detectBootMode,
  DEVICE_STATE_UNKNOWN,
  deviceStateHint,
  EmulatorStartError,
  isEmulatorStartError,
  readLogTail,
  type EmulatorBootMode,
  type EmulatorFailureKind,
  type EmulatorStartDiagnostics,
} from "./diagnostics.js";
import { findSdkTool, resolveSdkRoot } from "./sdk.js";
import { sleep } from "./util.js";

export const MIN_CONSOLE_PORT = 5554;
export const AUTO_MIN_CONSOLE_PORT = 5556;
export const MAX_CONSOLE_PORT = 5682;
/** Extra start attempts on fresh ports after a diagnosed port collision. */
export const MAX_PORT_COLLISION_RETRIES = 2;

const DEFAULT_BOOT_TIMEOUT_MS = 180_000;
const DEFAULT_BOOT_POLL_INTERVAL_MS = 2_000;
const GETPROP_TIMEOUT_MS = 10_000;
/** Bound on the `adb devices` probe that names the device state after a timeout. */
const DEVICE_STATE_TIMEOUT_MS = 3_000;
/**
 * Grace period after `adb emu kill` before signalling the process. A graceful
 * exit saves the quickboot snapshot, which can take well over ten seconds on
 * a cold-booted AVD; interrupting it corrupts the saved state.
 */
const EMU_KILL_TIMEOUT_MS = 30_000;
const EMU_KILL_POLL_INTERVAL_MS = 200;
const BOOT_MODE_SCAN_LINES = 400;

export interface EmulatorArgsOptions {
  avdName: string;
  headless?: boolean;
  port?: number;
  /** Skip the AVD's saved state (`-no-snapshot-load`). */
  coldBoot?: boolean;
  /** Share the AVD with another running emulator (`-read-only`). */
  readOnly?: boolean;
}

export interface StartEmulatorOptions {
  avdName?: string;
  sdk?: string | null;
  headless?: boolean;
  port?: number;
  coldBoot?: boolean;
  readOnly?: boolean;
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
  bootMode: EmulatorBootMode;
}

export interface WaitForBootOptions {
  serial: string;
  adbPath: string;
  env?: EnvLike;
  timeoutMs?: number;
  pollIntervalMs?: number;
  isEmulatorAlive?: () => boolean;
  logPath?: string;
  avdName?: string;
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

export function consolePortFromSerial(serial: string): number | undefined {
  const match = /^emulator-(\d+)$/.exec(serial);
  return match === null ? undefined : Number(match[1]);
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
  if (opts.coldBoot === true) {
    args.push("-no-snapshot-load");
  }
  if (opts.readOnly === true) {
    args.push("-read-only");
  }
  return args;
}

export function pickConsolePort(usedSerials: readonly string[]): number {
  const used = new Set<number>();
  for (const serial of usedSerials) {
    const port = consolePortFromSerial(serial);
    if (port !== undefined) {
      used.add(port);
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

/** True when nothing listens on the loopback TCP port. */
export function isTcpPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** An emulator needs its console port and the adb port right above it. */
export async function isConsolePortPairFree(port: number): Promise<boolean> {
  return (await isTcpPortFree(port)) && (await isTcpPortFree(port + 1));
}

function bootDiagnostics(
  opts: WaitForBootOptions,
  kind: EmulatorFailureKind,
  extra: Partial<EmulatorStartDiagnostics> = {},
): EmulatorStartDiagnostics {
  const diagnostics: EmulatorStartDiagnostics = {
    kind,
    avdName: opts.avdName ?? "unknown",
    serial: opts.serial,
    consolePort: consolePortFromSerial(opts.serial),
    logTail: extra.logTail ?? readLogTail(opts.logPath),
  };
  if (opts.logPath !== undefined) diagnostics.logPath = opts.logPath;
  if (extra.deviceState !== undefined) {
    diagnostics.deviceState = extra.deviceState;
  }
  if (extra.hint !== undefined) diagnostics.hint = extra.hint;
  return diagnostics;
}

function exitedBeforeBoot(opts: WaitForBootOptions): EmulatorStartError {
  const logTail = readLogTail(opts.logPath);
  const { kind, hint } = classifyEmulatorLog(logTail);
  return new EmulatorStartError(
    `Emulator for ${opts.serial} exited before finishing boot`,
    bootDiagnostics(opts, kind, { logTail, hint }),
  );
}

function assertStillStarting(opts: WaitForBootOptions): void {
  if (opts.signal?.aborted === true) {
    throw new EmulatorStartError(
      `Aborted while waiting for emulator ${opts.serial} to boot`,
      bootDiagnostics(opts, "aborted"),
    );
  }
  if (opts.isEmulatorAlive !== undefined && !opts.isEmulatorAlive()) {
    throw exitedBeforeBoot(opts);
  }
}

async function queryDeviceState(opts: WaitForBootOptions): Promise<string> {
  const result = await runCommand(opts.adbPath, ["devices"], {
    env: opts.env,
    timeoutMs: DEVICE_STATE_TIMEOUT_MS,
  }).catch(() => null);
  if (result === null || !result.ok) {
    return DEVICE_STATE_UNKNOWN;
  }
  return describeDeviceState(parseAdbDevices(result.stdout), opts.serial);
}

async function bootTimedOut(
  opts: WaitForBootOptions,
  timeoutMs: number,
  probeError?: string,
): Promise<EmulatorStartError> {
  const deviceState = await queryDeviceState(opts);
  let hint = deviceStateHint(deviceState);
  if (probeError !== undefined) {
    const detail = `the last sys.boot_completed probe failed to run: ${probeError}`;
    hint = hint === undefined ? detail : `${hint}; ${detail}`;
  }
  return new EmulatorStartError(
    `Emulator ${opts.serial} did not finish booting within ${timeoutMs}ms`,
    bootDiagnostics(opts, "boot-timeout", { deviceState, hint }),
  );
}

/**
 * One `sys.boot_completed` probe. A probe that cannot even run (adb missing
 * or not executable, spawn failure) counts as "not booted yet" and is
 * remembered in `probe`, so the caller still ends in a typed
 * `EmulatorStartError` with the log path and tail instead of a bare spawn
 * error that loses the diagnosis.
 */
async function bootCompleted(
  opts: WaitForBootOptions,
  remainingMs: number,
  probe: { lastError?: string },
): Promise<boolean> {
  try {
    const result = await runCommand(
      opts.adbPath,
      ["-s", opts.serial, "shell", "getprop", "sys.boot_completed"],
      { env: opts.env, timeoutMs: Math.min(GETPROP_TIMEOUT_MS, remainingMs) },
    );
    return result.ok && result.stdout.trim() === "1";
  } catch (error) {
    probe.lastError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export async function waitForBoot(opts: WaitForBootOptions): Promise<void> {
  assertSerial(opts.serial);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_BOOT_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const probe: { lastError?: string } = {};
  for (;;) {
    assertStillStarting(opts);
    opts.onProgress?.(
      `waiting for emulator ${opts.serial} to boot ` +
        `(${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`,
    );
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw await bootTimedOut(opts, timeoutMs, probe.lastError);
    }
    if (await bootCompleted(opts, remainingMs, probe)) {
      assertStillStarting(opts);
      return;
    }
    if (Date.now() + pollIntervalMs > deadline) {
      throw await bootTimedOut(opts, timeoutMs, probe.lastError);
    }
    await sleep(pollIntervalMs);
  }
}

export function consolePortLockPath(
  port: number,
  registryEnv: EnvLike = process.env,
): string {
  return path.join(pickforgeHome(registryEnv), "ports", `emulator-${port}.lock`);
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

interface AllocateConsolePortOptions {
  sdk?: string | null;
  env?: EnvLike;
  registryEnv?: EnvLike;
  /** Ports that already failed with a collision during this start. */
  exclude?: ReadonlySet<number>;
  onProgress?: (message: string) => void;
}

async function listUsedConsolePorts(
  opts: AllocateConsolePortOptions,
): Promise<Set<number>> {
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
    const port = consolePortFromSerial(device.serial);
    if (port !== undefined) {
      used.add(port);
    }
  }
  return used;
}

/**
 * Pick the first even port that adb does not list, no live Pickforge
 * reservation holds, and nothing else has bound on loopback. The TCP probe
 * covers emulators from other Pickforge homes and foreign processes, which
 * the per-home reservation registry cannot see.
 */
async function allocateConsolePort(
  opts: AllocateConsolePortOptions,
): Promise<number> {
  const used = await listUsedConsolePorts(opts);
  for (const port of opts.exclude ?? []) {
    used.add(port);
  }
  const registryEnv = opts.registryEnv ?? process.env;
  for (let port = AUTO_MIN_CONSOLE_PORT; port <= MAX_CONSOLE_PORT; port += 2) {
    if (used.has(port) || !tryReserveConsolePort(port, registryEnv)) {
      continue;
    }
    if (await isConsolePortPairFree(port)) {
      return port;
    }
    releaseConsolePort(port, registryEnv);
    opts.onProgress?.(
      `console port ${port} is bound by a process outside this Pickforge home; skipping it`,
    );
  }
  throw new Error(
    `No free emulator console port between ${AUTO_MIN_CONSOLE_PORT} and ` +
      `${MAX_CONSOLE_PORT} for automatic allocation`,
  );
}

interface StartContext {
  avdName: string;
  env: EnvLike;
  registryEnv: EnvLike;
  sdk: string | null;
  emulator: string;
  adbPath: string;
}

function isEmulatorProcess(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "latin1");
    return /emulator|qemu/i.test(cmdline);
  } catch {
    // cannot inspect the owner (another user, or no procfs): assume it is real
    return true;
  }
}

/**
 * Fail before spawning when the emulator is certain to: the AVD is not where
 * the emulator will look, or another emulator holds its writable state.
 */
function assertAvdStartable(
  avdName: string,
  env: EnvLike,
  readOnly: boolean,
): void {
  if (!avdExists(avdName, env)) {
    const available = scanAvdHome(env);
    throw new EmulatorStartError(
      `AVD "${avdName}" not found: ${avdIniPath(avdName, env)} does not exist`,
      {
        kind: "avd-missing",
        avdName,
        logTail: [],
        hint:
          `available AVDs in ${avdHomeDir(env)}: ` +
          `${available.length === 0 ? "none" : available.join(", ")}; ` +
          'create one with "pickforge-lab setup android --create-avd" or pass --avd-name',
      },
    );
  }
  // The lock is held only by a writable instance; read-only instances hold no
  // lock. Pickforge's policy (AVD_SHARING_POLICY) refuses any start, writable
  // or read-only, while a writable instance holds the AVD, whatever the
  // emulator itself would admit.
  const owner = readAvdLockOwner(avdName, env);
  if (owner !== null && isPidAlive(owner) && isEmulatorProcess(owner)) {
    throw new EmulatorStartError(
      `AVD "${avdName}" is already in use by writable emulator pid ${owner}`,
      {
        kind: "avd-in-use",
        avdName,
        logTail: [],
        hint:
          `lock ${avdLockPath(avdName, env)}; ${AVD_SHARING_POLICY}, ` +
          "so stop that emulator" +
          (readOnly ? "" : " or start every session on this AVD with --read-only") +
          ", or use a different AVD",
      },
    );
  }
}

function prepareStart(opts: StartEmulatorOptions): StartContext {
  const avdName = opts.avdName ?? DEFAULT_AVD_NAME;
  assertAvdName(avdName);
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
  assertAvdStartable(avdName, env, opts.readOnly === true);
  return { avdName, env, registryEnv, sdk, emulator, adbPath };
}

async function acquireConsolePort(
  ctx: StartContext,
  opts: StartEmulatorOptions,
  exclude: ReadonlySet<number>,
): Promise<number> {
  if (opts.port === undefined) {
    return allocateConsolePort({
      sdk: ctx.sdk,
      env: opts.env,
      registryEnv: ctx.registryEnv,
      exclude,
      onProgress: opts.onProgress,
    });
  }
  assertConsolePort(opts.port);
  if (!tryReserveConsolePort(opts.port, ctx.registryEnv)) {
    throw new Error(
      `Console port ${opts.port} is already reserved by another ` +
        `Pickforge emulator (${consolePortLockPath(opts.port, ctx.registryEnv)})`,
    );
  }
  if (await isConsolePortPairFree(opts.port)) {
    return opts.port;
  }
  releaseConsolePort(opts.port, ctx.registryEnv);
  throw new EmulatorStartError(
    `Console port ${opts.port} or adb port ${opts.port + 1} is bound by another process`,
    {
      kind: "port-collision",
      avdName: ctx.avdName,
      serial: emulatorSerial(opts.port),
      consolePort: opts.port,
      logTail: [],
      hint: "stop the process holding the port, or omit --port to allocate a free pair",
    },
  );
}

function describeStart(opts: StartEmulatorOptions, serial: string): string {
  const modes = [
    ...(opts.coldBoot === true ? ["cold boot"] : []),
    ...(opts.readOnly === true ? ["read-only"] : []),
  ];
  return modes.length === 0 ? serial : `${serial}, ${modes.join(", ")}`;
}

async function launchOnPort(
  ctx: StartContext,
  opts: StartEmulatorOptions,
  port: number,
): Promise<EmulatorHandle> {
  const args = buildEmulatorArgs({
    avdName: ctx.avdName,
    headless: opts.headless,
    port,
    coldBoot: opts.coldBoot,
    readOnly: opts.readOnly,
  });
  const serial = emulatorSerial(port);
  if (opts.signal?.aborted === true) {
    throw new EmulatorStartError(
      `Aborted before starting the emulator for AVD ${ctx.avdName}`,
      { kind: "aborted", avdName: ctx.avdName, serial, consolePort: port, logTail: [] },
    );
  }
  opts.onProgress?.(
    `starting emulator for AVD ${ctx.avdName} (${describeStart(opts, serial)})`,
  );
  const sdkEnv: EnvLike =
    ctx.sdk !== null ? { ANDROID_HOME: ctx.sdk, ANDROID_SDK_ROOT: ctx.sdk } : {};
  const daemon = await startDaemon(ctx.emulator, args, {
    logDir: opts.logDir,
    name: "emulator",
    env: { ...sdkEnv, ...avdToolEnv(ctx.env), ...opts.env },
  });
  claimConsolePort(port, daemon.pid, ctx.registryEnv);

  try {
    await waitForBoot({
      serial,
      adbPath: ctx.adbPath,
      env: opts.env,
      timeoutMs: opts.bootTimeoutMs,
      pollIntervalMs: opts.bootPollIntervalMs,
      isEmulatorAlive: () => isPidAlive(daemon.pid),
      logPath: daemon.logPath,
      avdName: ctx.avdName,
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
    bootMode: detectBootMode(
      readLogTail(daemon.logPath, BOOT_MODE_SCAN_LINES),
      opts.coldBoot === true,
    ),
  };
}

function isRetryablePortCollision(
  error: unknown,
  opts: StartEmulatorOptions,
  retries: number,
): boolean {
  return (
    opts.port === undefined &&
    isEmulatorStartError(error) &&
    error.kind === "port-collision" &&
    retries < MAX_PORT_COLLISION_RETRIES
  );
}

export async function startEmulator(
  opts: StartEmulatorOptions,
): Promise<EmulatorHandle> {
  const ctx = prepareStart(opts);
  const collided = new Set<number>();
  let retries = 0;
  for (;;) {
    const port = await acquireConsolePort(ctx, opts, collided);
    try {
      return await launchOnPort(ctx, opts, port);
    } catch (error) {
      releaseConsolePort(port, ctx.registryEnv);
      if (!isRetryablePortCollision(error, opts, retries)) {
        throw error;
      }
      collided.add(port);
      retries += 1;
      opts.onProgress?.(
        `console port ${port} was taken by another process after allocation; ` +
          `retrying on a new port (${retries}/${MAX_PORT_COLLISION_RETRIES})`,
      );
    }
  }
}

export async function stopEmulator(
  opts: StopEmulatorOptions,
): Promise<boolean> {
  const stopped = await stopEmulatorProcess(opts);
  if (stopped && opts.serial !== undefined) {
    const port = consolePortFromSerial(opts.serial);
    if (port !== undefined) {
      releaseConsolePort(port, opts.registryEnv ?? process.env);
    }
  }
  return stopped;
}

async function sendEmuKill(
  opts: StopEmulatorOptions,
  adbPath: string | null,
): Promise<boolean> {
  if (opts.serial === undefined || adbPath === null) {
    return false;
  }
  assertSerial(opts.serial);
  const killResult = await runCommand(
    adbPath,
    ["-s", opts.serial, "emu", "kill"],
    { env: opts.env, timeoutMs: 5_000 },
  ).catch(() => null);
  return killResult !== null && killResult.ok;
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await sleep(EMU_KILL_POLL_INTERVAL_MS);
  }
}

async function waitForDeviceGone(
  opts: StopEmulatorOptions,
  timeoutMs: number,
): Promise<boolean> {
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

  const sentEmuKill = await sendEmuKill(opts, adbPath);

  if (opts.pid !== undefined) {
    if (sentEmuKill) {
      await waitForPidExit(opts.pid, timeoutMs);
    }
    return isPidAlive(opts.pid) ? stopPid(opts.pid) : true;
  }

  if (opts.serial !== undefined && adbPath !== null) {
    return waitForDeviceGone(opts, timeoutMs);
  }

  return true;
}
