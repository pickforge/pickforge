import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { readProcessIdentity, type DesktopSessionInfo, type EnvLike } from "@pickforge/lab-core";
import {
  findOnPath,
  prepareViewerLaunch,
  removeViewerLaunch,
  writeViewerLaunchRecord,
  type ViewerBrowserKind,
  type ViewerHyprlandLaunch,
  type ViewerLaunchRecord,
  type ViewerWindowSize,
} from "@pickforge/lab-desktop-linux";
import { buildViewerUrl } from "./contract.js";
import {
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
}

export interface LaunchedViewerWindow {
  launchId: string;
  browser: string;
  adapter: ViewerAdapter;
  pid: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

interface ExitStatus {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

async function spawnBrowser(
  browser: ViewerBrowser,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ child: ChildProcess; pid: number; exited: Promise<ExitStatus>; done: () => boolean }> {
  // Detached, so the browser leads its own process group: session teardown
  // stops the whole group by verified identity, and closing the terminal of
  // an automatic launch does not close the window.
  const child = spawn(browser.binary, args, {
    env,
    shell: false,
    stdio: "ignore",
    detached: true,
  });
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

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Forward an interrupt of this process to the browser group while waiting. */
async function waitWithForwardedSignals(pid: number, exited: Promise<ExitStatus>): Promise<ExitStatus> {
  const forward = (signal: NodeJS.Signals): void => killGroup(pid, signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    return await exited;
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
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
 * Spawn the browser with the rule in place. The rule is disabled in every
 * case once the window maps, the browser exits, the wait times out, or
 * anything fails before that.
 */
async function spawnRecordedBrowser(
  record: ViewerLaunchRecord,
  args: string[],
  opts: LaunchViewerWindowOptions,
  env: NodeJS.ProcessEnv,
): Promise<{ pid: number; exited: Promise<ExitStatus>; placed: boolean; child: ChildProcess }> {
  const hyprland = record.hyprland;
  try {
    await writeViewerLaunchRecord(record, opts.registryEnv);
    const spawned = await spawnBrowser(opts.browser, args, env);
    const identity = readProcessIdentity(spawned.pid);
    try {
      await writeViewerLaunchRecord(
        { ...record, pid: spawned.pid, startTicks: identity?.startTicks },
        opts.registryEnv,
      );
    } catch (error) {
      // Teardown could not find an unrecorded browser, so do not leave one.
      killGroup(spawned.pid, "SIGTERM");
      throw error;
    }
    let placed = false;
    if (hyprland !== undefined) {
      const window = await waitForViewerWindow(hyprland, hyprland.classPattern, spawned.pid, {
        timeoutMs: opts.windowWaitMs ?? WINDOW_WAIT_MS,
        stopped: spawned.done,
      });
      placed = window !== undefined;
    }
    return { ...spawned, placed };
  } finally {
    if (hyprland !== undefined) await disableViewerRule(hyprland, hyprland.ruleName);
  }
}

/**
 * Open one viewer window on the bridge. With `waitForExit`, resolve once
 * the browser main process exits and remove the launch; otherwise resolve
 * after the bounded window wait, leaving the browser running unref'd.
 */
export async function launchViewerWindow(opts: LaunchViewerWindowOptions): Promise<LaunchedViewerWindow> {
  const env = opts.env ?? process.env;
  const prepared = await prepareViewerLaunch(opts.sessionId, opts.registryEnv);
  const { launchId, profileDir } = prepared;
  const sizes = viewerWindowSizes(opts.desktop);
  const argsOptions = {
    url: buildViewerUrl(opts.bridgePort, launchId, opts.token),
    profileDir,
    launchId,
    size: sizes.thumbnail,
  };
  let spawned: Awaited<ReturnType<typeof spawnRecordedBrowser>>;
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
    const hyprland = await installRule(opts.browser, env, launchId, sizes.thumbnail);
    if (hyprland !== undefined) record.hyprland = hyprland;
    const args =
      opts.browser.kind === "firefox"
        ? buildFirefoxViewerArgs(argsOptions)
        : buildChromiumViewerArgs(argsOptions);
    spawned = await spawnRecordedBrowser(record, args, opts, env);
  } catch (error) {
    await removeViewerLaunch(opts.sessionId, launchId, opts.registryEnv).catch(() => {});
    throw error;
  }
  const result: LaunchedViewerWindow = {
    launchId,
    browser: opts.browser.name,
    adapter: spawned.placed ? "hyprland" : "none",
    pid: spawned.pid,
  };
  if (!opts.waitForExit) {
    spawned.child.unref();
    return result;
  }
  const status = await waitWithForwardedSignals(spawned.pid, spawned.exited);
  // A launch that cannot be removed now is pruned by a later launch.
  await removeViewerLaunch(opts.sessionId, launchId, opts.registryEnv).catch(() => {});
  return { ...result, ...status };
}
