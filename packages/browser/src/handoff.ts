import {
  getSession,
  processIdentityMatches,
  type EnvLike,
} from "@pickforge/lab-core";
import { requestCdpSupervisorMode, type CdpEndpoint, type CdpSupervisorMode } from "./devtools.js";
import { readBrowserSessionCdpEndpoint } from "./session.js";
import { sleep } from "./util.js";

/** The supervisor answers once it switched; the file is checked right after. */
const MODE_PUBLISH_TIMEOUT_MS = 5_000;

/**
 * The supervisor's endpoint of a running browser session whose supervisor is
 * still alive, or undefined for any other session.
 */
async function runningBrowserEndpoint(sessionId: string, env: EnvLike): Promise<CdpEndpoint | undefined> {
  const record = await getSession(sessionId, env);
  const browser = record?.browser;
  if (record?.type !== "browser" || record.status !== "running" || browser === undefined) return undefined;
  if (!processIdentityMatches({ pid: browser.browserPid, startTicks: browser.browserStartTimeTicks })) {
    return undefined;
  }
  return readBrowserSessionCdpEndpoint(sessionId, env);
}

async function waitForPublishedMode(
  sessionId: string,
  env: EnvLike,
  accepted: readonly CdpSupervisorMode[],
): Promise<void> {
  const deadline = Date.now() + MODE_PUBLISH_TIMEOUT_MS;
  for (;;) {
    const mode = (await readBrowserSessionCdpEndpoint(sessionId, env))?.mode;
    if (mode !== undefined && accepted.includes(mode)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Browser session ${sessionId} did not publish mode ${accepted.join(" or ")}; it shows ${mode ?? "no endpoint"}`);
    }
    await sleep(50);
  }
}

/**
 * Close a browser session's CDP Chrome and open the same profile as a plain
 * Chrome with no remote debugging, so a person can sign in (#380). Resolves
 * false when the session is not a running browser session. Throws when the
 * plain Chrome did not start; the supervisor then reopened it under CDP.
 */
export async function enterPlainBrowser(sessionId: string, env: EnvLike): Promise<boolean> {
  const endpoint = await runningBrowserEndpoint(sessionId, env);
  if (endpoint === undefined) return false;
  await requestCdpSupervisorMode(endpoint.socketPath, "plain");
  await waitForPublishedMode(sessionId, env, ["plain", "plain-idle"]);
  return true;
}

/**
 * Close the plain Chrome and reopen the profile under CDP with its last tabs.
 * Resolves false when the session is not a browser session, or no longer
 * runs, even if it ended during the switch.
 */
export async function restoreCdpBrowser(sessionId: string, env: EnvLike): Promise<boolean> {
  const endpoint = await runningBrowserEndpoint(sessionId, env);
  if (endpoint === undefined) return false;
  try {
    await requestCdpSupervisorMode(endpoint.socketPath, "cdp");
    await waitForPublishedMode(sessionId, env, ["cdp"]);
    return true;
  } catch (error) {
    if (await runningBrowserEndpoint(sessionId, env).catch(() => undefined) === undefined) return false;
    throw error;
  }
}
