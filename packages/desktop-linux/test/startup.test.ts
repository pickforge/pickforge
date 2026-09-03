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

const PARTIAL_PID = 4_194_301;

vi.mock("../src/display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/display.js")>();
  return {
    ...actual,
    startXvfb: vi.fn(async () => {
      throw new actual.XvfbStartError(
        "timeout",
        "fake Xvfb cleanup could not be confirmed",
        {
          display: ":240",
          pid: PARTIAL_PID,
          startTimeTicks: 123,
          logPath: "/tmp/fake-xvfb.log",
          width: 1280,
          height: 800,
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

describe("desktop partial startup ownership", () => {
  it("persists a retryable error record when Xvfb cleanup is unconfirmed", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-desktop-startup-"));
    const env: EnvLike = {
      ...process.env,
      PICKFORGE_HOME: path.join(root, "home"),
    };
    await expect(
      createDesktopSession({
        projectDir: path.join(root, "project"),
        registryEnv: env,
        env,
      }),
    ).rejects.toThrow("fake Xvfb cleanup could not be confirmed");

    const records = await listSessions(env);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "desktop",
      status: "error",
      desktop: {
        display: ":240",
        xvfbPid: PARTIAL_PID,
        xvfbStartTimeTicks: 123,
      },
      meta: { [REAPER_CLEANUP_PENDING_META_KEY]: true },
    });
    await destroySessionRecord(records[0]!.id, env);
  });
});
