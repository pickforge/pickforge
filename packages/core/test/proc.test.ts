import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isPidAlive,
  isProcessGroupAlive,
  listProcessGroupMembers,
  parseProcStat,
  processIdentityMatches,
  readProcessIdentity,
  readProcessStartTicks,
  runCommand,
  startDaemon,
  stopPid,
  stopProcessGroupVerified,
  type ProcessIdentity,
} from "../src/proc.js";

const node = process.execPath;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runCommand", () => {
  it("passes arguments verbatim without shell interpretation", async () => {
    const args = ["a b", ";", "$HOME", "`id`", "&& rm -rf /", "'quoted'"];
    const result = await runCommand(node, [
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1)))",
      ...args,
    ]);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it("captures nonzero exit without throwing by default", async () => {
    const result = await runCommand(node, [
      "-e",
      "console.error('boom'); process.exit(3)",
    ]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("boom");
  });

  it("throws on nonzero exit when check is set", async () => {
    await expect(
      runCommand(node, ["-e", "process.exit(2)"], { check: true }),
    ).rejects.toThrow(/exit/i);
  });

  it("kills the process on timeout", async () => {
    const start = Date.now();
    const result = await runCommand(
      node,
      ["-e", "setTimeout(() => {}, 30000)"],
      { timeoutMs: 400 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.code).not.toBe(0);
    expect(Date.now() - start).toBeLessThan(10000);
  });

  it("passes cwd and merges env over the inherited environment", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-"));
    const result = await runCommand(
      node,
      [
        "-e",
        "console.log(process.cwd(), process.env.PICKFORGE_TEST, typeof process.env.PATH)",
      ],
      { cwd: dir, env: { PICKFORGE_TEST: "yes" } },
    );
    expect(result.stdout).toContain("yes");
    expect(result.stdout).toContain("string");
    expect(result.stdout).toContain(await fs.promises.realpath(dir));
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("supports a clean environment via cleanEnv", async () => {
    const result = await runCommand(
      node,
      ["-e", "console.log(JSON.stringify(Object.keys(process.env)))"],
      { cleanEnv: true, env: { PICKFORGE_ONLY: "1" } },
    );
    expect(JSON.parse(result.stdout)).toEqual(["PICKFORGE_ONLY"]);
  });

  it("does not crash when the child exits before consuming stdin", async () => {
    const result = await runCommand(node, ["-e", "process.exit(7)"], {
      input: "x".repeat(8 * 1024 * 1024),
    });
    expect(result.code).toBe(7);
  });

  it("resolves promptly on timeout even when a grandchild holds stdio pipes", async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      'const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {',
      "  detached: true,",
      '  stdio: ["ignore", "inherit", "inherit"],',
      "});",
      "gc.unref();",
      "setTimeout(() => {}, 15000);",
    ].join("\n");
    const start = Date.now();
    const result = await runCommand(node, ["-e", script], {
      timeoutMs: 300,
      killGraceMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("reports output truncation", async () => {
    const result = await runCommand(
      node,
      ["-e", "process.stdout.write('a'.repeat(64 * 1024))"],
      { maxOutputBytes: 1024 },
    );
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
    expect(result.stdout.length).toBe(1024);
  });

  it("preserves binary stdout as a Buffer when binary is set", async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80];
    const result = await runCommand(
      node,
      ["-e", `process.stdout.write(Buffer.from([${bytes.join(",")}]))`],
      { binary: true },
    );
    expect(result.ok).toBe(true);
    expect(result.stdoutBuffer).toBeInstanceOf(Buffer);
    expect([...result.stdoutBuffer]).toEqual(bytes);
    expect(result.stdout).toBe("");
  });

  it("omits stdoutBuffer by default", async () => {
    const result = await runCommand(node, ["-e", "console.log('plain')"]);
    expect(result.stdoutBuffer).toBeUndefined();
    expect(result.stdout).toContain("plain");
  });

  it("formats CommandError messages for exit codes and signals", async () => {
    await expect(
      runCommand(node, ["-e", "process.exit(2)"], { check: true }),
    ).rejects.toThrow(/exited with code 2/);
    await expect(
      runCommand(node, ["-e", "setTimeout(() => {}, 30000)"], {
        check: true,
        timeoutMs: 200,
        killGraceMs: 200,
      }),
    ).rejects.toThrow(/(exited with code \d+|killed with signal SIG\w+)/);
  });
});

describe("daemon supervision", () => {
  let logDir: string;
  let pid: number | undefined;

  beforeEach(async () => {
    logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-log-"));
  });

  afterEach(async () => {
    if (pid !== undefined && isPidAlive(pid)) {
      await stopPid(pid, { timeoutMs: 1000 });
    }
    await fs.promises.rm(logDir, { recursive: true, force: true });
  });

  it("rejects catchably when the daemon binary does not exist", async () => {
    await expect(
      startDaemon("/nonexistent/pickforge-lab-missing-binary", [], { logDir }),
    ).rejects.toThrow(/ENOENT/);
  });

  it("starts a detached daemon, reports liveness, and stops it", async () => {
    const daemon = await startDaemon(
      node,
      ["-e", "console.log('daemon up'); setInterval(() => {}, 1000)"],
      { logDir, name: "test-daemon" },
    );
    pid = daemon.pid;
    expect(daemon.pid).toBeGreaterThan(0);
    expect(daemon.logPath.startsWith(logDir)).toBe(true);
    expect(fs.existsSync(daemon.logPath)).toBe(true);
    expect(isPidAlive(daemon.pid)).toBe(true);

    const stopped = await stopPid(daemon.pid, { timeoutMs: 3000 });
    expect(stopped).toBe(true);
    expect(isPidAlive(daemon.pid)).toBe(false);
  });

  it("isPidAlive returns false for a dead pid", async () => {
    const result = await runCommand(node, ["-e", "console.log(process.pid)"]);
    const deadPid = Number(result.stdout.trim());
    expect(isPidAlive(deadPid)).toBe(false);
  });

  it("stopPid is idempotent for already-dead pids", async () => {
    const result = await runCommand(node, ["-e", "console.log(process.pid)"]);
    const deadPid = Number(result.stdout.trim());
    expect(await stopPid(deadPid, { timeoutMs: 500 })).toBe(true);
  });
});

describe("process identity and group termination", () => {
  function procStat(
    pid: number,
    state: string,
    pgrp: number,
    startTicks: number,
  ): string {
    const fields = Array.from({ length: 20 }, () => "0");
    fields[0] = state;
    fields[2] = String(pgrp);
    fields[19] = String(startTicks);
    return `${pid} (browser) ${fields.join(" ")}`;
  }

  it("reads a live identity and returns undefined for a dead pid", async () => {
    const self = readProcessIdentity(process.pid);
    expect(self?.pid).toBe(process.pid);
    expect(typeof self?.startTicks).toBe("number");
    expect(self?.startTicks).toBeGreaterThan(0);

    const { stdout } = await runCommand(node, [
      "-e",
      "console.log(process.pid)",
    ]);
    const deadPid = Number(stdout.trim());
    expect(readProcessStartTicks(deadPid)).toBeUndefined();
    expect(readProcessIdentity(deadPid)).toBeUndefined();
  });

  it("parses process state so zombie group members can be ignored", () => {
    const fields = Array.from({ length: 20 }, () => "0");
    fields[0] = "Z";
    fields[2] = "123";
    fields[19] = "456";

    expect(parseProcStat(`123 (worker (test)) ${fields.join(" ")}`)).toEqual({
      state: "Z",
      pgrp: 123,
      startTicks: 456,
    });
  });

  it("treats a zombie process identity as dead", () => {
    const fields = Array.from({ length: 20 }, () => "0");
    fields[0] = "Z";
    fields[2] = "123";
    fields[19] = "456";
    const read = vi
      .spyOn(fs, "readFileSync")
      .mockReturnValue(`123 (browser) ${fields.join(" ")}`);
    try {
      expect(readProcessStartTicks(123)).toBeUndefined();
      expect(readProcessIdentity(123)).toBeUndefined();
    } finally {
      read.mockRestore();
    }
  });

  it("terminates a verified group whose matching leader is a zombie", async () => {
    const pid = 1_234_567;
    const memberPid = pid + 1;
    const startTicks = 456;
    let signaled = false;
    const read = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(((filePath: fs.PathOrFileDescriptor) => {
        if (signaled) {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        }
        return String(filePath).endsWith(`/${pid}/stat`)
          ? procStat(pid, "Z", pid, startTicks)
          : procStat(memberPid, "S", pid, startTicks + 1);
      }) as typeof fs.readFileSync);
    const entries = vi
      .spyOn(fs, "readdirSync")
      .mockReturnValue([String(memberPid)] as never);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      signaled = true;
      return true;
    });
    try {
      const result = await stopProcessGroupVerified(
        { pid, startTicks },
        { timeoutMs: 200 },
      );

      expect(result).toEqual({ outcome: "terminated", signaled: true });
      expect(kill.mock.calls).toEqual([[-pid, "SIGTERM"]]);
    } finally {
      kill.mockRestore();
      entries.mockRestore();
      read.mockRestore();
    }
  });

  it("matches a live identity and rejects a start-time mismatch", () => {
    const self = readProcessIdentity(process.pid);
    expect(self).toBeDefined();
    const identity = self as ProcessIdentity;
    expect(processIdentityMatches(identity)).toBe(true);
    // Same live pid, different start ticks => a reused pid, not our process.
    expect(
      processIdentityMatches({
        pid: identity.pid,
        startTicks: identity.startTicks + 1,
      }),
    ).toBe(false);
  });

  it("refuses to signal a live pid whose start identity no longer matches", async () => {
    const startTicks = readProcessStartTicks(process.pid) ?? 0;
    const result = await stopProcessGroupVerified(
      { pid: process.pid, startTicks: startTicks + 1 },
      { timeoutMs: 200 },
    );
    expect(result).toEqual({ outcome: "reused", signaled: false });
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("refuses to signal a matching pid that is not the group leader", async () => {
    const pid = 1_234_567;
    const startTicks = 456;
    const read = vi
      .spyOn(fs, "readFileSync")
      .mockReturnValue(procStat(pid, "S", pid + 1, startTicks));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const result = await stopProcessGroupVerified(
        { pid, startTicks },
        { timeoutMs: 200 },
      );

      expect(result).toEqual({ outcome: "reused", signaled: false });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      read.mockRestore();
    }
  });

  it("does not report termination while the recorded identity is still live", async () => {
    const pid = 1_234_567;
    const startTicks = 456;
    const read = vi
      .spyOn(fs, "readFileSync")
      .mockReturnValue(procStat(pid, "S", pid, startTicks));
    const entries = vi.spyOn(fs, "readdirSync").mockReturnValue([]);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.useFakeTimers();
    try {
      const pending = stopProcessGroupVerified(
        { pid, startTicks },
        { timeoutMs: 100 },
      );
      await vi.advanceTimersByTimeAsync(1_200);

      await expect(pending).resolves.toEqual({
        outcome: "survived",
        signaled: true,
      });
      expect(kill.mock.calls).toEqual([
        [-pid, "SIGTERM"],
        [-pid, "SIGKILL"],
      ]);
    } finally {
      vi.useRealTimers();
      kill.mockRestore();
      entries.mockRestore();
      read.mockRestore();
    }
  });

  it("refuses SIGKILL when the leader pid is reused after SIGTERM", async () => {
    const pid = 1_234_567;
    const startTicks = 456;
    const read = vi
      .spyOn(fs, "readFileSync")
      .mockReturnValueOnce(procStat(pid, "S", pid, startTicks))
      .mockReturnValue(procStat(pid, "S", pid, startTicks + 1));
    const entries = vi.spyOn(fs, "readdirSync").mockReturnValue([]);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const result = await stopProcessGroupVerified(
        { pid, startTicks },
        { timeoutMs: 0 },
      );

      expect(result).toEqual({ outcome: "reused", signaled: true });
      expect(kill.mock.calls).toEqual([[-pid, "SIGTERM"]]);
    } finally {
      kill.mockRestore();
      entries.mockRestore();
      read.mockRestore();
    }
  });
  it("escalates a verified group after its leader exits on SIGTERM", async () => {
    const pid = 1_234_567;
    const memberPid = pid + 1;
    const startTicks = 456;
    let termSent = false;
    let killed = false;
    const read = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(((filePath: fs.PathOrFileDescriptor) => {
        if (String(filePath).endsWith(`/${pid}/stat`)) {
          if (termSent) {
            throw Object.assign(new Error("gone"), { code: "ENOENT" });
          }
          return procStat(pid, "S", pid, startTicks);
        }
        return procStat(memberPid, "S", pid, startTicks + 1);
      }) as typeof fs.readFileSync);
    const entries = vi
      .spyOn(fs, "readdirSync")
      .mockImplementation(() => (killed ? [] : [String(memberPid)]) as never);
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM") termSent = true;
      if (signal === "SIGKILL") killed = true;
      return true;
    });
    try {
      const result = await stopProcessGroupVerified(
        { pid, startTicks },
        { timeoutMs: 0 },
      );

      expect(result).toEqual({ outcome: "terminated", signaled: true });
      expect(kill.mock.calls).toEqual([
        [-pid, "SIGTERM"],
        [-pid, "SIGKILL"],
      ]);
    } finally {
      kill.mockRestore();
      entries.mockRestore();
      read.mockRestore();
    }
  });


  it("reports an already-dead leader without signaling", async () => {
    const { stdout } = await runCommand(node, [
      "-e",
      "console.log(process.pid)",
    ]);
    const deadPid = Number(stdout.trim());
    const result = await stopProcessGroupVerified(
      { pid: deadPid, startTicks: 1 },
      { timeoutMs: 200 },
    );
    expect(result).toEqual({ outcome: "already-dead", signaled: false });
  });

  it("refuses to signal an unverifiable group after its leader exits", async () => {
    const stubbornChild = [
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const script = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(stubbornChild)}], { stdio: "ignore" });`,
      "setTimeout(() => process.exit(0), 300);",
    ].join("\n");
    const parent = spawn(node, ["-e", script], {
      detached: true,
      stdio: "ignore",
    });
    const pid = parent.pid;
    if (pid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    try {
      const identity = readProcessIdentity(pid);
      expect(identity).toBeDefined();
      const deadline = Date.now() + 3000;
      while (
        Date.now() < deadline &&
        (fs.existsSync(`/proc/${pid}`) ||
          listProcessGroupMembers(pid).length === 0)
      ) {
        await delay(50);
      }
      expect(fs.existsSync(`/proc/${pid}`)).toBe(false);
      expect(listProcessGroupMembers(pid).length).toBeGreaterThan(0);

      const result = await stopProcessGroupVerified(
        identity as ProcessIdentity,
        { timeoutMs: 200 },
      );

      expect(result).toEqual({ outcome: "reused", signaled: false });
      expect(listProcessGroupMembers(pid).length).toBeGreaterThan(0);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // group already gone
      }
    }
  });

  it("terminates the whole verified process group and confirms it is gone", async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parent = spawn(node, ["-e", script], {
      detached: true,
      stdio: "ignore",
    });
    const pid = parent.pid;
    if (pid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    let members: number[] = [];
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        members = listProcessGroupMembers(pid);
        if (members.length >= 2) break;
        await delay(50);
      }
      expect(members).toContain(pid);
      expect(members.length).toBeGreaterThanOrEqual(2);

      const identity = readProcessIdentity(pid);
      expect(identity).toBeDefined();

      const result = await stopProcessGroupVerified(
        identity as ProcessIdentity,
        { timeoutMs: 3000 },
      );
      expect(result.outcome).toBe("terminated");
      expect(result.signaled).toBe(true);
      expect(listProcessGroupMembers(pid)).toEqual([]);
    } finally {
      if (isPidAlive(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // group already gone
        }
      }
      for (const member of members) {
        if (isPidAlive(member)) {
          try {
            process.kill(member, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    }
  });

  it("terminates live members with a matching zombie group leader", async () => {
    const makeStat = (
      pid: number,
      state: string,
      pgrp: number,
      startTicks: number,
    ): string => {
      const fields = Array.from({ length: 20 }, () => "0");
      fields[0] = state;
      fields[2] = String(pgrp);
      fields[19] = String(startTicks);
      return `${pid} (test) ${fields.join(" ")}`;
    };
    const leaderStat = makeStat(100, "Z", 100, 456);
    const memberStat = makeStat(101, "S", 100, 789);
    let memberAlive = true;
    const readDir = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
      const entries = memberAlive ? ["100", "101"] : ["100"];
      return entries as never;
    });
    const read = vi.spyOn(fs, "readFileSync").mockImplementation((target) => {
      return String(target).includes("/100/") ? leaderStat : memberStat;
    });
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-100);
      if (signal === "SIGKILL") memberAlive = false;
      return true;
    });
    try {
      const result = await stopProcessGroupVerified(
        { pid: 100, startTicks: 456 },
        { timeoutMs: 0 },
      );

      expect(result).toEqual({ outcome: "terminated", signaled: true });
      expect(kill).toHaveBeenNthCalledWith(1, -100, "SIGTERM");
      expect(kill).toHaveBeenNthCalledWith(2, -100, "SIGKILL");
      expect(listProcessGroupMembers(100)).toEqual([]);
    } finally {
      kill.mockRestore();
      read.mockRestore();
      readDir.mockRestore();
    }
  });
});

// isProcessGroupAlive is a kill(2) signal-0 probe, not a /proc read, so
// (unlike listProcessGroupMembers) it is exercised for real here and runs on
// every platform, including Darwin.
describe("isProcessGroupAlive", () => {
  it("is true for a live group and false once every member is gone", async () => {
    const leader = spawn(node, ["-e", "setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = leader.pid;
    if (pid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    try {
      expect(isProcessGroupAlive(pid)).toBe(true);
      process.kill(-pid, "SIGKILL");
      const deadline = Date.now() + 3000;
      while (isProcessGroupAlive(pid) && Date.now() < deadline) {
        await delay(20);
      }
      expect(isProcessGroupAlive(pid)).toBe(false);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("stays true when a leader is killed but a group member survives it, matching a crashed-supervisor-with-live-child scenario", async () => {
    // The leader's own script spawns a member process in the same group
    // (inherited by default, since the member itself is not detached), marks
    // a readiness file once the member is actually up, then parks so it does
    // not exit on its own.
    const readyFile = path.join(
      os.tmpdir(),
      `pickforge-lab-proc-group-ready-${process.pid}-${Date.now()}`,
    );
    const script = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const member = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });',
      `member.once("spawn", () => fs.writeFileSync(${JSON.stringify(readyFile)}, "ready"));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const leader = spawn(node, ["-e", script], {
      detached: true,
      stdio: "ignore",
    });
    const pid = leader.pid;
    if (pid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    try {
      const readyDeadline = Date.now() + 3000;
      while (!fs.existsSync(readyFile) && Date.now() < readyDeadline) {
        await delay(20);
      }
      expect(fs.existsSync(readyFile)).toBe(true);
      expect(isProcessGroupAlive(pid)).toBe(true);

      // Kill only the leader directly (by pid, not by group), simulating a
      // supervisor that crashed on its own while its child kept running.
      leader.kill("SIGKILL");
      await new Promise<void>((resolve) => leader.once("exit", () => resolve()));

      // The group (identified by the now-dead leader's former pid) is still
      // alive because its member is still running: a naive check that only
      // asks "did the leader exit" would wrongly call this cleaned up.
      expect(isProcessGroupAlive(pid)).toBe(true);

      // The fix: signal the group by pgid, which still reaches the survivor,
      // then confirm it is actually empty.
      process.kill(-pid, "SIGKILL");
      const killDeadline = Date.now() + 3000;
      while (isProcessGroupAlive(pid) && Date.now() < killDeadline) {
        await delay(20);
      }
      expect(isProcessGroupAlive(pid)).toBe(false);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
      fs.rmSync(readyFile, { force: true });
    }
  });
});
