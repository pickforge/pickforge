import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@pickforge/lab-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pickforge/lab-core")>();
  return {
    ...actual,
    readProcessIdentity: vi.fn(actual.readProcessIdentity),
    stopProcessGroupVerified: vi.fn(actual.stopProcessGroupVerified),
  };
});

import {
  isPidAlive,
  readProcessIdentity,
  stopProcessGroupVerified,
  type EnvLike,
} from "@pickforge/lab-core";
import { startXvfb, XvfbStartError } from "../src/display.js";
import { unusedTestDisplay } from "./test-resources.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-xvfb-identity-"));
const binDir = path.join(root, "bin");
const pidFile = path.join(root, "xvfb.pid");
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(
  path.join(binDir, "Xvfb"),
  [
    "#!/usr/bin/env node",
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"),
  { mode: 0o755 },
);
const env: EnvLike = {
  ...process.env,
  PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
};

const strays: number[] = [];

afterEach(() => {
  vi.mocked(readProcessIdentity).mockRestore();
  vi.mocked(stopProcessGroupVerified).mockRestore();
  for (const pid of strays.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function failHandoff(): Promise<unknown> {
  return startXvfb({
    display: unusedTestDisplay(),
    logDir: path.join(root, "logs"),
    env,
    onSpawn: (partial) => {
      strays.push(partial.pid);
      throw new Error("handoff refused");
    },
  }).catch((caught: unknown) => caught);
}

describe("Xvfb identity capture", () => {
  it("reaps the still-owned child instead of handing off an unverifiable PID", async () => {
    vi.mocked(readProcessIdentity).mockImplementation(() => undefined);
    const onSpawn = vi.fn();
    const error = await startXvfb({
      display: unusedTestDisplay(),
      logDir: path.join(root, "logs"),
      env,
      onSpawn,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(XvfbStartError);
    expect(error).toMatchObject({ reason: "identity", partial: undefined });
    expect(onSpawn).not.toHaveBeenCalled();
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(isPidAlive(pid)).toBe(false);
  });
});

describe("Xvfb partial start cleanup", () => {
  it("confirms cleanup once the owned child exits", async () => {
    const error = await failHandoff();

    expect(error).toBeInstanceOf(XvfbStartError);
    expect(error).toMatchObject({
      reason: "handoff",
      partial: { cleanupConfirmed: true },
    });
    expect((error as Error).message).not.toContain("cleanup could not be verified");
    expect(isPidAlive(strays[0]!)).toBe(false);
  });

  it("does not confirm cleanup when the owned child outlives a reported stop", async () => {
    vi.mocked(stopProcessGroupVerified).mockResolvedValue({
      outcome: "terminated",
      signaled: true,
    });
    const started = Date.now();
    const error = await failHandoff();

    expect(error).toBeInstanceOf(XvfbStartError);
    expect(error).toMatchObject({
      reason: "handoff",
      partial: { cleanupConfirmed: false },
    });
    expect((error as Error).message).toContain("cleanup could not be verified");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    expect(isPidAlive(strays[0]!)).toBe(true);
  }, 10_000);
});
