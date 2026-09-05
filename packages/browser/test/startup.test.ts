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

const PARTIAL_PID = 4_194_302;

vi.mock("@pickforge/lab-desktop-linux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pickforge/lab-desktop-linux")>();
  return {
    ...actual,
    startXvfb: vi.fn(async () => {
      throw new actual.XvfbStartError(
        "timeout",
        "fake browser Xvfb cleanup could not be confirmed",
        {
          display: ":241",
          pid: PARTIAL_PID,
          startTimeTicks: 456,
          logPath: "/tmp/fake-browser-xvfb.log",
          width: 1280,
          height: 800,
          cleanupConfirmed: false,
        },
      );
    }),
  };
});

import { browserRuntimeLayout } from "../src/env.js";
import { createBrowserSession, removeChromeTmpAlias } from "../src/session.js";
import { writeFakeChrome } from "./fakes.js";

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) {
    // These cases deliberately leave the session runtime behind for a reaper
    // retry, which includes Chrome's /tmp alias into it. Remove the alias
    // before the temp root goes, or it would dangle in /tmp after the test.
    const sessionsDir = path.join(root, "pickforge-home", "sessions");
    for (const entry of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []) {
      if (fs.statSync(path.join(sessionsDir, entry)).isDirectory()) {
        await removeChromeTmpAlias(browserRuntimeLayout(path.join(sessionsDir, entry)));
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  root = undefined;
});

describe("browser partial startup ownership", () => {
  it("persists identity and runtime for an unconfirmed Xvfb cleanup", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-browser-startup-"));
    const home = path.join(root, "home");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(home, { recursive: true });
    writeFakeChrome(binDir, "ready");
    const env: EnvLike = {
      ...process.env,
      HOME: home,
      PICKFORGE_HOME: path.join(root, "pickforge-home"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    };

    await expect(
      createBrowserSession({
        projectDir: path.join(root, "project"),
        registryEnv: env,
        env,
      }),
    ).rejects.toThrow("fake browser Xvfb cleanup could not be confirmed");

    const records = await listSessions(env);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({
      type: "browser",
      status: "error",
      desktop: {
        display: ":241",
        xvfbPid: PARTIAL_PID,
        xvfbStartTimeTicks: 456,
      },
      meta: { [REAPER_CLEANUP_PENDING_META_KEY]: true },
    });
    expect(record.browser).toBeUndefined();
    expect(
      fs.existsSync(path.join(env.PICKFORGE_HOME!, "sessions", record.id, "profile")),
    ).toBe(true);
    await destroySessionRecord(record.id, env);
  });
});
