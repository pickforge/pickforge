import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../src/session.js";
import { withSessionVncLock } from "../src/session-lock.js";

let home: string;
let env: { PICKFORGE_HOME: string };
let sessionId: string;
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-session-lock-"));
  env = { PICKFORGE_HOME: home };
  sessionId = (await createSession({ type: "desktop", status: "running", projectDir: home }, env)).id;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function lockPath(): string {
  return path.join(home, "sessions", `${sessionId}.ensure-vnc.lock`);
}

function holdLock(): { held: Promise<void>; release: () => void } {
  let release: (() => void) | undefined;
  const held = withSessionVncLock(
    sessionId,
    env,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  return { held, release: () => release?.() };
}

describe("session VNC lock", () => {
  it("keeps the shared lock file name and removes it on release", async () => {
    const seen = await withSessionVncLock(sessionId, env, async () => fs.existsSync(lockPath()));
    expect(seen).toBe(true);
    expect(fs.readdirSync(path.dirname(lockPath())).some((name) => name.startsWith(`${sessionId}.ensure-vnc.lock`))).toBe(false);
  });

  it("still runs a waiting operation with a live signal once the holder releases", async () => {
    const holder = holdLock();
    await vi.waitFor(() => expect(fs.existsSync(lockPath())).toBe(true));
    const controller = new AbortController();
    let ran = false;
    const waiting = withSessionVncLock(
      sessionId,
      env,
      async () => {
        ran = true;
        return "ran";
      },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ran).toBe(false);
    holder.release();
    await holder.held;
    expect(await waiting).toBe("ran");
  });

  it("skips the locked operation when the signal is already aborted", async () => {
    const operation = vi.fn(async () => {});
    await expect(
      withSessionVncLock(sessionId, env, operation, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/Cancelled while waiting for the VNC lock/);
    expect(operation).not.toHaveBeenCalled();
    expect(await withSessionVncLock(sessionId, env, async () => "free")).toBe("free");
  });
});
