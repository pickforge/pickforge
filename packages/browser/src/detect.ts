import fs from "node:fs";
import type { EnvLike } from "@pickforge/lab-core";
import { findOnPath } from "@pickforge/lab-desktop-linux";

/**
 * Chrome/Chromium binaries PickLab knows how to drive, in preference order.
 * Stable Google Chrome first, then Chromium variants. Firefox/WebKit are out
 * of scope for v1.
 */
export const SUPPORTED_CHROME_BINARIES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "chrome",
] as const;

export interface DetectChromeOptions {
  env?: EnvLike;
  /** Explicit binary path or name; wins over PATH detection. */
  binaryPath?: string;
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function overrideFrom(opts: DetectChromeOptions, env: EnvLike): string | undefined {
  if (opts.binaryPath !== undefined && opts.binaryPath !== "") {
    return opts.binaryPath;
  }
  const fromEnv = env.PICKLAB_CHROME_BIN;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
}

/**
 * Resolve a usable Chrome/Chromium binary, or `null` if none is available.
 * An explicit override (option or `PICKLAB_CHROME_BIN`) is honored only when it
 * points at an executable file; otherwise we search `PATH` for known binaries.
 */
export function detectChromeBinary(opts: DetectChromeOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const override = overrideFrom(opts, env);
  if (override !== undefined) {
    if (override.includes("/")) {
      return isExecutableFile(override) ? override : null;
    }
    return findOnPath(override, env);
  }
  for (const name of SUPPORTED_CHROME_BINARIES) {
    const found = findOnPath(name, env);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** Resolve a Chrome/Chromium binary, throwing an actionable error if missing. */
export function requireChromeBinary(opts: DetectChromeOptions = {}): string {
  const binary = detectChromeBinary(opts);
  if (binary !== null) {
    return binary;
  }
  const env = opts.env ?? process.env;
  const override = overrideFrom(opts, env);
  if (override !== undefined) {
    throw new Error(
      `Configured Chrome binary is not usable: "${override}". ` +
        `Set PICKLAB_CHROME_BIN (or the binaryPath option) to an executable ` +
        `Chrome/Chromium, or remove it to fall back to PATH detection.`,
    );
  }
  throw new Error(
    "No Chrome or Chromium binary found on PATH. PickLab looked for " +
      `${SUPPORTED_CHROME_BINARIES.join(", ")}. Install Google Chrome or ` +
      "Chromium, or set PICKLAB_CHROME_BIN to the browser binary path.",
  );
}
