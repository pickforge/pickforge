import { expect, it } from "vitest";
import { runCommand, stopProcessGroupVerified } from "@pickforge/lab-core";
import { parseProcStat } from "../../core/src/proc.js";
import { WAIT_SUBPROCESS_KILL_GRACE_MS } from "../src/wait.js";

it("allows both default timeout stages when an owned detached child retains pipes", async () => {
  const script = [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 12000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
    'console.log(JSON.stringify({ pid: gc.pid, stat: fs.readFileSync(`/proc/${gc.pid}/stat`, "utf8") }));',
    'gc.unref(); setTimeout(() => {}, 12000);',
  ].join("\n");
  const started = Date.now();
  const result = await runCommand(process.execPath, ["-e", script], { timeoutMs: 500 });
  const elapsed = Date.now() - started;
  const owned = JSON.parse(result.stdout.trim()) as { pid: number; stat: string };
  const identity = parseProcStat(owned.stat)!;
  try {
    expect(result.timedOut).toBe(true);
    expect(WAIT_SUBPROCESS_KILL_GRACE_MS).toBe(4000);
    // The detached child holds inherited pipes past both the TERM and KILL stages.
    expect(elapsed).toBeGreaterThanOrEqual(4400);
    expect(elapsed).toBeLessThan(8500);
  } finally {
    await stopProcessGroupVerified({ pid: owned.pid, startTicks: identity.startTicks }, { timeoutMs: 500 });
  }
}, 10_000);
