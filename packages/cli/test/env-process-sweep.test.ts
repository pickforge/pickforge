import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "@pickforge/lab-core";
import { findProcessesWithEnv, killProcessesWithEnv } from "./env-process-sweep.js";

const NAME = "PICKFORGE_SWEEP_TEST";
const started: ChildProcess[] = [];

afterEach(() => {
  for (const child of started.splice(0)) child.kill("SIGKILL");
});

function startIdle(env: Record<string, string>, script = "setInterval(() => {}, 1000)"): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "ignore"],
  });
  started.push(child);
  return child;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("environment process sweep", () => {
  it("kills only processes that carry the exact entry", async () => {
    const value = `/tmp/pickforge-sweep-${randomUUID()}`;
    const target = startIdle({ [NAME]: value });
    const longer = startIdle({ [NAME]: `${value}-other` });
    const shorter = startIdle({ [NAME]: value.slice(0, -1) });
    const other = startIdle({ OTHER: value });
    // A spawned child shows its new environment only after exec.
    await waitUntil(() => findProcessesWithEnv(NAME, value).length === 1);
    expect(findProcessesWithEnv(NAME, value).map(({ pid }) => pid)).toEqual([target.pid]);

    const exited = once(target, "exit");
    const result = await killProcessesWithEnv(NAME, value, 2_000);
    await exited;

    expect(result).toEqual({ killed: [target.pid], survivors: [] });
    expect(target.signalCode).toBe("SIGKILL");
    for (const child of [longer, shorter, other]) {
      expect(child.exitCode).toBeNull();
      expect(isPidAlive(child.pid as number)).toBe(true);
    }
  });

  it("signals one pid at a time, not the process group", async () => {
    const value = `/tmp/pickforge-sweep-${randomUUID()}`;
    // The leader carries the entry; its child, in the same group, does not.
    const script = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
      '  env: { PATH: process.env.PATH }, stdio: "ignore",',
      "});",
      'process.stdout.write(String(child.pid) + "\\n");',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const leader = spawn(process.execPath, ["-e", script], {
      env: { PATH: process.env.PATH ?? "", [NAME]: value },
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    started.push(leader);
    const [line] = (await once(leader.stdout!, "data")) as [Buffer];
    const memberPid = Number(line.toString().trim());
    try {
      const exited = once(leader, "exit");
      const result = await killProcessesWithEnv(NAME, value, 2_000);
      await exited;

      expect(result).toEqual({ killed: [leader.pid], survivors: [] });
      expect(isPidAlive(memberPid)).toBe(true);
    } finally {
      try {
        process.kill(memberPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("refuses an empty value", () => {
    expect(() => findProcessesWithEnv(NAME, "")).toThrow(/needs a name and a value/);
  });
});
