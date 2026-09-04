import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REAPER_CLEANUP_PENDING_META_KEY,
  destroySessionRecord,
  listSessions,
  type EnvLike,
} from "@pickforge/lab-core";

// Pids high enough that nothing on the host holds them, so teardown of the
// fakes resolves as "already dead" rather than touching a real process.
const XVFB_PID = 4_194_302;
const VNC_PID = 4_194_303;

vi.mock("../src/display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/display.js")>();
  return {
    ...actual,
    startXvfb: vi.fn(async () => ({
      display: ":241",
      pid: XVFB_PID,
      startTimeTicks: 321,
      logPath: "/tmp/fake-xvfb.log",
      width: 1280,
      height: 800,
    })),
  };
});

vi.mock("../src/vnc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vnc.js")>();
  return {
    ...actual,
    detectVncBinary: vi.fn(() => "/usr/bin/x11vnc"),
    startVnc: vi.fn(async () => {
      throw new actual.VncStartError(
        "timeout",
        "fake x11vnc cleanup could not be confirmed",
        {
          pid: VNC_PID,
          startTimeTicks: 654,
          port: 5_941,
          logPath: "/tmp/fake-x11vnc.log",
          cleanupConfirmed: false,
        },
      );
    }),
  };
});

import { createDesktopSession } from "../src/session.js";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("desktop create rollback after a failed VNC startup", () => {
  it("keeps the runtime dir and the VNC identity when its cleanup is unconfirmed", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-vnc-rollback-"));
    const env: EnvLike = {
      ...process.env,
      PICKFORGE_HOME: path.join(root, "home"),
    };

    await expect(
      createDesktopSession({
        projectDir: path.join(root, "project"),
        registryEnv: env,
        env,
        vnc: true,
      }),
    ).rejects.toThrow("fake x11vnc cleanup could not be confirmed");

    const records = await listSessions(env);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({
      status: "error",
      desktop: {
        xvfbPid: XVFB_PID,
        vncPid: VNC_PID,
        vncStartTimeTicks: 654,
      },
      meta: { [REAPER_CLEANUP_PENDING_META_KEY]: true },
    });
    // The runtime dir may still be in use by the server that would not die.
    const runtimeDir = record.desktop?.runtimeDir;
    expect(runtimeDir).toBeDefined();
    expect(fs.existsSync(runtimeDir as string)).toBe(true);

    await destroySessionRecord(record.id, env);
  }, 30_000);
});
