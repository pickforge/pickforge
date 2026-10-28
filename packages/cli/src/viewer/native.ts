import { createRequire } from "node:module";
import { runCommand, type EnvLike } from "@pickforge/lab-core";
import { findOnPath } from "@pickforge/lab-desktop-linux";
import { hasGraphicalSession } from "./launch.js";

const require = createRequire(import.meta.url);
export const nativeViewerVersion = (() => {
  try { return (require("../package.json") as { version: string }).version; }
  catch { return (require("../../package.json") as { version: string }).version; }
})();

/** A mismatched standalone binary is unavailable, just like an npm-only install. */
export async function detectNativeViewer(env: EnvLike = process.env): Promise<string | null> {
  if (!hasGraphicalSession(env)) return null;
  const binary = findOnPath("pickforge-viewer", env);
  if (binary === null) return null;
  try {
    const result = await runCommand(binary, ["--version"], { env, cleanEnv: true, timeoutMs: 2_000, maxOutputBytes: 1024 });
    if (result.ok && !result.stdoutTruncated && result.stdout.trim() === `pickforge-viewer ${nativeViewerVersion}`) return binary;
  } catch { /* Use the existing browser fallback. */ }
  console.error("Native viewer version check failed; using the browser viewer");
  return null;
}
