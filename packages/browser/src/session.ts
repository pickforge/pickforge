import fs from "node:fs";
import path from "node:path";
import {
  REAPER_CLEANUP_PENDING_META_KEY,
  createSession,
  destroySessionRecord,
  getSession,
  isDisplaySocketAlive,
  isPidAlive,
  isProfileConfined,
  processIdentityMatches,
  reapDeadRunningSessions,
  readProcessIdentity,
  readPickforgeEnv,
  sessionDataDir,
  startDaemon,
  stopOwnedDaemonGroup,
  stopProcessGroupVerified,
  updateSession,
  type BrowserSessionInfo,
  type DesktopSessionInfo,
  type EnvLike,
  type LocalSessionTeardownFinalizer,
  type OwnedDaemonHandle,
  type ProcessIdentity,
  type SessionRecord,
} from "@pickforge/lab-core";
import {
  XvfbStartError,
  startXvfb,
  stopOwnedSessionVnc,
  withSessionVncLock,
  type XvfbHandle,
  type XvfbPartialStart,
} from "@pickforge/lab-desktop-linux";
import { buildChromeArgs } from "./args.js";
import { requireChromeBinary } from "./detect.js";
import {
  browserRuntimeLayout,
  buildBrowserEnv,
  type BrowserRuntimeLayout,
} from "./env.js";
import { waitForDevToolsPort } from "./devtools.js";
import { buildSupervisedBrowserCommand } from "./supervisor.js";
import { asError, sleep } from "./util.js";

const DEFAULT_CDP_TIMEOUT_MS = 20_000;
// A browser session also launches a heavy real Chrome, so its private Xvfb can
// be scheduled slowly on a busy host. Give the display generous headroom rather
// than the display supervisor's default so a loaded machine does not fail the
// whole create.
const DEFAULT_XVFB_WAIT_TIMEOUT_MS = 30_000;
// Allocate browser displays from a range separate from desktop sessions (which
// start at :90) so the two kinds never contend for the same display number.
const BROWSER_DISPLAY_START = 200;

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("Browser session creation aborted by the client");
  }
}

export interface CreateBrowserSessionOptions {
  projectDir: string;
  /** Registry env (PICKFORGE_HOME) for session records. */
  registryEnv?: EnvLike;
  /** Spawn env: source for PATH, locale, and Chrome binary detection. */
  env?: EnvLike;
  width?: number;
  height?: number;
  binaryPath?: string;
  noSandbox?: boolean;
  extraArgs?: string[];
  startUrl?: string;
  cdpTimeoutMs?: number;
  xvfbWaitTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface BrowserSessionHandle {
  id: string;
  display: string;
  xvfbPid: number;
  browserPid: number;
  cdpPort: number;
  profileDir: string;
  binaryPath: string;
  logDir: string;
}

export interface BrowserSessionStatus {
  record: SessionRecord;
  xvfbAlive: boolean;
  displayAlive: boolean;
  browserAlive: boolean;
  /** True only when both legs (Xvfb display and Chrome identity) are live. */
  alive: boolean;
  cdpPort?: number;
}

export function browserSessionLogDir(
  id: string,
  registryEnv: EnvLike = process.env,
): string {
  return sessionDataDir(id, registryEnv);
}

async function makeRuntimeDirs(layout: BrowserRuntimeLayout): Promise<void> {
  const dirs = [
    path.dirname(layout.profileDir),
    layout.profileDir,
    layout.homeDir,
    layout.xdgConfigHome,
    layout.xdgCacheHome,
    path.join(layout.homeDir, ".local"),
    layout.xdgDataHome,
    layout.xdgStateHome,
    layout.tmpDir,
    layout.xdgRuntimeDir,
  ];
  for (const dir of dirs) {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is still filtered by umask and does not change an existing
    // directory, so enforce private permissions explicitly on every level.
    await fs.promises.chmod(dir, 0o700);
  }
}

async function removeRuntimeData(
  layout: BrowserRuntimeLayout,
  profileDir = layout.profileDir,
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const dir of [
    profileDir,
    layout.homeDir,
    layout.xdgRuntimeDir,
    layout.tmpDir,
  ]) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (error) {
      failures.push(asError(error));
    }
  }
  return failures;
}

/**
 * Stop a browser's process group, re-verifying the group-leader identity before
 * every signal so a reused PID is never killed. Returns whether the group is
 * confirmed gone; the caller must not delete the profile until it is.
 */
async function stopBrowserGroup(
  identity: ProcessIdentity | undefined,
): Promise<{ gone: boolean; error?: Error }> {
  if (identity === undefined) {
    return { gone: true };
  }
  try {
    const result = await stopProcessGroupVerified(identity);
    return {
      gone:
        result.outcome === "terminated" || result.outcome === "already-dead",
    };
  } catch (error) {
    return { gone: false, error: asError(error) };
  }
}

function ownedDaemonExited(daemon: OwnedDaemonHandle): boolean {
  return daemon.child.exitCode !== null || daemon.child.signalCode !== null;
}

async function waitForOwnedIdentity(
  daemon: OwnedDaemonHandle,
): Promise<ProcessIdentity | undefined> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    const identity = readProcessIdentity(daemon.pid);
    if (identity !== undefined) return identity;
    if (ownedDaemonExited(daemon) || Date.now() >= deadline) return undefined;
    await sleep(10);
  }
}

/**
 * Stop an owned Chrome supervisor before its `/proc`-backed identity has been
 * captured. Shared with the Xvfb supervisor (pickforge/pickforge#57) so both
 * use one group-kill-and-confirm implementation; see `stopOwnedDaemonGroup`
 * for the pid-reuse reasoning behind each branch.
 */
async function stopOwnedBrowserDaemon(
  daemon: OwnedDaemonHandle,
): Promise<boolean> {
  return stopOwnedDaemonGroup(daemon);
}

/**
 * Create an isolated headed-Chrome session: a private Xvfb display plus headed
 * Chrome on an ephemeral profile with a loopback CDP endpoint. A partial
 * failure tears down every process and deletes the profile before rethrowing.
 * If cleanup cannot be confirmed, the error record retains every known
 * identity and is marked for a later reaper retry.
 */
// eslint-disable-next-line max-lines-per-function, complexity -- Legacy gate debt: pickforge/pickforge#60
export async function createBrowserSession(
  opts: CreateBrowserSessionOptions,
): Promise<BrowserSessionHandle> {
  const registryEnv = opts.registryEnv ?? process.env;
  const spawnEnv = opts.env ?? process.env;
  assertNotAborted(opts.signal);
  const binaryPath = requireChromeBinary({
    env: spawnEnv,
    ...(opts.binaryPath !== undefined ? { binaryPath: opts.binaryPath } : {}),
  });

  await reapDeadRunningSessions(registryEnv, {
    browser: {
      teardown: (id, finalize) =>
        teardownBrowserSession(id, registryEnv, finalize),
    },
  });
  assertNotAborted(opts.signal);
  const record = await createSession(
    { type: "browser", projectDir: opts.projectDir },
    registryEnv,
  );
  const logDir = browserSessionLogDir(record.id, registryEnv);
  const layout = browserRuntimeLayout(logDir);

  let xvfb: XvfbHandle | undefined;
  let xvfbPartial: XvfbPartialStart | undefined;
  let xvfbIdentity: ProcessIdentity | undefined;
  let browserIdentity: ProcessIdentity | undefined;
  let browserDaemon: OwnedDaemonHandle | undefined;
  try {
    assertNotAborted(opts.signal);
    await makeRuntimeDirs(layout);

    try {
      xvfb = await startXvfb({
        ...(opts.width !== undefined ? { width: opts.width } : {}),
        ...(opts.height !== undefined ? { height: opts.height } : {}),
        logDir,
        env: spawnEnv,
        waitTimeoutMs: opts.xvfbWaitTimeoutMs ?? DEFAULT_XVFB_WAIT_TIMEOUT_MS,
        displayStart: BROWSER_DISPLAY_START,
        signal: opts.signal,
        onSpawn: async (partial) => {
          xvfbPartial = partial;
          await updateSession(
            record.id,
            {
              desktop: {
                display: partial.display,
                xvfbPid: partial.pid,
                xvfbStartTimeTicks: partial.startTimeTicks,
                width: partial.width,
                height: partial.height,
              },
            },
            registryEnv,
          );
        },
      });
    } catch (error) {
      if (error instanceof XvfbStartError && error.partial !== undefined) {
        xvfbPartial = error.partial;
      }
      throw error;
    }
    xvfbIdentity = {
      pid: xvfb.pid,
      startTicks: xvfb.startTimeTicks,
    };
    const desktop: DesktopSessionInfo = {
      display: xvfb.display,
      xvfbPid: xvfb.pid,
      xvfbStartTimeTicks: xvfbIdentity.startTicks,
      width: xvfb.width,
      height: xvfb.height,
    };

    const args = buildChromeArgs({
      profileDir: layout.profileDir,
      width: xvfb.width,
      height: xvfb.height,
      noSandbox:
        opts.noSandbox ??
        readPickforgeEnv(spawnEnv, "CHROME_NO_SANDBOX") === "1",
      ...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
      ...(opts.startUrl !== undefined ? { startUrl: opts.startUrl } : {}),
    });
    const childEnv = buildBrowserEnv({
      display: xvfb.display,
      layout,
      sourceEnv: spawnEnv,
    });
    assertNotAborted(opts.signal);
    const supervised = buildSupervisedBrowserCommand(
      process.execPath,
      binaryPath,
      args,
    );
    browserDaemon = await startDaemon(supervised.command, supervised.args, {
      logDir,
      name: "chrome",
      env: childEnv,
      cleanEnv: true,
      owned: true,
    });
    browserIdentity = await waitForOwnedIdentity(browserDaemon);
    if (browserIdentity === undefined) {
      await stopOwnedBrowserDaemon(browserDaemon);
      throw new Error(
        `Chrome process ${browserDaemon.pid} could not be identified during startup; ` +
          `check the log at ${browserDaemon.logPath}`,
      );
    }
    const startingBrowser: BrowserSessionInfo = {
      browserPid: browserIdentity.pid,
      browserStartTimeTicks: browserIdentity.startTicks,
      binaryPath,
      profileMode: "ephemeral",
      profileDir: layout.profileDir,
    };
    await updateSession(
      record.id,
      { desktop, browser: startingBrowser },
      registryEnv,
    );
    browserDaemon.release();

    const waited = await waitForDevToolsPort({
      profileDir: layout.profileDir,
      timeoutMs: opts.cdpTimeoutMs ?? DEFAULT_CDP_TIMEOUT_MS,
      isAlive: () =>
        browserIdentity !== undefined && processIdentityMatches(browserIdentity),
      signal: opts.signal,
    });
    if (!waited.ok) {
      if (waited.reason === "aborted") {
        throw new Error("Browser session creation aborted by the client");
      }
      throw new Error(
        waited.reason === "exited"
          ? `Chrome exited during startup before exposing a DevTools port; ` +
            `check the log at ${browserDaemon.logPath}`
          : `Chrome did not expose a DevTools port within ` +
            `${opts.cdpTimeoutMs ?? DEFAULT_CDP_TIMEOUT_MS}ms; ` +
            `check the log at ${browserDaemon.logPath}`,
      );
    }

    if (!processIdentityMatches(browserIdentity)) {
      throw new Error(
        `Chrome process ${browserDaemon.pid} vanished right after startup; ` +
          `check the log at ${browserDaemon.logPath}`,
      );
    }
    const browser: BrowserSessionInfo = {
      ...startingBrowser,
      cdpPort: waited.port,
    };
    assertNotAborted(opts.signal);
    await updateSession(
      record.id,
      { status: "running", desktop, browser },
      registryEnv,
    );
    assertNotAborted(opts.signal);

    return {
      id: record.id,
      display: xvfb.display,
      xvfbPid: xvfb.pid,
      browserPid: browserIdentity.pid,
      cdpPort: waited.port,
      profileDir: layout.profileDir,
      binaryPath,
      logDir,
    };
  } catch (error) {
    const browserGone =
      browserIdentity === undefined && browserDaemon !== undefined
        ? await stopOwnedBrowserDaemon(browserDaemon)
        : (await stopBrowserGroup(browserIdentity)).gone;
    browserDaemon?.release();
    const xvfbGone =
      xvfb === undefined
        ? (xvfbPartial?.cleanupConfirmed ?? true)
        : browserGone && xvfbIdentity !== undefined
          ? (await stopBrowserGroup(xvfbIdentity)).gone
          : false;
    const runtimeFailures =
      browserGone && xvfbGone ? await removeRuntimeData(layout) : [];
    const cleanupComplete =
      browserGone && xvfbGone && runtimeFailures.length === 0;
    const knownXvfb = xvfb ?? xvfbPartial;
    const knownXvfbStartTimeTicks =
      knownXvfb !== undefined && xvfbPartial?.pid === knownXvfb.pid
        ? xvfbPartial.startTimeTicks
        : xvfbIdentity?.startTicks;
    const desktop =
      knownXvfb === undefined
        ? undefined
        : {
            display: knownXvfb.display,
            xvfbPid: knownXvfb.pid,
            ...(knownXvfbStartTimeTicks === undefined
              ? {}
              : { xvfbStartTimeTicks: knownXvfbStartTimeTicks }),
            width: knownXvfb.width,
            height: knownXvfb.height,
          };
    const browser =
      browserIdentity === undefined
        ? undefined
        : {
            browserPid: browserIdentity.pid,
            browserStartTimeTicks: browserIdentity.startTicks,
            binaryPath,
            profileMode: "ephemeral" as const,
            profileDir: layout.profileDir,
          };
    const clearedMeta = { ...record.meta };
    delete clearedMeta[REAPER_CLEANUP_PENDING_META_KEY];
    await updateSession(
      record.id,
      cleanupComplete
        ? {
            status: "error",
            desktop: undefined,
            browser: undefined,
            meta: clearedMeta,
          }
        : {
            status: "error",
            meta: {
              ...record.meta,
              [REAPER_CLEANUP_PENDING_META_KEY]: true,
            },
            ...(desktop === undefined ? {} : { desktop }),
            ...(browser === undefined ? {} : { browser }),
          },
      registryEnv,
    ).catch(() => {});
    throw error;
  }
}

export async function getBrowserSessionStatus(
  id: string,
  registryEnv: EnvLike = process.env,
): Promise<BrowserSessionStatus> {
  const record = await getSession(id, registryEnv);
  if (record === undefined) {
    throw new Error(`Browser session not found: ${id}`);
  }
  const desktop = record.desktop;
  const browser = record.browser;
  const xvfbAlive =
    desktop?.xvfbPid !== undefined &&
    desktop.xvfbStartTimeTicks !== undefined &&
    processIdentityMatches({
      pid: desktop.xvfbPid,
      startTicks: desktop.xvfbStartTimeTicks,
    });
  const displayAlive =
    desktop !== undefined && isDisplaySocketAlive(desktop.display);
  const browserAlive =
    browser !== undefined &&
    processIdentityMatches({
      pid: browser.browserPid,
      startTicks: browser.browserStartTimeTicks,
    });
  return {
    record,
    xvfbAlive,
    displayAlive,
    browserAlive,
    alive: xvfbAlive && displayAlive && browserAlive,
    ...(browser?.cdpPort !== undefined ? { cdpPort: browser.cdpPort } : {}),
  };
}

/**
 * Destroy a browser session: kill the verified Chrome process group and confirm
 * it is dead, stop lazy VNC before the private Xvfb, then delete the ephemeral
 * profile. The profile is removed only after the group is confirmed gone, so
 * no live Chrome can recreate files after deletion. Cleanup failures aggregate
 * into one error
 * and leave the record in `error` state for inspection.
 */
// eslint-disable-next-line max-lines-per-function -- Legacy gate debt: pickforge/pickforge#60
export async function teardownBrowserSession(
  id: string,
  registryEnv: EnvLike,
  finalize: LocalSessionTeardownFinalizer,
): Promise<void> {
  const initial = await getSession(id, registryEnv);
  if (initial === undefined) {
    throw new Error(`Browser session not found: ${id}`);
  }
  if (initial.type !== "browser") {
    throw new Error(`Session ${id} is not a browser session`);
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- Legacy gate debt: pickforge/pickforge#60
  await withSessionVncLock(id, registryEnv, async () => {
    const record = await getSession(id, registryEnv);
    if (record === undefined) {
      throw new Error(`Browser session not found: ${id}`);
    }
    if (record.type !== "browser") {
      throw new Error(`Session ${id} is not a browser session`);
    }

    const failures: Error[] = [];
    const browser = record.browser;
    const { gone, error: groupError } = await stopBrowserGroup(
      browser === undefined
        ? undefined
        : {
            pid: browser.browserPid,
            startTicks: browser.browserStartTimeTicks,
          },
    );
    if (groupError !== undefined) {
      failures.push(groupError);
    } else if (!gone) {
      failures.push(
        new Error(
          `Chrome process group (pid ${browser?.browserPid ?? "unknown"}) could not be verified as gone`,
        ),
      );
    }

    const desktop = record.desktop;
    if (desktop?.vncPid !== undefined && gone) {
      try {
        await stopOwnedSessionVnc(id, desktop);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    } else if (desktop?.vncPid !== undefined) {
      failures.push(
        new Error(
          `Refusing to stop x11vnc for ${id}: Chrome process group is not confirmed gone`,
        ),
      );
    }

    const xvfbPid = desktop?.xvfbPid;
    const xvfbStartTimeTicks = desktop?.xvfbStartTimeTicks;
    if (xvfbPid !== undefined && gone) {
      if (xvfbStartTimeTicks === undefined) {
        if (isPidAlive(xvfbPid)) {
          failures.push(
            new Error(
              `Refusing to stop Xvfb (pid ${xvfbPid}): process identity is unavailable`,
            ),
          );
        }
      } else {
        const stopped = await stopBrowserGroup({
          pid: xvfbPid,
          startTicks: xvfbStartTimeTicks,
        });
        if (!stopped.gone) {
          failures.push(
            stopped.error ??
              new Error(
                `Xvfb process group (pid ${xvfbPid}) could not be verified as gone`,
              ),
          );
        }
      }
    } else if (xvfbPid !== undefined) {
      failures.push(
        new Error(
          `Refusing to stop Xvfb for ${id}: Chrome process group is not confirmed gone`,
        ),
      );
    }

    const sessionDir = browserSessionLogDir(id, registryEnv);
    const layout = browserRuntimeLayout(sessionDir);
    const profileDir = browser?.profileDir ?? layout.profileDir;
    // Confinement guard: never delete a profile path a tampered record points
    // outside the session directory.
    const confined = await isProfileConfined(sessionDir, profileDir);
    if (!confined) {
      failures.push(
        new Error(
          `Refusing to delete profile outside the session directory: ${profileDir}`,
        ),
      );
    } else if (gone) {
      failures.push(...(await removeRuntimeData(layout, profileDir)));
      if (failures.length === 0) {
        try {
          await fs.promises.rm(sessionDir, { recursive: true, force: true });
        } catch (error) {
          failures.push(asError(error));
        }
      }
    } else {
      failures.push(
        new Error(
          `Refusing to delete profile for ${id}: Chrome process group is still alive`,
        ),
      );
    }

    if (failures.length > 0) {
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
      throw new AggregateError(
        failures,
        `Failed to fully destroy browser session ${id}`,
      );
    }
    await finalize();
  });
}

export async function destroyBrowserSession(
  id: string,
  registryEnv: EnvLike = process.env,
): Promise<void> {
  await teardownBrowserSession(id, registryEnv, () =>
    destroySessionRecord(id, registryEnv),
  );
}
