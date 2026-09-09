import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REAPER_CLEANUP_PENDING_META_KEY,
  destroySessionRecord,
  listSessions,
  sessionDataDir,
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
import { startXvfb, XvfbStartError } from "../src/display.js";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("desktop partial startup ownership", () => {
  it("keeps failed-start logs and the failure record after confirmed cleanup", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-desktop-failed-"));
    const env: EnvLike = { PICKFORGE_HOME: path.join(root, "home") };
    vi.mocked(startXvfb).mockImplementationOnce(async (opts) => {
      fs.mkdirSync(opts.logDir, { recursive: true });
      const logPath = path.join(opts.logDir, "xvfb.log");
      fs.writeFileSync(logPath, "Xvfb failed to start");
      throw new XvfbStartError("timeout", "Xvfb failed to start", {
        display: ":240", pid: PARTIAL_PID, startTimeTicks: 123,
        logPath, width: 1280, height: 800, cleanupConfirmed: true,
      });
    });
    await expect(createDesktopSession({ projectDir: root, registryEnv: env, env })).rejects.toThrow("Xvfb failed to start");
    const records = await listSessions(env);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "error" });
    expect(records[0]?.meta?.[REAPER_CLEANUP_PENDING_META_KEY]).toBeUndefined();
    const dir = sessionDataDir(records[0]!.id, env);
    expect(fs.readFileSync(path.join(dir, "xvfb.log"), "utf8")).toBe("Xvfb failed to start");
    expect(fs.existsSync(path.join(dir, "runtime"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "permits"))).toBe(false);
  });

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
