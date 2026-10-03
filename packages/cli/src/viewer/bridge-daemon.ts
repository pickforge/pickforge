/**
 * Start or reuse the per-session viewer bridge daemon (pickforge/pickforge#207).
 *
 * SKELETON: the signature is the contract between workers. The body is owned
 * by the security-core worker.
 */

export interface EnsuredViewerBridge {
  pid: number;
  /** Ephemeral loopback port the bridge listens on. */
  port: number;
  /** Capability token for this bridge. Never log it. */
  token: string;
  reused: boolean;
}

export interface EnsureViewerBridgeOptions {
  registryEnv?: NodeJS.ProcessEnv;
}

/**
 * Return a live, identity-verified bridge for the session, starting a detached
 * one when none is running. The bridge survives this process, stops on
 * session teardown and exits on its own when idle or when the session ends.
 */
export async function ensureViewerBridge(
  sessionId: string,
  opts: EnsureViewerBridgeOptions = {},
): Promise<EnsuredViewerBridge> {
  void sessionId;
  void opts;
  throw new Error("ensureViewerBridge is not implemented yet");
}
