import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@pickforge/lab-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pickforge/lab-core")>();
  return { ...actual, readProcessIdentity: vi.fn(() => undefined) };
});

import { isPidAlive, type EnvLike } from "@pickforge/lab-core";
import { startXvfb, XvfbStartError } from "../src/display.js";

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

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Xvfb identity capture", () => {
  it("reaps the still-owned child instead of handing off an unverifiable PID", async () => {
    const onSpawn = vi.fn();
    const error = await startXvfb({
      display: ":242",
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
