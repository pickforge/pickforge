import {
  getSession,
  processIdentityMatches,
  type EnvLike,
  type SessionRecord,
} from "@pickforge/lab-core";
import { requestCdpSupervisorMode, type CdpEndpoint, type CdpSupervisorMode } from "./devtools.js";
import { readBrowserSessionCdpEndpoint } from "./session.js";
import { sleep } from "./util.js";

/** The supervisor answers once it switched; the file is checked right after. */
const MODE_PUBLISH_TIMEOUT_MS = 5_000;

/** The record of a browser session that its registry says is running. */
async function runningBrowserRecord(sessionId: string, env: EnvLike): Promise<SessionRecord | undefined> {
  const record = await getSession(sessionId, env);
  return record?.type === "browser" && record.status === "running" && record.browser !== undefined
    ? record
    : undefined;
}

/** The endpoint of a running session's supervisor, or undefined when the supervisor is gone. */
async function liveSupervisorEndpoint(record: SessionRecord, env: EnvLike): Promise<CdpEndpoint | undefined> {
  const browser = record.browser;
  if (browser === undefined) return undefined;
  if (!processIdentityMatches({ pid: browser.browserPid, startTicks: browser.browserStartTimeTicks })) {
    return undefined;
  }
  return readBrowserSessionCdpEndpoint(record.id, env);
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
  const record = await runningBrowserRecord(sessionId, env);
  const endpoint = record === undefined ? undefined : await liveSupervisorEndpoint(record, env);
  if (endpoint === undefined) return false;
  await requestCdpSupervisorMode(endpoint.socketPath, "plain");
  await waitForPublishedMode(sessionId, env, ["plain", "plain-idle"]);
  return true;
}

/**
 * Close the plain Chrome and reopen the profile under CDP with its last tabs.
 * Resolves false when the session is not a browser session, or its record no
 * longer says running, even if it ended during the switch. Throws while the
 * record says running but the supervisor is gone or the switch failed.
 */
export async function restoreCdpBrowser(sessionId: string, env: EnvLike): Promise<boolean> {
  const record = await runningBrowserRecord(sessionId, env);
  if (record === undefined) return false;
  try {
    const endpoint = await liveSupervisorEndpoint(record, env);
    if (endpoint === undefined) throw new Error(`The browser supervisor of session ${sessionId} is gone`);
    await requestCdpSupervisorMode(endpoint.socketPath, "cdp");
    await waitForPublishedMode(sessionId, env, ["cdp"]);
    return true;
  } catch (error) {
    // A failed registry read proves nothing; report the switch's own failure.
    const running = await runningBrowserRecord(sessionId, env).then((current) => current !== undefined, () => true);
    if (!running) return false;
    throw error;
  }
}
