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
import { startEmulator, stopEmulator, type EmulatorHandle } from "./emulator.js";

export interface CreateAndroidSessionOptions {
  projectDir: string;
  avdName?: string;
  registryEnv?: EnvLike;
  env?: EnvLike;
  sdk?: string | null;
  headless?: boolean;
  port?: number;
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

export async function createAndroidSession(
  opts: CreateAndroidSessionOptions,
): Promise<AndroidSessionHandle> {
  const registryEnv = opts.registryEnv ?? process.env;
  const avdName = opts.avdName ?? DEFAULT_AVD_NAME;
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
    };
  } catch (error) {
    let emulatorGone = true;
    if (emulator !== undefined) {
      try {
        emulatorGone = await stopEmulator({
          serial: emulator.serial,
          pid: emulator.pid,
          sdk: opts.sdk,
          env: opts.env,
          registryEnv,
        });
      } catch {
        emulatorGone = false;
      }
    }
    const clearedMeta = { ...record.meta };
    delete clearedMeta[REAPER_CLEANUP_PENDING_META_KEY];
    await updateSession(
      record.id,
      emulatorGone
        ? { status: "error", meta: clearedMeta }
        : {
            status: "error",
            meta: {
              ...record.meta,
              [REAPER_CLEANUP_PENDING_META_KEY]: true,
            },
            android: {
              avdName,
              serial: emulator?.serial,
              emulatorPid: emulator?.pid,
              consolePort: emulator?.consolePort,
            },
          },
      registryEnv,
    ).catch(() => {});
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
