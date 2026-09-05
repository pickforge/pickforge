import {
  createSession,
  destroySessionRecord,
  getSession,
  isPidAlive,
  reapDeadRunningSessions,
  REAPER_CLEANUP_PENDING_META_KEY,
  sessionDataDir,
  updateSession,
  type AndroidSessionInfo,
  type EnvLike,
  type LocalSessionTeardownFinalizer,
  type SessionRecord,
} from "@pickforge/lab-core";
import { listDevices } from "./adb.js";
import { DEFAULT_AVD_NAME } from "./avd.js";
import { startFailureRecord, type EmulatorBootMode } from "./diagnostics.js";
import { startEmulator, stopEmulator, type EmulatorHandle } from "./emulator.js";

/** Session record `meta` key that keeps the last emulator start diagnostics. */
export const ANDROID_START_FAILURE_META_KEY = "androidStartFailure";

export interface CreateAndroidSessionOptions {
  projectDir: string;
  avdName?: string;
  registryEnv?: EnvLike;
  env?: EnvLike;
  sdk?: string | null;
  headless?: boolean;
  port?: number;
  /** Skip the AVD's saved state (emulator `-no-snapshot-load`). */
  coldBoot?: boolean;
  /** Share the AVD with another running emulator (emulator `-read-only`). */
  readOnly?: boolean;
  bootTimeoutMs?: number;
  bootPollIntervalMs?: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface AndroidSessionHandle {
  id: string;
  avdName: string;
  serial: string;
  consolePort: number;
  emulatorPid: number;
  logPath: string;
  logDir: string;
  bootMode: EmulatorBootMode;
  readOnly: boolean;
}

export interface AndroidSessionStatus {
  record: SessionRecord;
  emulatorAlive: boolean;
  deviceState: string | null;
}

export interface AndroidSessionOpOptions {
  sdk?: string | null;
  env?: EnvLike;
  timeoutMs?: number;
}

export function androidSessionLogDir(
  id: string,
  registryEnv: EnvLike = process.env,
): string {
  return sessionDataDir(id, registryEnv);
}

async function recordStartFailure(
  record: SessionRecord,
  avdName: string,
  emulator: EmulatorHandle | undefined,
  error: unknown,
  opts: CreateAndroidSessionOptions,
  registryEnv: EnvLike,
): Promise<void> {
  let emulatorGone = true;
  if (emulator !== undefined) {
    emulatorGone = await stopEmulator({
      serial: emulator.serial,
      pid: emulator.pid,
      sdk: opts.sdk,
      env: opts.env,
      registryEnv,
    }).catch(() => false);
  }
  const meta: Record<string, unknown> = { ...record.meta };
  delete meta[REAPER_CLEANUP_PENDING_META_KEY];
  const failure = startFailureRecord(error);
  if (failure !== undefined) {
    meta[ANDROID_START_FAILURE_META_KEY] = failure;
  }
  const patch: Partial<SessionRecord> = { status: "error", meta };
  if (!emulatorGone) {
    meta[REAPER_CLEANUP_PENDING_META_KEY] = true;
    patch.android = {
      avdName,
      serial: emulator?.serial,
      emulatorPid: emulator?.pid,
      consolePort: emulator?.consolePort,
    };
  }
  await updateSession(record.id, patch, registryEnv).catch(() => {});
}

export async function createAndroidSession(
  opts: CreateAndroidSessionOptions,
): Promise<AndroidSessionHandle> {
  const registryEnv = opts.registryEnv ?? process.env;
  const avdName = opts.avdName ?? DEFAULT_AVD_NAME;
  const readOnly = opts.readOnly === true;
  await reapDeadRunningSessions(registryEnv, {
    android: {
      teardown: (id, finalize) =>
        teardownAndroidSession(
          id,
          registryEnv,
          { sdk: opts.sdk, env: opts.env },
          finalize,
        ),
    },
  });
  const record = await createSession(
    { type: "android", projectDir: opts.projectDir, android: { avdName } },
    registryEnv,
  );
  const logDir = androidSessionLogDir(record.id, registryEnv);

  let emulator: EmulatorHandle | undefined;
  try {
    emulator = await startEmulator({
      avdName,
      sdk: opts.sdk,
      headless: opts.headless,
      port: opts.port,
      coldBoot: opts.coldBoot,
      readOnly,
      logDir,
      env: opts.env,
      registryEnv,
      bootTimeoutMs: opts.bootTimeoutMs,
      bootPollIntervalMs: opts.bootPollIntervalMs,
      onProgress: opts.onProgress,
      signal: opts.signal,
    });

    const android: AndroidSessionInfo = {
      avdName,
      serial: emulator.serial,
      emulatorPid: emulator.pid,
      consolePort: emulator.consolePort,
      bootMode: emulator.bootMode,
      readOnly,
    };
    await updateSession(record.id, { status: "running", android }, registryEnv);

    return {
      id: record.id,
      avdName,
      serial: emulator.serial,
      consolePort: emulator.consolePort,
      emulatorPid: emulator.pid,
      logPath: emulator.logPath,
      logDir,
      bootMode: emulator.bootMode,
      readOnly,
    };
  } catch (error) {
    await recordStartFailure(record, avdName, emulator, error, opts, registryEnv);
    throw error;
  }
}

export async function teardownAndroidSession(
  id: string,
  registryEnv: EnvLike,
  opts: AndroidSessionOpOptions,
  finalize: LocalSessionTeardownFinalizer,
): Promise<void> {
  const record = await getSession(id, registryEnv);
  if (record === undefined) {
    throw new Error(`Android session not found: ${id}`);
  }
  const android = record.android;
  if (android?.emulatorPid !== undefined || android?.serial !== undefined) {
    let stopped: boolean;
    let failure: Error | undefined;
    try {
      stopped = await stopEmulator({
        serial: android.serial,
        pid: android.emulatorPid,
        sdk: opts.sdk,
        env: opts.env,
        registryEnv,
        timeoutMs: opts.timeoutMs,
      });
    } catch (error) {
      stopped = false;
      failure = error instanceof Error ? error : new Error(String(error));
    }
    if (!stopped) {
      await updateSession(
        id,
        {
          status: "error",
          meta: {
            ...record.meta,
            [REAPER_CLEANUP_PENDING_META_KEY]: true,
          },
        },
        registryEnv,
      ).catch(() => {});
      throw new Error(
        `Failed to stop emulator of android session ${id} ` +
          `(serial ${android.serial ?? "unknown"}, pid ${android.emulatorPid ?? "unknown"})` +
          (failure !== undefined ? `: ${failure.message}` : ""),
      );
    }
  }
  await finalize();
}

export async function destroyAndroidSession(
  id: string,
  registryEnv: EnvLike = process.env,
  opts: AndroidSessionOpOptions = {},
): Promise<void> {
  await teardownAndroidSession(id, registryEnv, opts, () =>
    destroySessionRecord(id, registryEnv),
  );
}

export async function getAndroidSessionStatus(
  id: string,
  registryEnv: EnvLike = process.env,
  opts: AndroidSessionOpOptions = {},
): Promise<AndroidSessionStatus> {
  const record = await getSession(id, registryEnv);
  if (record === undefined) {
    throw new Error(`Android session not found: ${id}`);
  }
  const android = record.android;
  const emulatorAlive =
    android?.emulatorPid !== undefined && isPidAlive(android.emulatorPid);

  let deviceState: string | null = null;
  if (android?.serial !== undefined) {
    try {
      const devices = await listDevices(opts);
      deviceState =
        devices.find((device) => device.serial === android.serial)?.state ??
        null;
    } catch {
      deviceState = null;
    }
  }

  return { record, emulatorAlive, deviceState };
}
