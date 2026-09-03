// Linux graphical `sudo` (askpass) capability detection —
// pickforge/pickforge#27.
//
// Implements the *detection* half of the "Shared graphical sudo (askpass)
// security contract — locked v1" pinned on that issue (shared with
// pickforge/pickforge#215, which ships the same semantics in
// crates/pickforge-core/src/process/askpass.rs): Linux graphical sessions
// only, a fixed probe list (no dynamic discovery, no bundled helper), and
// fail-closed when nothing resolves. The *injection* half — passing
// `SUDO_ASKPASS`, and only that variable, into the spawned privileged
// command — lives in ./executor.ts (materializePrivilegedStep), since
// PickLab programmatically issues `sudo -A` rather than hosting an
// interactive shell the way PickForge does.
//
// Scope: macOS/Windows are out of scope for this release.
// `detectAskpassCapability` is a pure function so every branch — including
// the user-set-vs-probe-list priority order — is directly testable on any
// host; only `resolveAskpassCapability` gates real filesystem probing to
// Linux, matching where the feature actually activates.

import fs from "node:fs";
import type { EnvLike } from "@pickforge/lab-core";

/**
 * Fixed, documented askpass helper probe list per the locked v1 contract —
 * checked in this order after a user-set `SUDO_ASKPASS`. No dynamic
 * discovery beyond this list; PickLab never ships, generates, or installs
 * its own askpass helper.
 */
export const ASKPASS_PROBE_PATHS: readonly string[] = [
  "/usr/bin/ksshaskpass",
  "/usr/bin/ssh-askpass",
  "/usr/bin/lxqt-openssh-askpass",
  "/usr/bin/ssh-askpass-gnome",
  "/usr/lib/ssh/ssh-askpass",
  "/usr/lib/openssh/gnome-ssh-askpass",
  "/usr/lib/seahorse/ssh-askpass",
];

/**
 * The result of the pre-flight capability check, run before any privileged
 * step materializes. Every state is distinct and observable per the
 * contract's failure semantics — callers must not collapse `no-helper` and
 * `headless` into one generic "unavailable".
 */
export type AskpassCapability =
  /** A graphical session and a resolvable helper were both found. `helper`
   * is the absolute path to hand to `SUDO_ASKPASS`. */
  | { state: "available"; helper: string }
  /** A graphical session was detected but no helper resolved: the user's
   * `SUDO_ASKPASS` (if set) doesn't point at an executable file, and
   * nothing on the fixed probe list exists either. */
  | { state: "no-helper" }
  /** No graphical session (`WAYLAND_DISPLAY`/`DISPLAY` both unset or empty
   * in the resolved environment) — SSH, a bare TTY, or headless CI. */
  | { state: "headless" }
  /** This platform is out of scope for the locked v1 contract
   * (macOS/Windows). Never `available` here — the feature is a documented
   * no-op, not a half-implementation. */
  | { state: "unsupported-platform" };

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/**
 * Resolve capability from an already-resolved environment (the caller must
 * pass the environment the privileged command will actually inherit — see
 * `resolveAskpassCapability`). Pure aside from the injected `isExecutable`
 * probe, so every branch is directly testable without a real graphical
 * session or real helper binaries on disk.
 */
export function detectAskpassCapability(
  env: EnvLike,
  isExecutable: (path: string) => boolean,
): AskpassCapability {
  const graphical = nonEmpty(env.WAYLAND_DISPLAY) || nonEmpty(env.DISPLAY);
  if (!graphical) {
    return { state: "headless" };
  }

  // (1) user-set SUDO_ASKPASS, only if it points to an executable file.
  const userSet = env.SUDO_ASKPASS;
  if (nonEmpty(userSet) && isExecutable(userSet)) {
    return { state: "available", helper: userSet };
  }

  // (2) first existing helper from the fixed probe list. No dynamic
  // discovery beyond this list.
  for (const candidate of ASKPASS_PROBE_PATHS) {
    if (isExecutable(candidate)) {
      return { state: "available", helper: candidate };
    }
  }

  return { state: "no-helper" };
}

function isExecutableFile(target: string): boolean {
  try {
    const stat = fs.statSync(target);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the current process's askpass capability. Gated to Linux per the
 * locked v1 contract's scope — macOS/Windows are always
 * `unsupported-platform`, never a half-implementation.
 *
 * Unlike PickForge's long-lived desktop process (which caches this once per
 * process lifetime), the PickLab CLI is a short one-shot invocation that
 * re-execs per command, so there is no stale-cache risk to guard against
 * here: detection simply re-runs, cheaply, against the current environment
 * each time a provisioning command resolves it.
 */
export function resolveAskpassCapability(
  env: EnvLike = process.env,
): AskpassCapability {
  if (process.platform !== "linux") {
    return { state: "unsupported-platform" };
  }
  return detectAskpassCapability(env, isExecutableFile);
}

/**
 * A human-actionable message for every non-available state. Always includes
 * the manual fallback the locked v1 contract requires: run the privileged
 * command yourself, in a terminal, with sudo — never an automatic fallback
 * to interactive password capture.
 */
export function askpassUnavailableMessage(
  capability: Exclude<AskpassCapability, { state: "available" }>,
  manualCommand: string,
): string {
  const fallback = `Run it yourself in a terminal: ${manualCommand}`;
  switch (capability.state) {
    case "headless":
      return (
        "No graphical session detected (WAYLAND_DISPLAY and DISPLAY are " +
        `both unset); graphical sudo prompts require one. ${fallback}`
      );
    case "no-helper":
      return (
        "No SUDO_ASKPASS helper found (checked your SUDO_ASKPASS and the " +
        `standard probe list: ${ASKPASS_PROBE_PATHS.join(", ")}). Install ` +
        `one (e.g. ssh-askpass) or set SUDO_ASKPASS to point at one. ${fallback}`
      );
    case "unsupported-platform":
      return (
        "Graphical sudo prompts are only supported on Linux in this " +
        `release (detected ${process.platform}). ${fallback}`
      );
  }
}
