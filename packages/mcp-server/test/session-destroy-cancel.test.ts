import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, getSession } from "@pickforge/lab-core";
import { withSessionVncLock } from "@pickforge/lab-desktop-linux";
import {
  connectLab,
  makeLabDirs,
  parseToolJson,
  removeLabDirs,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

describe("session_destroy cancellation", () => {
  let dirs: LabDirs;
  let lab: ConnectedLab;
  let registryEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    dirs = makeLabDirs();
    registryEnv = { ...process.env, PICKFORGE_HOME: dirs.home };
    lab = await connectLab({ projectDir: dirs.projectDir, env: registryEnv });
  });

  afterEach(async () => {
    await lab.close();
    removeLabDirs(dirs);
  });

  it("stops waiting for a held VNC lock and keeps the session when the request is cancelled", async () => {
    const { id } = await createSession(
      {
        type: "desktop",
        status: "running",
        projectDir: dirs.projectDir,
        desktop: { display: ":991" },
      },
      registryEnv,
    );
    let release: (() => void) | undefined;
    let acquired = false;
    const held = withSessionVncLock(
      id,
      registryEnv,
      () =>
        new Promise<void>((resolve) => {
          acquired = true;
          release = resolve;
        }),
    );
    await expect.poll(() => acquired).toBe(true);

    const controller = new AbortController();
    const destroying = lab.client.callTool(
      { name: "session_destroy", arguments: { sessionId: id } },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    await expect(destroying).rejects.toThrow();

    // The server must drop its queued teardown: once the holder releases, the
    // session stays intact and the lock is free for the next caller.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release?.();
    await held;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await getSession(id, registryEnv)).toMatchObject({
      status: "running",
    });
    expect(
      await withSessionVncLock(id, registryEnv, async () => "free"),
    ).toBe("free");

    const destroyed = parseToolJson(
      await lab.client.callTool({
        name: "session_destroy",
        arguments: { sessionId: id },
      }),
    );
    expect(destroyed.ok, JSON.stringify(destroyed.errors)).toBe(true);
    expect(destroyed.destroyed).toEqual([id]);
    expect(await getSession(id, registryEnv)).toBeUndefined();
  });
});
