import type { EnvLike } from "@pickforge/lab-core";

/**
 * Close a browser session's CDP Chrome and open the same profile as a plain
 * Chrome with no remote debugging, so a person can sign in (#380). Resolves
 * false when the session is not a browser session.
 */
export async function enterPlainBrowser(_sessionId: string, _env: EnvLike): Promise<boolean> {
  throw new Error("enterPlainBrowser is not implemented yet");
}

/**
 * Close the plain Chrome and reopen the profile under CDP with its last tabs.
 * Resolves false when the session is not a browser session.
 */
export async function restoreCdpBrowser(_sessionId: string, _env: EnvLike): Promise<boolean> {
  throw new Error("restoreCdpBrowser is not implemented yet");
}
