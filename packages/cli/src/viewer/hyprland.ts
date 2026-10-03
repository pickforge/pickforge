import type { ViewerLaunchRecord } from "@pickforge/lab-desktop-linux";
import type { ViewerWindowMode } from "./contract.js";

/**
 * Hyprland adapter for the passive viewer window (pickforge/pickforge#207).
 *
 * SKELETON: the signature is the contract between workers. The body is owned
 * by the viewer worker.
 */

/**
 * Resize and place this launch's window for `mode` through the compositor.
 * Resolves true when applied, false when the launch has no Hyprland context
 * or the window cannot be verified. Never throws for an absent window.
 */
export async function applyHyprlandWindowMode(
  launch: ViewerLaunchRecord,
  mode: ViewerWindowMode,
): Promise<boolean> {
  void launch;
  void mode;
  return false;
}
