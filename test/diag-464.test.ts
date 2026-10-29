// Temporary diagnostic for #464, never merged. While the rest of the suite
// runs, it starts the containment escapee fixture again and again with its
// stderr kept, and samples the process limits, then always fails so the
// numbers show in the CI log.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    return `error ${(error as NodeJS.ErrnoException).code}`;
  }
}

function cgroupChain(): string[] {
  const own = read("/proc/self/cgroup").split("::")[1] ?? "";
  const chain: string[] = [];
  for (let dir = path.join("/sys/fs/cgroup", own); ; dir = path.dirname(dir)) {
    chain.push(dir);
    if (dir === "/sys/fs/cgroup" || dir === "/") break;
  }
  return chain;
}

it("diag 464: escapee fixture starts and process limits during the run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf464-diag-"));
  const chain = cgroupChain();
  const before = chain.map((dir) => `${dir}: max=${read(`${dir}/pids.max`)} events=${read(`${dir}/pids.events`)}`);
  let maxTasks = 0;
  const slow: string[] = [];
  const latencies: number[] = [];
  const end = Date.now() + 150_000;
  for (let round = 0; Date.now() < end; round++) {
    const total = Number(read("/proc/loadavg").split(" ")[3]?.split("/")[1]);
    if (Number.isFinite(total)) maxTasks = Math.max(maxTasks, total);
    const pidFile = path.join(root, `escapee-${round}.pid`);
    const errFile = path.join(root, `escape-${round}.err`);
    const script = path.join(root, `escape-${round}.sh`);
    fs.writeFileSync(
      script,
      ["#!/bin/sh", `setsid /bin/sh -c 'echo $$ > "${pidFile}"; exec /bin/sleep 300' &`, "sleep 300", ""].join("\n"),
      { mode: 0o755 },
    );
    const err = fs.openSync(errFile, "w");
    const started = Date.now();
    const child = spawn(script, [], { detached: true, stdio: ["ignore", "ignore", err] });
    fs.closeSync(err);
    child.unref();
    let escapee: number | undefined;
    while (Date.now() - started < 20_000) {
      const pid = Number(read(pidFile));
      if (Number.isInteger(pid) && pid > 0) {
        escapee = pid;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const elapsed = Date.now() - started;
    latencies.push(elapsed);
    if (escapee === undefined || elapsed > 1_000) {
      const leader = child.pid === undefined ? "no pid" : read(`/proc/${child.pid}/stat`);
      slow.push(`round ${round}: ${elapsed} ms escapee=${escapee} leader=${leader} stderr=${JSON.stringify(read(errFile).slice(0, 400))}`);
    }
    for (const target of [child.pid === undefined ? undefined : -child.pid, escapee]) {
      try {
        if (target !== undefined) process.kill(target, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fs.rmSync(root, { recursive: true, force: true });
  latencies.sort((a, b) => a - b);
  const after = chain.map((dir) => `${dir}: max=${read(`${dir}/pids.max`)} peak=${read(`${dir}/pids.peak`)} events=${read(`${dir}/pids.events`)}`);
  const limit = read("/proc/self/limits").split("\n").find((line) => line.startsWith("Max processes"));
  throw new Error(
    [
      `diagnostic for #464: rounds=${latencies.length} p50=${latencies[Math.floor(latencies.length / 2)]} max=${latencies.at(-1)} slow_or_failed=${slow.length}`,
      `limit: ${limit}; max system tasks seen: ${maxTasks}; threads-max: ${read("/proc/sys/kernel/threads-max")}; pid_max: ${read("/proc/sys/kernel/pid_max")}`,
      "cgroups before:", ...before, "cgroups after:", ...after, "slow or failed starts:", ...slow.slice(0, 20),
    ].join("\n"),
  );
}, 200_000);
