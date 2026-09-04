import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireHumanLease,
  createSession,
  releaseHumanLease,
  type EnvLike,
} from "@pickforge/picklab-core";
import {
  runDesktopClick,
  runDesktopExec,
  runDesktopLaunch,
  runDesktopScreenshot,
  runDesktopType,
  runDesktopKey,
} from "../src/commands/desktop.js";

let root: string;
let env: EnvLike;
let logs: string[];

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "picklab-desktop-takeover-"));
  env = { PICKLAB_HOME: path.join(root, "home") };
  process.env.PICKLAB_HOME = env.PICKLAB_HOME;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logs.push(line);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.PICKLAB_HOME;
  process.exitCode = 0;
  await fs.promises.rm(root, { recursive: true, force: true });
});

function lastReport(): Record<string, any> {
  return JSON.parse(logs[logs.length - 1]) as Record<string, any>;
}

async function createDesktop(): Promise<string> {
  const record = await createSession(
    { type: "desktop", projectDir: root, status: "running", desktop: { display: ":42" } },
    env,
  );
  return record.id;
}

describe("desktop input commands fail closed under human control", () => {
  it("rejects click, type, and key without ever touching xdotool", async () => {
    const id = await createDesktop();
    const lease = await acquireHumanLease(id, env);

    expect(await runDesktopClick("1", "1", { session: id, projectDir: root, json: true })).toBe(
      1,
    );
    expect(lastReport().errors[0]).toContain("human control is active");

    expect(
      await runDesktopType("hello", { session: id, projectDir: root, json: true }),
    ).toBe(1);
    expect(lastReport().errors[0]).toContain("human control is active");

    expect(
      await runDesktopKey("Return", { session: id, projectDir: root, json: true }),
    ).toBe(1);
    expect(lastReport().errors[0]).toContain("human control is active");

    await releaseHumanLease(id, lease.leaseId, env);
  });

  it("rejects desktop launch and exec while a client could grab focus", async () => {
    const id = await createDesktop();
    const lease = await acquireHumanLease(id, env);

    expect(
      await runDesktopLaunch("xterm", [], { session: id, projectDir: root, json: true }),
    ).toBe(1);
    expect(lastReport().errors[0]).toContain("human control is active");

    expect(
      await runDesktopExec("xterm", [], {
        session: id,
        projectDir: root,
        json: true,
      }),
    ).toBe(1);
    expect(lastReport().errors[0]).toContain("human control is active");

    await releaseHumanLease(id, lease.leaseId, env);
  });

  it("does not gate desktop screenshot (read-only)", async () => {
    const id = await createDesktop();
    const lease = await acquireHumanLease(id, env);

    await runDesktopScreenshot({ session: id, projectDir: root, json: true });
    // Fails only for lack of a real display/screenshot tool in this
    // environment, never because of the human lease.
    expect(lastReport().errors.join("\n")).not.toContain("human control is active");

    await releaseHumanLease(id, lease.leaseId, env);
  });
});
