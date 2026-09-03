import type { EnvLike } from "@pickforge/picklab-core";
import { parseDisplayNumber } from "./display.js";

const WAYLAND_DISPLAY_POISON = "picklab-no-wayland";
const WAYLAND_VARIABLES_TO_UNSET = ["WAYLAND_SOCKET"] as const;

const X11_BACKEND_HINTS = {
  GDK_BACKEND: "x11",
  QT_QPA_PLATFORM: "xcb",
  SDL_VIDEODRIVER: "x11",
  WINIT_UNIX_BACKEND: "x11",
  XDG_SESSION_TYPE: "x11",
} as const;

function isWaylandVariable(name: string): boolean {
  return name.startsWith("WAYLAND_");
}

/**
 * Build the complete environment for a process that must render on a PickLab
 * X11 display. The source is copied, never mutated.
 */
export function createIsolatedDesktopEnvironment(
  display: string,
  source: EnvLike = process.env,
): EnvLike {
  parseDisplayNumber(display);
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (isWaylandVariable(name)) {
      delete env[name];
    }
  }
  return {
    ...env,
    DISPLAY: display,
    ...X11_BACKEND_HINTS,
    // Merely unsetting WAYLAND_DISPLAY is not enough: libwayland then falls
    // back to the default "wayland-0" socket, so point it at a socket that
    // cannot exist to force the X11 fallback.
    WAYLAND_DISPLAY: WAYLAND_DISPLAY_POISON,
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

/** Return the safe environment delta that can be printed without exposing secrets. */
export function desktopEnvironmentRecipe(
  display: string,
  source: EnvLike = process.env,
): DesktopEnvironmentRecipe {
  const environment = createIsolatedDesktopEnvironment(display, source);
  const unset = [
    ...new Set([
      ...WAYLAND_VARIABLES_TO_UNSET,
      ...Object.keys(source).filter(
        (name) => isWaylandVariable(name) && name !== "WAYLAND_DISPLAY",
      ),
    ]),
  ].sort();
  const exportNames = [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    ...Object.keys(X11_BACKEND_HINTS),
  ];
  const exports = Object.fromEntries(
    exportNames.map((name) => [name, environment[name] as string]),
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
