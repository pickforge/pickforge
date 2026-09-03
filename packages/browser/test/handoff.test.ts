import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const handoff = vi.hoisted(() => ({
  mode: "pass" as "pass" | "fail" | "destroy",
  pid: undefined as number | undefined,
}));

vi.mock("@pickforge/lab-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pickforge/lab-core")>();
  const updateSession: typeof actual.updateSession = async (id, patch, env) => {
    if (patch.desktop !== undefined && patch.status === undefined) {
      handoff.pid = patch.desktop.xvfbPid;
      if (handoff.mode === "fail") {
        await actual.updateSession(id, patch, env);
        throw new Error("registry write acknowledgement failed");
      }
      if (handoff.mode === "destroy") {
        await actual.destroySessionRecord(id, env);
      }
    }
    return actual.updateSession(id, patch, env);
  };
  return { ...actual, updateSession };
});

import {
  getSession,
  isPidAlive,
  listSessions,
  type EnvLike,
} from "@pickforge/lab-core";
import { createBrowserSession } from "../src/session.js";
import { writeFakeChrome } from "./fakes.js";

let root: string | undefined;

afterEach(() => {
  handoff.mode = "pass";
  handoff.pid = undefined;
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function makeEnv(): EnvLike {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-handoff-"));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeFakeChrome(binDir, "ready");
  fs.writeFileSync(
    path.join(binDir, "Xvfb"),
    ["#!/usr/bin/env node", "setInterval(() => {}, 1000);"].join("\n"),
    { mode: 0o755 },
  );
  return {
    ...process.env,
    HOME: path.join(root, "home"),
    PICKLAB_HOME: path.join(root, "pickforge-home"),
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

async function expectOwnedXvfbGone(): Promise<void> {
  expect(handoff.pid).toBeGreaterThan(0);
  const deadline = Date.now() + 2000;
  while (isPidAlive(handoff.pid ?? -1) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(isPidAlive(handoff.pid ?? -1)).toBe(false);
}

describe("browser Xvfb ownership handoff", () => {
  it("tears down the owned child and clears persisted legs when the handoff update fails", async () => {
    const env = makeEnv();
    handoff.mode = "fail";
    await expect(
      createBrowserSession({
        projectDir: path.join(root!, "project"),
        registryEnv: env,
        env,
      }),
    ).rejects.toThrow("Xvfb ownership handoff failed");
    await expectOwnedXvfbGone();

    const records = await listSessions(env);
    expect(records).toHaveLength(1);
    const record = await getSession(records[0]!.id, env);
    expect(record).toMatchObject({ status: "error" });
    expect(record?.desktop).toBeUndefined();
    expect(record?.browser).toBeUndefined();
    expect(record?.meta?.reaperCleanupPending).toBeUndefined();
  });

  it("tears down the owned child when destroy wins the handoff race", async () => {
    const env = makeEnv();
    handoff.mode = "destroy";
    await expect(
      createBrowserSession({
        projectDir: path.join(root!, "project"),
        registryEnv: env,
        env,
      }),
    ).rejects.toThrow("Xvfb ownership handoff failed");
    await expectOwnedXvfbGone();
    expect(await listSessions(env)).toEqual([]);
  });
});
