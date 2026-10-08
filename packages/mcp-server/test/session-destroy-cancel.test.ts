import { spawn } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, getSession } from "@pickforge/lab-core";
import { withSessionVncLock } from "@pickforge/lab-desktop-linux";
import {
  connectLab,
  makeFakeAndroidSdk,
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

  it("starts no later teardown after an all=true request is cancelled", async () => {
    await lab.close();
    const { sdk, avdHome, pidFile } = makeFakeAndroidSdk(dirs.root);
    lab = await connectLab({
      projectDir: dirs.projectDir,
      env: { ...registryEnv, ANDROID_HOME: sdk, ANDROID_AVD_HOME: avdHome },
    });
    const emulator = spawn("sleep", ["120"], { stdio: "ignore" });
    const emulatorPid = emulator.pid!;
    // The fake adb `emu kill` stops the pid recorded here.
    fs.writeFileSync(pidFile, `${emulatorPid}\n`);
    try {
      const desktop = await createSession(
        {
          type: "desktop",
          status: "running",
          projectDir: dirs.projectDir,
          desktop: { display: ":992" },
        },
        registryEnv,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      const android = await createSession(
        {
          type: "android",
          status: "running",
          projectDir: dirs.projectDir,
          android: {
            avdName: "pickforge-avd",
            serial: "emulator-5590",
            consolePort: 5590,
            emulatorPid,
          },
        },
        registryEnv,
      );
      let release: (() => void) | undefined;
      let acquired = false;
      const held = withSessionVncLock(
        desktop.id,
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
        { name: "session_destroy", arguments: { all: true } },
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 100);
      await expect(destroying).rejects.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await getSession(android.id, registryEnv)).toMatchObject({
        status: "running",
      });
      expect(() => process.kill(emulatorPid, 0)).not.toThrow();
      release?.();
      await held;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await getSession(desktop.id, registryEnv)).toMatchObject({
        status: "running",
      });

      const destroyed = parseToolJson(
        await lab.client.callTool({
          name: "session_destroy",
          arguments: { sessionId: android.id },
        }),
      );
      expect(destroyed.ok, JSON.stringify(destroyed.errors)).toBe(true);
      expect(destroyed.destroyed).toEqual([android.id]);
      expect(await getSession(android.id, registryEnv)).toBeUndefined();
      await expect.poll(() => emulator.exitCode ?? emulator.signalCode).not.toBeNull();
    } finally {
      emulator.kill("SIGKILL");
    }
  }, 20_000);
});
