import {
  CONTAINMENT_TOKEN_ENV,
  containmentEnv,
  type ContainmentScope,
  type EnvLike,
} from "@pickforge/lab-core";
import { parseDisplayNumber } from "./display.js";
import type { DesktopRuntimeLayout } from "./runtime.js";

const WAYLAND_DISPLAY_POISON = "pickforge-no-wayland";
const WAYLAND_VARIABLES_TO_UNSET = ["WAYLAND_SOCKET"] as const;

const X11_BACKEND_HINTS = {
  ELECTRON_OZONE_PLATFORM_HINT: "x11",
  GDK_BACKEND: "x11",
  GLFW_PLATFORM: "x11",
  QT_QPA_PLATFORM: "xcb",
  SDL_VIDEODRIVER: "x11",
  WINIT_UNIX_BACKEND: "x11",
  XDG_SESSION_TYPE: "x11",
} as const;

/**
 * D-Bus variables that would otherwise leak the caller's session bus identity
 * to a contained app. `DBUS_SESSION_BUS_ADDRESS` and `DBUS_SYSTEM_BUS_ADDRESS`
 * are not listed: they are overwritten with session-local paths rather than
 * removed, because removing them re-enables libdbus's default-path and
 * autolaunch fallbacks.
 */
const DBUS_VARIABLES_TO_UNSET = [
  "DBUS_SESSION_BUS_PID",
  "DBUS_SESSION_BUS_WINDOWID",
  "DBUS_STARTER_ADDRESS",
  "DBUS_STARTER_BUS_TYPE",
] as const;

/**
 * Variables that make a Node.js or Bun runtime execute code before the script
 * it was asked to run (`--require`, `--import`, loaders, module paths). The
 * containment supervisor is a Node process started with the app's environment,
 * so any of these would run inside it before it joins the scope. They are
 * removed for the app as well: the browser environment allowlist never passed
 * them, and a lab app must not depend on injecting code into the tooling that
 * contains it.
 */
const RUNTIME_INJECTION_VARIABLES_TO_UNSET = [
  "BUN_OPTIONS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
] as const;

function isWaylandVariable(name: string): boolean {
  return name.startsWith("WAYLAND_");
}

export interface DesktopEnvironmentOptions {
  /** Per-session runtime dir and D-Bus endpoints (pickforge/pickforge#86). */
  runtime?: DesktopRuntimeLayout;
  /** Containment scope every launched process must carry (#85). */
  containment?: ContainmentScope;
}

function runtimeIsolationEntries(
  runtime: DesktopRuntimeLayout | undefined,
): Record<string, string> {
  if (runtime === undefined) return {};
  return {
    XDG_RUNTIME_DIR: runtime.runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime.dbusSessionPath}`,
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${runtime.dbusSystemPath}`,
  };
}

/**
 * Build the complete environment for a process that must render on a Pickforge
 * X11 display. The source is copied, never mutated.
 */
export function createIsolatedDesktopEnvironment(
  display: string,
  source: EnvLike = process.env,
  opts: DesktopEnvironmentOptions = {},
): EnvLike {
  parseDisplayNumber(display);
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (isWaylandVariable(name)) delete env[name];
  }
  for (const name of DBUS_VARIABLES_TO_UNSET) delete env[name];
  for (const name of RUNTIME_INJECTION_VARIABLES_TO_UNSET) delete env[name];
  delete env[CONTAINMENT_TOKEN_ENV];
  return {
    ...env,
    DISPLAY: display,
    ...X11_BACKEND_HINTS,
    // Merely unsetting WAYLAND_DISPLAY is not enough: libwayland then falls
    // back to the default "wayland-0" socket, so point it at a socket that
    // cannot exist to force the X11 fallback.
    WAYLAND_DISPLAY: WAYLAND_DISPLAY_POISON,
    ...runtimeIsolationEntries(opts.runtime),
    ...(opts.containment === undefined
      ? {}
      : containmentEnv(opts.containment)),
  };
}

export interface DesktopEnvironmentRecipe {
  exports: Record<string, string>;
  unset: string[];
  lines: string[];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function recipeExportNames(opts: DesktopEnvironmentOptions): string[] {
  return [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    ...Object.keys(X11_BACKEND_HINTS),
    ...Object.keys(runtimeIsolationEntries(opts.runtime)),
    ...(opts.containment === undefined ? [] : [CONTAINMENT_TOKEN_ENV]),
  ];
}

/**
 * Return the safe environment delta that can be printed without exposing
 * secrets. A shell that evaluates this gets the same display, runtime dir,
 * D-Bus and containment isolation as `desktop exec`, so an app started by hand
 * is torn down with the session rather than surviving it.
 */
export function desktopEnvironmentRecipe(
  display: string,
  source: EnvLike = process.env,
  opts: DesktopEnvironmentOptions = {},
): DesktopEnvironmentRecipe {
  const environment = createIsolatedDesktopEnvironment(display, source, opts);
  const unset = [
    ...new Set([
      ...WAYLAND_VARIABLES_TO_UNSET,
      ...DBUS_VARIABLES_TO_UNSET,
      ...RUNTIME_INJECTION_VARIABLES_TO_UNSET,
      ...Object.keys(source).filter(
        (name) => isWaylandVariable(name) && name !== "WAYLAND_DISPLAY",
      ),
    ]),
  ].sort();
  const exports = Object.fromEntries(
    recipeExportNames(opts).map((name) => [name, environment[name] as string]),
  );
  return {
    exports,
    unset,
    lines: [
      ...unset.map((name) => `unset ${shellQuote(name)}`),
      ...Object.entries(exports).map(
        ([name, value]) => `export ${name}=${shellQuote(value)}`,
      ),
    ],
  };
}
