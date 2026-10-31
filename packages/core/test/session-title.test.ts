import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession, getSession } from "../src/session.js";
import { localSessionStatusEntry } from "../src/session-lifecycle.js";
import {
  parseSessionTitle,
  sanitizeSessionTitle,
  SESSION_TITLE_MAX_CHARS,
  setSessionTitle,
} from "../src/session-title.js";

let home: string;
let env: { PICKFORGE_HOME: string };

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-title-"));
  env = { PICKFORGE_HOME: home };
});

afterEach(async () => {
  await fs.promises.rm(home, { recursive: true, force: true });
});

describe("session title", () => {
  it("removes hidden characters and folds whitespace", () => {
    expect(sanitizeSessionTitle("  Pickforge\u202e GitHub\u0007\n\tissues \u2028")).toBe("Pickforge GitHub issues");
  });

  it("clears on empty input and refuses an over-long title", () => {
    expect(parseSessionTitle("   \u200b ")).toBeUndefined();
    expect(parseSessionTitle("x".repeat(SESSION_TITLE_MAX_CHARS))).toHaveLength(SESSION_TITLE_MAX_CHARS);
    expect(() => parseSessionTitle("x".repeat(SESSION_TITLE_MAX_CHARS + 1))).toThrow(/at most 80/);
  });

  it("counts characters, not UTF-16 units", () => {
    const emoji = "\u{1F525}".repeat(SESSION_TITLE_MAX_CHARS);
    expect(parseSessionTitle(emoji)).toBe(emoji);
  });

  it("is stored at creation, updated, cleared and shown in status", async () => {
    const created = await createSession({ type: "desktop", projectDir: home, title: "YouTube analytics" }, env);
    expect(created.title).toBe("YouTube analytics");
    expect((await getSession(created.id, env))?.title).toBe("YouTube analytics");

    await setSessionTitle(created.id, " Pickforge  GitHub issues ", env);
    const updated = await getSession(created.id, env);
    expect(updated?.title).toBe("Pickforge GitHub issues");
    const runtime = {
      desktop: { status: async () => ({ xvfbAlive: false, vncAlive: false, displayAlive: false }) },
      browser: { status: async () => ({ alive: false, xvfbAlive: false, displayAlive: false }) },
      android: { status: async () => ({}) },
    } as unknown as Parameters<typeof localSessionStatusEntry>[1];
    expect((await localSessionStatusEntry(updated!, runtime)).title).toBe("Pickforge GitHub issues");

    await setSessionTitle(created.id, "", env);
    const cleared = await getSession(created.id, env);
    expect(cleared?.title).toBeUndefined();
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(home, "sessions", `${created.id}.json`), "utf8")))).not.toContain("title");
    expect((await localSessionStatusEntry(cleared!, runtime)).title).toBeUndefined();
  });

  it("refuses an unknown session", async () => {
    await expect(setSessionTitle("desk-abcdef12", "x", env)).rejects.toThrow(/not found/);
  });
});
