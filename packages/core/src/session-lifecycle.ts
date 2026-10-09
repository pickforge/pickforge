import { isSessionInputClosed, markSessionCleanupPendingIfInputClosed } from "./takeover.js";
import type { EnvLike } from "./paths.js";
import {
  REAPER_CLEANUP_PENDING_META_KEY,
  destroySessionRecord,
  desktopHomePolicy,
  isSessionProcessAlive,
  listSessions,
  type SessionLivenessCheck,
  type SessionRecord,
  type SessionType,
} from "./session.js";

const REAPER_TEARDOWN_TIMEOUT_MS = 5_000;

export type LocalSessionRecipe = SessionType;

export interface LocalSessionLifecycle {
  signal?: AbortSignal;
}

export interface DesktopLegHandle {
  id: string;
  display: string;
  logDir: string;
  vncPort?: number;
  vncViewOnly?: boolean;
}

export interface AndroidLegHandle {
  id: string;
  avdName: string;
  serial: string;
  consolePort: number;
  logDir: string;
  bootMode?: "warm" | "cold" | "unknown";
  readOnly?: boolean;
}

export interface BrowserLegHandle {
  id: string;
  display: string;
  cdpPort: number;
  profileDir: string;
  binaryPath: string;
  logDir: string;
}

export type LocalSessionSummary =
  | ({ type: "desktop" } & DesktopLegHandle)
  | ({ type: "android" } & AndroidLegHandle)
  | ({ type: "browser" } & BrowserLegHandle);

export interface DesktopLiveStatus {
  xvfbAlive: boolean;
  vncAlive: boolean;
  displayAlive: boolean;
}

export interface AndroidLiveStatus {
  emulatorAlive: boolean;
  deviceState: string | null;
}

export interface BrowserLiveStatus {
  alive: boolean;
  xvfbAlive: boolean;
  displayAlive: boolean;
  browserAlive: boolean;
}

export interface LocalSessionCreateRuntime {
  desktop: {
    create: () => Promise<DesktopLegHandle>;
    destroy: (id: string) => Promise<void>;
  };
  android: {
    create: () => Promise<AndroidLegHandle>;
  };
  browser: {
    create: () => Promise<BrowserLegHandle>;
  };
}

export interface LocalSessionStatusRuntime {
  desktop: {
    status: (id: string) => Promise<DesktopLiveStatus>;
  };
  android: {
    status: (id: string) => Promise<AndroidLiveStatus>;
  };
  browser: {
    status: (id: string) => Promise<BrowserLiveStatus>;
  };
}

export interface LocalSessionDestroyOptions {
  signal?: AbortSignal;
}

export interface LocalSessionDestroyRuntime {
  desktop: {
    destroy: (id: string, options?: LocalSessionDestroyOptions) => Promise<void>;
  };
  android: {
    destroy: (id: string, options?: LocalSessionDestroyOptions) => Promise<void>;
  };
  browser: {
    destroy: (id: string, options?: LocalSessionDestroyOptions) => Promise<void>;
  };
}

export type LocalSessionTeardownFinalizer = () => Promise<void>;

export interface LocalSessionTeardownOptions extends LocalSessionDestroyOptions {
  inputDrainTimeoutMs?: number;
}

export interface LocalSessionTeardownRuntime {
  desktop?: {
    teardown: (
      id: string,
      finalize: LocalSessionTeardownFinalizer,
      options?: LocalSessionTeardownOptions,
    ) => Promise<void>;
  };
  android?: {
    teardown: (
      id: string,
      finalize: LocalSessionTeardownFinalizer,
      options?: LocalSessionTeardownOptions,
    ) => Promise<void>;
  };
  browser?: {
    teardown: (
      id: string,
      finalize: LocalSessionTeardownFinalizer,
      options?: LocalSessionTeardownOptions,
    ) => Promise<void>;
  };
}

export interface LocalSessionStatusEntry extends Record<string, unknown> {
  id: string;
  type: SessionType;
  status: string;
  createdAt: string;
  projectDir: string;
  desktop?: Record<string, unknown>;
  android?: Record<string, unknown>;
  browser?: Record<string, unknown>;
  viewer?: Record<string, unknown>;
}

export interface DestroyLocalSessionsResult {
  destroyed: string[];
  errors: string[];
}

export interface DestroyLocalSessionsOptions {
  env?: EnvLike;
  aroundDestroy?: (
    record: SessionRecord,
    destroy: () => Promise<void>,
  ) => Promise<void>;
  /**
   * Cancels lock and permit waits. Once process cleanup starts, it finishes.
   * Later sessions are reported as cancelled.
   */
  signal?: AbortSignal;
}

function assertRecipe(recipe: LocalSessionRecipe): void {
  if (
    recipe !== "desktop" &&
    recipe !== "android" &&
    recipe !== "desktop+android" &&
    recipe !== "browser"
  ) {
    throw new Error(`Unsupported local session recipe: ${String(recipe)}`);
  }
}

function assertNotAborted(
  signal: AbortSignal | undefined,
  recipe?: LocalSessionRecipe,
): void {
  if (signal?.aborted === true) {
    throw new Error(
      recipe === "browser"
        ? "Browser session creation aborted by the client"
        : "Session creation aborted by the client",
    );
  }
}

function desktopSummary(handle: DesktopLegHandle): LocalSessionSummary {
  const summary: LocalSessionSummary = {
    id: handle.id,
    type: "desktop",
    display: handle.display,
    logDir: handle.logDir,
  };
  if (handle.vncPort !== undefined) {
    summary.vncPort = handle.vncPort;
    summary.vncViewOnly = handle.vncViewOnly;
  }
  return summary;
}

function androidSummary(handle: AndroidLegHandle): LocalSessionSummary {
  const summary: LocalSessionSummary = {
    id: handle.id,
    type: "android",
    avdName: handle.avdName,
    serial: handle.serial,
    consolePort: handle.consolePort,
    logDir: handle.logDir,
  };
  if (handle.bootMode !== undefined) summary.bootMode = handle.bootMode;
  if (handle.readOnly !== undefined) summary.readOnly = handle.readOnly;
  return summary;
}

function browserSummary(handle: BrowserLegHandle): LocalSessionSummary {
  return {
    id: handle.id,
    type: "browser",
    display: handle.display,
    cdpPort: handle.cdpPort,
    profileDir: handle.profileDir,
    binaryPath: handle.binaryPath,
    logDir: handle.logDir,
  };
}

export async function createLocalSessions(
  recipe: LocalSessionRecipe,
  runtime: LocalSessionCreateRuntime,
  lifecycle: LocalSessionLifecycle = {},
): Promise<LocalSessionSummary[]> {
  assertRecipe(recipe);
  assertNotAborted(lifecycle.signal, recipe);

  const sessions: LocalSessionSummary[] = [];
  if (recipe === "desktop" || recipe === "desktop+android") {
    sessions.push(desktopSummary(await runtime.desktop.create()));
  }
  if (recipe === "browser") {
    sessions.push(browserSummary(await runtime.browser.create()));
  }
  if (recipe === "android" || recipe === "desktop+android") {
    try {
      assertNotAborted(lifecycle.signal);
      sessions.push(androidSummary(await runtime.android.create()));
    } catch (error) {
      const desktop = sessions.find((session) => session.type === "desktop");
      if (desktop !== undefined) {
        await runtime.desktop.destroy(desktop.id).catch(() => {});
      }
      throw error;
    }
  }
  return sessions;
}

export async function localSessionStatusEntry(
  record: SessionRecord,
  runtime: LocalSessionStatusRuntime,
): Promise<LocalSessionStatusEntry> {
  const entry: LocalSessionStatusEntry = {
    id: record.id,
    type: record.type,
    status: record.status,
    createdAt: record.createdAt,
    projectDir: record.projectDir,
  };
  if (record.type === "browser") {
    const browserStatus = await runtime.browser.status(record.id);
    const desktopStatus = await runtime.desktop.status(record.id);
    if (record.status === "running" && !browserStatus.alive) {
      entry.status = "dead";
    }
    entry.desktop = {
      ...record.desktop,
      xvfbAlive: browserStatus.xvfbAlive,
      vncAlive: desktopStatus.vncAlive,
      displayAlive: browserStatus.displayAlive,
    };
    entry.browser = {
      ...record.browser,
      browserAlive: browserStatus.browserAlive,
    };
    entry.viewer = {
      endpoint:
        record.desktop?.vncPort === undefined
          ? null
          : `vnc://127.0.0.1:${record.desktop.vncPort}`,
      ready: desktopStatus.vncAlive,
      readOnly: record.desktop?.vncViewOnly === true,
    };
  } else if (record.desktop !== undefined) {
    const status = await runtime.desktop.status(record.id);
    if (record.status === "running" && !status.xvfbAlive) {
      entry.status = "dead";
    }
    entry.desktop = {
      ...record.desktop,
      homePolicy: desktopHomePolicy(record.desktop),
      xvfbAlive: status.xvfbAlive,
      vncAlive: status.vncAlive,
      displayAlive: status.displayAlive,
    };
    entry.viewer = {
      endpoint:
        record.desktop.vncPort === undefined
          ? null
          : `vnc://127.0.0.1:${record.desktop.vncPort}`,
      ready: status.vncAlive,
      readOnly: record.desktop.vncViewOnly === true,
    };
  }
  if (record.android !== undefined) {
    const status = await runtime.android.status(record.id);
    if (record.status === "running" && !status.emulatorAlive) {
      entry.status = "dead";
    }
    entry.android = {
      ...record.android,
      emulatorAlive: status.emulatorAlive,
      deviceState: status.deviceState,
    };
  }
  return entry;
}

function canTeardownLocalSession(
  record: SessionRecord,
  runtime: LocalSessionTeardownRuntime,
): boolean {
  if (record.type === "desktop") return runtime.desktop !== undefined;
  if (record.type === "android") return runtime.android !== undefined;
  if (record.type === "browser") return runtime.browser !== undefined;
  return runtime.desktop !== undefined && runtime.android !== undefined;
}

export async function teardownLocalSession(
  record: SessionRecord,
  runtime: LocalSessionTeardownRuntime,
  finalize: LocalSessionTeardownFinalizer,
  options?: LocalSessionTeardownOptions,
): Promise<void> {
  if (record.type === "desktop" && runtime.desktop !== undefined) {
    await runtime.desktop.teardown(record.id, finalize, options);
    return;
  }
  if (record.type === "android" && runtime.android !== undefined) {
    await runtime.android.teardown(record.id, finalize, options);
    return;
  }
  if (record.type === "browser" && runtime.browser !== undefined) {
    await runtime.browser.teardown(record.id, finalize, options);
    return;
  }
  if (
    record.type === "desktop+android" &&
    runtime.desktop !== undefined &&
    runtime.android !== undefined
  ) {
    // The desktop drain must precede either leg's shared-directory retention.
    const android = runtime.android;
    await runtime.desktop.teardown(record.id, () => android.teardown(record.id, finalize, options), options);
    return;
  }
  throw new Error(
    `No typed teardown runtime is available for session ${record.id} of type "${record.type}"`,
  );
}

export async function reapDeadRunningSessions(
  env: EnvLike,
  runtime: LocalSessionTeardownRuntime,
  isAlive: SessionLivenessCheck = isSessionProcessAlive,
): Promise<SessionRecord[]> {
  const reaped: SessionRecord[] = [];
  for (const record of await listSessions(env)) {
    // An interrupted teardown leaves the marker on a running or starting
    // record. A completed rollback is an error record kept for inspection.
    const retryPending = record.status === "error"
      ? record.meta?.[REAPER_CLEANUP_PENDING_META_KEY] === true
      : await isSessionInputClosed(record.id, env);
    if (record.status !== "running" && !retryPending) continue;
    if (!canTeardownLocalSession(record, runtime)) continue;
    if (!retryPending && (await isAlive(record))) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REAPER_TEARDOWN_TIMEOUT_MS);
    try {
      await teardownLocalSession(record, runtime, () =>
        destroySessionRecord(record.id, env, "failed"),
        { signal: controller.signal, inputDrainTimeoutMs: REAPER_TEARDOWN_TIMEOUT_MS },
      );
    } catch {
      // Typed teardown owns failure records. Closure keeps interrupted work
      // retryable; a cancelled lock wait must not rewrite its live holder.
      continue;
    } finally {
      clearTimeout(timer);
    }
    reaped.push(record);
  }
  return reaped;
}

function invokeDestroy(
  destroy: LocalSessionDestroyRuntime["desktop"]["destroy"],
  id: string,
  options: LocalSessionDestroyOptions,
): Promise<void> {
  return options.signal === undefined ? destroy(id) : destroy(id, options);
}

export async function destroyLocalSession(
  record: SessionRecord,
  runtime: LocalSessionDestroyRuntime,
  options: LocalSessionDestroyOptions = {},
): Promise<void> {
  if (record.type === "desktop") {
    await invokeDestroy(runtime.desktop.destroy, record.id, options);
  } else if (record.type === "browser") {
    await invokeDestroy(runtime.browser.destroy, record.id, options);
  } else if (record.type === "android") {
    await invokeDestroy(runtime.android.destroy, record.id, options);
  } else {
    throw new Error(
      `Cannot destroy session ${record.id} of type "${record.type}"`,
    );
  }
}

export async function destroyLocalSessions(
  records: readonly SessionRecord[],
  runtime: LocalSessionDestroyRuntime,
  options: DestroyLocalSessionsOptions = {},
): Promise<DestroyLocalSessionsResult> {
  const destroyed: string[] = [];
  const errors: string[] = [];
  for (const record of records) {
    if (options.signal?.aborted === true) {
      errors.push(`${record.id}: cancelled before teardown started`);
      continue;
    }
    try {
      const destroy = () => destroyLocalSession(record, runtime, { signal: options.signal });
      if (options.aroundDestroy === undefined) {
        await destroy();
      } else {
        await options.aroundDestroy(record, destroy);
      }
      destroyed.push(record.id);
    } catch (error) {
      await markSessionCleanupPendingIfInputClosed(record.id, options.env ?? process.env).catch(() => {});
      errors.push(
        `${record.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { destroyed, errors };
}
