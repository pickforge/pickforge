import path from "node:path";
import type { EnvLike } from "@pickforge/lab-core";

/**
 * Filesystem layout for a browser session's isolated runtime, all confined
 * under the session directory so a single recursive delete removes every trace
 * (profile, home, caches, runtime dir) when the session is destroyed.
 */
export interface BrowserRuntimeLayout {
  /** Isolated `$HOME`; never the invoking user's real home. */
  homeDir: string;
  /** Chrome `--user-data-dir` (the ephemeral profile). */
  profileDir: string;
  xdgConfigHome: string;
  xdgCacheHome: string;
  xdgDataHome: string;
  xdgStateHome: string;
  xdgRuntimeDir: string;
  tmpDir: string;
}

export function browserRuntimeLayout(sessionDir: string): BrowserRuntimeLayout {
  const home = path.join(sessionDir, "home");
  return {
    homeDir: home,
    profileDir: path.join(sessionDir, "profile"),
    xdgConfigHome: path.join(home, ".config"),
    xdgCacheHome: path.join(home, ".cache"),
    xdgDataHome: path.join(home, ".local", "share"),
    xdgStateHome: path.join(home, ".local", "state"),
    xdgRuntimeDir: path.join(sessionDir, "xdg-runtime"),
    tmpDir: path.join(sessionDir, "tmp"),
  };
}

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Environment variables copied verbatim from the source environment when
 * present. Deliberately tiny: locale/timezone only, never anything that could
 * carry a credential.
 */
const LOCALE_PASSTHROUGH = [
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
] as const;

export interface BuildBrowserEnvOptions {
  display: string;
  layout: BrowserRuntimeLayout;
  /** Environment to draw PATH and locale from; secrets here are dropped. */
  sourceEnv?: EnvLike;
}

/**
 * Build the scrubbed environment handed to Chrome. This is an allowlist, not a
 * denylist: the child sees only the isolated display, isolated HOME/XDG paths,
 * PATH, locale, and the Wayland-avoidance guard — nothing else from the
 * invoking process. Callers pass this with `cleanEnv: true` so the child starts
 * from an empty environment and receives exactly these keys.
 */
export function buildBrowserEnv(
  opts: BuildBrowserEnvOptions,
): Record<string, string> {
  const source = opts.sourceEnv ?? process.env;
  const { layout } = opts;
  const env: Record<string, string> = {
    DISPLAY: opts.display,
    HOME: layout.homeDir,
    XDG_CONFIG_HOME: layout.xdgConfigHome,
    XDG_CACHE_HOME: layout.xdgCacheHome,
    XDG_DATA_HOME: layout.xdgDataHome,
    XDG_STATE_HOME: layout.xdgStateHome,
    XDG_RUNTIME_DIR: layout.xdgRuntimeDir,
    TMPDIR: layout.tmpDir,
    PATH:
      source.PATH !== undefined && source.PATH !== "" ? source.PATH : DEFAULT_PATH,
    // Toolkits (Chrome/ozone, GTK) try Wayland first, which would place the
    // window on the user's real desktop. Point WAYLAND_DISPLAY at a socket that
    // cannot exist so libwayland falls back to the isolated X11 display.
    WAYLAND_DISPLAY: "pickforge-no-wayland",
  };
  for (const key of LOCALE_PASSTHROUGH) {
    const value = source[key];
    if (value !== undefined && value !== "") {
      env[key] = value;
    }
  }
  return env;
}
