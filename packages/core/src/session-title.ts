import { withSessionVncLock } from "./session-lock.js";
import { updateSession, type SessionRecord } from "./session.js";
import type { EnvLike } from "./env-compat.js";

/**
 * Longest session title in characters. The title names the activity for the
 * person watching, so it must fit one line of a 384 px thumbnail.
 */
export const SESSION_TITLE_MAX_CHARS = 80;

/** Control, format, bidi and line or paragraph separator characters. */
export const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Turns whitespace into spaces, removes hidden characters, folds space runs, and trims. */
export function sanitizeSessionTitle(raw: string): string {
  return raw.replace(/\s/gu, " ").replace(HIDDEN_CHARACTERS, "").replace(/ {2,}/gu, " ").trim();
}

/**
 * The title to store, or undefined to clear it. An empty title clears.
 * A title longer than the cap is refused, so the agent writes a shorter one.
 */
export function parseSessionTitle(raw: string): string | undefined {
  const title = sanitizeSessionTitle(raw);
  if (title === "") return undefined;
  if ([...title].length > SESSION_TITLE_MAX_CHARS) {
    throw new Error(`Session title must be at most ${SESSION_TITLE_MAX_CHARS} characters`);
  }
  return title;
}

/**
 * Sets or clears the title of one session. The VNC lock keeps the write from
 * racing a status change by teardown.
 */
export async function setSessionTitle(
  id: string,
  raw: string,
  env: EnvLike = process.env,
): Promise<SessionRecord> {
  const title = parseSessionTitle(raw);
  return withSessionVncLock(id, env, () => updateSession(id, { title }, env));
}
