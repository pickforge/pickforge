import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  getSession,
  listProcessGroupMembers,
  readProcessIdentity,
  stopProcessGroupVerified,
  type DesktopSessionInfo,
  type EnvLike,
} from "@pickforge/lab-core";
import {
  findOnPath,
  prepareViewerLaunch,
  removeViewerLaunch,
  withSessionVncLock,
  writeViewerLaunchRecord,
  type ViewerBrowserKind,
  type ViewerHyprlandLaunch,
  type ViewerLaunchRecord,
  type ViewerWindowSize,
} from "@pickforge/lab-desktop-linux";
import { buildViewerUrl } from "./contract.js";
import {
  applyHyprlandWindowMode,
  detectHyprland,
  disableViewerRule,
  hyprlandRuleName,
  installViewerRule,
  viewerClassPattern,
  waitForViewerWindow,
  WINDOW_WAIT_MS,
  type HyprlandContext,
} from "./hyprland.js";

/**
 * Launcher for the passive viewer window (pickforge/pickforge#207): pick a
 * browser, give it a fresh private profile, record the launch, and place
 * the window through the Hyprland adapter when it applies.
 */

/** Chromium-family binaries first, in this order, then Firefox. */
const CHROMIUM_BINARIES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
] as const;

export interface ViewerBrowser {
  kind: ViewerBrowserKind;
  name: string;
  binary: string;
}

export const THUMBNAIL_WIDTH = 384;
const DEFAULT_DESKTOP: ViewerWindowSize = { width: 1280, height: 800 };

export type ViewerAdapter = "hyprland" | "none";

export function detectViewerBrowser(env: EnvLike = process.env): ViewerBrowser | null {
  for (const name of CHROMIUM_BINARIES) {
    const binary = findOnPath(name, env);
    if (binary !== null) return { kind: "chromium", name, binary };
  }
  const firefox = findOnPath("firefox", env);
  return firefox === null ? null : { kind: "firefox", name: "firefox", binary: firefox };
}

export function hasGraphicalSession(env: EnvLike = process.env): boolean {
  return (
    (env.DISPLAY !== undefined && env.DISPLAY !== "") ||
    (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== "")
  );
}

function positiveInt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Thumbnail: 384 logical pixels wide, with the session's aspect ratio.
 * Expanded: the session size. The adapter or the page caps it to the screen.
 */
export function viewerWindowSizes(
  desktop: Pick<DesktopSessionInfo, "width" | "height"> | undefined,
): { thumbnail: ViewerWindowSize; expanded: ViewerWindowSize } {
  const width = positiveInt(desktop?.width);
  const height = positiveInt(desktop?.height);
  const expanded =
    width !== undefined && height !== undefined ? { width, height } : { ...DEFAULT_DESKTOP };
  return {
    thumbnail: {
      width: THUMBNAIL_WIDTH,
      height: Math.max(1, Math.round((THUMBNAIL_WIDTH * expanded.height) / expanded.width)),
    },
    expanded,
  };
}

export function viewerWindowClass(launchId: string): string {
  return `pickforge-viewer-${launchId}`;
}

/**
 * Traffic-reducing switches, a subset of the browser lab's Chrome arguments
 * in packages/browser/src/args.ts. The viewer only talks to loopback.
 * `--gaia-url` is left out: Chromium shows an "unsupported command-line
 * flag" bar for it, which would cover the thumbnail.
 */
const CHROMIUM_QUIET_ARGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-client-side-phishing-detection",
  "--disable-notifications",
  "--gcm-checkin-url=https://127.0.0.1:0",
  "--gcm-registration-url=https://127.0.0.1:0",
  "--gcm-mcs-endpoint=https://127.0.0.1:0",
  "--component-updater=url-source=https://127.0.0.1:0",
  "--disable-features=Translate,MediaRouter,AutofillServerCommunication,OptimizationHints,OptimizationTargetPrediction,OptimizationGuideModelExecution,NetworkTimeServiceQuerying,SafeBrowsingHashPrefixRealTimeLookups,AimEnabled,PreconnectToSearch",
] as const;

export interface ViewerBrowserArgsOptions {
  url: string;
  profileDir: string;
  launchId: string;
  size: ViewerWindowSize;
}

/** Chromium and Chrome: a chromeless app window. Never `--no-sandbox`. */
export function buildChromiumViewerArgs(opts: ViewerBrowserArgsOptions): string[] {
  return [
    `--app=${opts.url}`,
    `--user-data-dir=${opts.profileDir}`,
    `--class=${viewerWindowClass(opts.launchId)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-mode",
    "--password-store=basic",
    "--disable-extensions",
    ...CHROMIUM_QUIET_ARGS,
    `--window-size=${opts.size.width},${opts.size.height}`,
  ];
}

/** Firefox: an ordinary window in its own instance and profile. */
export function buildFirefoxViewerArgs(opts: ViewerBrowserArgsOptions): string[] {
  const windowClass = viewerWindowClass(opts.launchId);
  return [
    "--new-instance",
    "--profile",
    opts.profileDir,
    "--class",
    windowClass,
    "--name",
    windowClass,
    "--width",
    String(opts.size.width),
    "--height",
    String(opts.size.height),
    opts.url,
  ];
}

/**
 * First-run quieting for the fresh Firefox profile. The data reporting
 * prefs stop the privacy notice tab that a new profile otherwise opens
 * next to the viewer (verified with Firefox 155).
 */
export const FIREFOX_USER_JS = [
  'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("identity.fxaccounts.enabled", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
  'user_pref("datareporting.policy.firstRunURL", "");',
  'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
  "",
].join("\n");

async function writeFirefoxUserJs(profileDir: string): Promise<void> {
  // `wx` refuses an existing file or symlink in the fresh profile.
  await fs.promises.writeFile(path.join(profileDir, "user.js"), FIREFOX_USER_JS, {
    mode: 0o600,
    flag: "wx",
  });
}

export interface LaunchViewerWindowOptions {
  sessionId: string;
  desktop: DesktopSessionInfo | undefined;
  bridgePort: number;
  /** Bridge capability token. Goes only into the browser's URL fragment. */
  token: string;
  browser: ViewerBrowser;
  waitForExit: boolean;
  /** Environment for the browser and adapter detection. */
  env?: NodeJS.ProcessEnv;
  registryEnv?: NodeJS.ProcessEnv;
  /** Upper bound for the Hyprland window wait. */
  windowWaitMs?: number;
  /** @internal test hook: replace the conventional signal exit after an interrupt. */
  _exitOnSignal?: (signal: NodeJS.Signals) => void;
}

export interface LaunchedViewerWindow {
  launchId: string;
  browser: string;
  adapter: ViewerAdapter;
  pid: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

/** An interrupt ended the launch after the browser was stopped and the launch removed. */
export class ViewerInterruptedError extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`Viewer launch interrupted by ${signal}`);
    this.name = "ViewerInterruptedError";
  }
}

/** The browser may still run, so its launch stays for session teardown. */
class ViewerLaunchKeptError extends Error {}

interface ExitStatus {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface SpawnedBrowser {
  child: ChildProcess;
  pid: number;
  exited: Promise<ExitStatus>;
  done: () => boolean;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Interrupt handling for one launch, from before the spawn to the end of
 * the wait. The first interrupt sends SIGTERM to the browser group and any
 * later one sends SIGKILL, so a browser that ignores SIGTERM cannot keep
 * this process alive.
 */
class InterruptGuard {
  signal: NodeJS.Signals | undefined;
  private count = 0;
  private pid: number | undefined;
  private readonly onSignal = (signal: NodeJS.Signals): void => {
    this.count += 1;
    this.signal ??= signal;
    this.forward();
  };

  constructor() {
    for (const signal of INTERRUPT_SIGNALS) process.on(signal, this.onSignal);
  }

  attach(pid: number): void {
    this.pid = pid;
    this.forward();
  }

  dispose(): void {
    for (const signal of INTERRUPT_SIGNALS) process.off(signal, this.onSignal);
  }

  private forward(): void {
    if (this.pid === undefined || this.count === 0) return;
    killGroup(this.pid, this.count === 1 ? "SIGTERM" : "SIGKILL");
  }
}

/** With the handlers removed, the default action ends the process with the signal. */
function exitWithSignal(signal: NodeJS.Signals): void {
  process.kill(process.pid, signal);
}

async function spawnBrowser(
  browser: ViewerBrowser,
  args: string[],
  env: NodeJS.ProcessEnv,
  guard: InterruptGuard,
): Promise<SpawnedBrowser> {
  // Detached, so the browser leads its own process group: session teardown
  // stops the whole group by verified identity, and closing the terminal of
  // an automatic launch does not close the window.
  const child = spawn(browser.binary, args, {
    env,
    shell: false,
    stdio: "ignore",
    detached: true,
  });
  if (child.pid !== undefined) guard.attach(child.pid);
  let finished = false;
  const exited = new Promise<ExitStatus>((resolve) => {
    child.once("exit", (exitCode, signal) => {
      finished = true;
      resolve({ exitCode, signal });
    });
  });
  await once(child, "spawn");
  if (child.pid === undefined) throw new Error(`${browser.name} did not start`);
  return { child, pid: child.pid, exited, done: () => finished };
}

/** Stop a browser whose identity was not recorded. True once its group is gone. */
async function stopUnrecordedBrowser(pid: number, startTicks: number | undefined): Promise<boolean> {
  if (startTicks === undefined) return listProcessGroupMembers(pid).length === 0;
  const { outcome } = await stopProcessGroupVerified({ pid, startTicks });
  return outcome === "terminated" || outcome === "already-dead";
}

function hyprlandLaunch(ctx: HyprlandContext, launchId: string): ViewerHyprlandLaunch {
  return {
    ...ctx,
    ruleName: hyprlandRuleName(launchId),
    classPattern: viewerClassPattern(launchId),
  };
}

async function installRule(
  browser: ViewerBrowser,
  env: NodeJS.ProcessEnv,
  launchId: string,
  thumbnail: ViewerWindowSize,
): Promise<ViewerHyprlandLaunch | undefined> {
  if (browser.kind !== "chromium") return undefined;
  const ctx = await detectHyprland(env);
  if (ctx === undefined) return undefined;
  const launch = hyprlandLaunch(ctx, launchId);
  if (await installViewerRule(ctx, launch.ruleName, launch.classPattern, thumbnail)) {
    return launch;
  }
  // A refused install may still have registered the name; disable it.
  await disableViewerRule(ctx, launch.ruleName);
  return undefined;
}

/**
 * Under the session's VNC lock, which teardown also holds: check that the
 * session still runs, prepare the profile, record the launch, spawn the
 * browser and record its identity. A teardown therefore either runs first
 * and stops the launch here, or runs after and finds the recorded browser.
 * On failure the rule is disabled and the launch removed, unless the
 * browser may still run.
 */
async function startLocked(
  opts: LaunchViewerWindowOptions,
  env: NodeJS.ProcessEnv,
  guard: InterruptGuard,
): Promise<{ record: ViewerLaunchRecord; spawned: SpawnedBrowser }> {
  const session = await getSession(opts.sessionId, opts.registryEnv);
  if (session?.status !== "running") {
    throw new Error(`Session ${opts.sessionId} is not running; the viewer was not opened`);
  }
  const { launchId, profileDir } = await prepareViewerLaunch(opts.sessionId, opts.registryEnv);
  const sizes = viewerWindowSizes(opts.desktop);
  const argsOptions = {
    url: buildViewerUrl(opts.bridgePort, launchId, opts.token),
    profileDir,
    launchId,
    size: sizes.thumbnail,
  };
  let hyprland: ViewerHyprlandLaunch | undefined;
  try {
    if (opts.browser.kind === "firefox") await writeFirefoxUserJs(profileDir);
    const record: ViewerLaunchRecord = {
      launchId,
      sessionId: opts.sessionId,
      createdAt: new Date().toISOString(),
      browser: { kind: opts.browser.kind, binary: opts.browser.binary },
      profileDir,
      ...sizes,
    };
    hyprland = await installRule(opts.browser, env, launchId, sizes.thumbnail);
    if (hyprland !== undefined) record.hyprland = hyprland;
    const args =
      opts.browser.kind === "firefox"
        ? buildFirefoxViewerArgs(argsOptions)
        : buildChromiumViewerArgs(argsOptions);
    await writeViewerLaunchRecord(record, opts.registryEnv);
    if (guard.signal !== undefined) throw new ViewerInterruptedError(guard.signal);
    const spawned = await spawnBrowser(opts.browser, args, env, guard);
    const recorded = { ...record, pid: spawned.pid, startTicks: readProcessIdentity(spawned.pid)?.startTicks };
    try {
      await writeViewerLaunchRecord(recorded, opts.registryEnv);
    } catch (error) {
      // Teardown cannot find an unrecorded browser, so do not leave one.
      if (await stopUnrecordedBrowser(spawned.pid, recorded.startTicks)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ViewerLaunchKeptError(
        `${message}; the viewer browser (pid ${spawned.pid}) could not be stopped, ` +
          `so launch ${launchId} remains for session teardown`,
        { cause: error },
      );
    }
    return { record: recorded, spawned };
  } catch (error) {
    if (hyprland !== undefined) await disableViewerRule(hyprland, hyprland.ruleName);
    if (!(error instanceof ViewerLaunchKeptError)) {
      await removeViewerLaunch(opts.sessionId, launchId, opts.registryEnv).catch(() => {});
    }
    throw error;
  }
}

/**
 * Wait for the window to map, then place it once on the monitor it opened
 * on. The rule placed it from the focused monitor's reserved area, which can
 * differ from its own. Resolves true when the window mapped.
 */
async function placeWindow(
  record: ViewerLaunchRecord,
  spawned: SpawnedBrowser,
  guard: InterruptGuard,
  timeoutMs: number,
): Promise<boolean> {
  const hyprland = record.hyprland;
  if (hyprland === undefined) return false;
  const window = await waitForViewerWindow(hyprland, hyprland.classPattern, spawned.pid, {
    timeoutMs,
    stopped: () => spawned.done() || guard.signal !== undefined,
  });
  if (window === undefined) return false;
  await applyHyprlandWindowMode(record, "thumbnail");
  return true;
}

async function runLaunch(
  opts: LaunchViewerWindowOptions,
  guard: InterruptGuard,
): Promise<LaunchedViewerWindow> {
  const env = opts.env ?? process.env;
  // Released before the placement wait: the bridge takes this lock for
  // every VNC connect, and the page connects while the window maps.
  const { record, spawned } = await withSessionVncLock(
    opts.sessionId,
    opts.registryEnv ?? process.env,
    () => startLocked(opts, env, guard),
  );
  let placed = false;
  try {
    placed = await placeWindow(record, spawned, guard, opts.windowWaitMs ?? WINDOW_WAIT_MS);
  } finally {
    if (record.hyprland !== undefined) await disableViewerRule(record.hyprland, record.hyprland.ruleName);
  }
  const result: LaunchedViewerWindow = {
    launchId: record.launchId,
    browser: opts.browser.name,
    adapter: placed ? "hyprland" : "none",
    pid: spawned.pid,
  };
  if (!opts.waitForExit && guard.signal === undefined && !spawned.done()) {
    spawned.child.unref();
    return result;
  }
  const status = await spawned.exited;
  // A launch that cannot be removed now is pruned by a later launch.
  await removeViewerLaunch(opts.sessionId, record.launchId, opts.registryEnv).catch(() => {});
  return { ...result, ...status };
}

/**
 * Open one viewer window on the bridge. With `waitForExit`, resolve once
 * the browser main process exits and remove the launch; otherwise resolve
 * after the bounded window wait, leaving the browser running unref'd, or
 * with its exit status when it already exited. An interrupt stops the
 * browser, cleans up, and ends this process with the same signal.
 */
export async function launchViewerWindow(opts: LaunchViewerWindowOptions): Promise<LaunchedViewerWindow> {
  const guard = new InterruptGuard();
  let launched: LaunchedViewerWindow | undefined;
  try {
    launched = await runLaunch(opts, guard);
  } catch (error) {
    if (guard.signal === undefined) throw error;
  } finally {
    guard.dispose();
  }
  const signal = guard.signal;
  if (signal === undefined) return launched as LaunchedViewerWindow;
  (opts._exitOnSignal ?? exitWithSignal)(signal);
  throw new ViewerInterruptedError(signal);
}
