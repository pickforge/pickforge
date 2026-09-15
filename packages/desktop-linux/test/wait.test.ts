import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { screenshot } from "../src/screenshot.js";
import { listWindows } from "../src/apps.js";
import { ObservationTimeoutError } from "@pickforge/lab-core";
import { boundDesktopWaitTimeoutMs, boundStableMs, desktopWait } from "../src/wait.js";
import { encodePng } from "./png-fixture.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-wait-"));
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
});

function rgb(r: number, g: number, b: number): Buffer {
  return Buffer.from([r, g, b]);
}

function writeBin(name: string, body: string): string {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path.dirname(file);
}

function writeCapture(body: string): string {
  const bin = writeBin("bin/import", body);
  writeBin("bin/maim", body);
  writeBin("bin/scrot", body);
  return bin;
}

function toolEnv(bin: string): NodeJS.ProcessEnv {
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
}

it("validates wait timeout and stable duration bounds", () => {
  expect(boundDesktopWaitTimeoutMs(undefined)).toBe(10_000);
  expect(boundDesktopWaitTimeoutMs(0)).toBe(0);
  expect(() => boundDesktopWaitTimeoutMs(300_001)).toThrow(/timeoutMs/);
  expect(boundStableMs(undefined)).toBe(500);
  expect(() => boundStableMs(0)).toThrow(/stableMs/);
  expect(() => boundStableMs(60_001)).toThrow(/stableMs/);
});

it("waits until fake captures differ from a baseline PNG", async () => {
  const baseline = path.join(tmp, "base.png");
  const first = path.join(tmp, "first.png");
  const second = path.join(tmp, "second.png");
  fs.writeFileSync(baseline, encodePng(1, 1, rgb(0, 0, 0)));
  fs.writeFileSync(first, encodePng(1, 1, rgb(0, 0, 0)));
  fs.writeFileSync(second, encodePng(1, 1, rgb(255, 0, 0)));
  const marker = path.join(tmp, "count");
  const bin = writeCapture(
    `for a in "$@"; do out="$a"; done\n` +
      `if [ -f "${marker}" ]; then /bin/cp "${second}" "$out"; else : > "${marker}"; /bin/cp "${first}" "$out"; fi`,
  );
  const result = await desktopWait({
    display: ":219",
    mode: { type: "changed", baselinePath: baseline },
    timeoutMs: 5_000,
    env: toolEnv(bin),
  });
  expect(result.reason).toBe("changed");
  expect(result.samples).toBeGreaterThanOrEqual(2);
  expect(result.sampled).toBe(true);
});

it("times out when fake captures stay equal to the baseline", async () => {
  const baseline = path.join(tmp, "base.png");
  fs.writeFileSync(baseline, encodePng(1, 1, rgb(1, 2, 3)));
  const bin = writeCapture(
    `for a in "$@"; do out="$a"; done\n/bin/cp "${baseline}" "$out"`,
  );
  const result = await desktopWait({
    display: ":219",
    mode: { type: "changed", baselinePath: baseline },
    timeoutMs: 400,
    env: toolEnv(bin),
  });
  expect(result.reason).toBe("timeout");
  expect(result.samples).toBeGreaterThanOrEqual(1);
});

it("treats a late pixel change after the deadline as timeout", async () => {
  const baseline = path.join(tmp, "base.png");
  const changed = path.join(tmp, "changed.png");
  fs.writeFileSync(baseline, encodePng(1, 1, rgb(0, 0, 0)));
  fs.writeFileSync(changed, encodePng(1, 1, rgb(9, 9, 9)));
  const bin = writeCapture(
    `for a in "$@"; do out="$a"; done\n/bin/sleep 0.25\n/bin/cp "${changed}" "$out"`,
  );
  const result = await desktopWait({
    display: ":219",
    mode: { type: "changed", baselinePath: baseline },
    timeoutMs: 80,
    env: toolEnv(bin),
  });
  expect(result.reason).toBe("timeout");
});

it("treats a hung capture as timeout instead of a subprocess error", async () => {
  const baseline = path.join(tmp, "base.png");
  fs.writeFileSync(baseline, encodePng(1, 1, rgb(3, 3, 3)));
  const bin = writeCapture(
    `for a in "$@"; do out="$a"; done\n/bin/sleep 30\n/bin/cp "${baseline}" "$out"`,
  );
  const started = Date.now();
  const result = await desktopWait({
    display: ":219",
    mode: { type: "changed", baselinePath: baseline },
    timeoutMs: 200,
    env: toolEnv(bin),
  });
  expect(result.reason).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(8_000);
});

it("times out when comparison itself overruns the remaining budget", async () => {
  const baseline = path.join(tmp, "base.png");
  fs.writeFileSync(baseline, encodePng(1, 1, rgb(4, 4, 4)));
  const binDir = writeCapture(
    `for a in "$@"; do out="$a"; done\n/bin/cp "${baseline}" "$out"`,
  );
  writeBin(
    "bin/convert",
    "/bin/sleep 20\nexit 1",
  );
  writeBin(
    "bin/magick",
    "/bin/sleep 20\nexit 1",
  );
  const result = await desktopWait({
    display: ":219",
    mode: { type: "changed", baselinePath: baseline },
    timeoutMs: 250,
    env: { PATH: binDir },
  });
  expect(result.reason).toBe("timeout");
});

it("treats sampled unchanged captures as stable", async () => {
  const frame = path.join(tmp, "frame.png");
  fs.writeFileSync(frame, encodePng(1, 1, rgb(4, 5, 6)));
  const bin = writeCapture(
    `for a in "$@"; do out="$a"; done\n/bin/cp "${frame}" "$out"`,
  );
  const result = await desktopWait({
    display: ":219",
    mode: { type: "stable", stableMs: 80 },
    timeoutMs: 3_000,
    env: toolEnv(bin),
  });
  expect(result.reason).toBe("stable");
  expect(result.samples).toBeGreaterThanOrEqual(2);
});

it("finds a named window from fake xdotool output", async () => {
  const bin = writeBin(
    "bin/xdotool",
    'case "$1" in\n  search) echo 42 ;;\n  getwindowname) echo "Pickforge Wait" ;;\nesac',
  );
  const result = await desktopWait({
    display: ":219",
    mode: { type: "window", name: "Wait" },
    timeoutMs: 1_000,
    env: toolEnv(bin),
  });
  expect(result.reason).toBe("window");
  expect(result.window).toEqual({ id: "42", name: "Pickforge Wait" });
});

it("redacts secrets in the returned window name", async () => {
  const token = `ghp_${"a".repeat(36)}`;
  const bin = writeBin(
    "bin/xdotool",
    `case "$1" in\n  search) echo 7 ;;\n  getwindowname) echo "secret ${token}" ;;\nesac`,
  );
  const result = await desktopWait({
    display: ":219",
    mode: { type: "window", name: "secret" },
    timeoutMs: 1_000,
    env: toolEnv(bin),
  });
  expect(result.reason).toBe("window");
  expect(result.window?.name).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain(token);
});

it("times out slow title queries instead of throwing a subprocess error", async () => {
  const bin = writeBin(
    "bin/xdotool",
    'case "$1" in\n  search) printf "1\\n2\\n3\\n4\\n5\\n" ;;\n  getwindowname) /bin/sleep 0.4; echo Slow ;;\nesac',
  );
  const result = await desktopWait({
    display: ":219",
    mode: { type: "window", name: "Never" },
    timeoutMs: 300,
    env: toolEnv(bin),
  });
  expect(result.reason).toBe("timeout");
});

it("does not resolve a baseline at timeout zero, and bounds baseline resolution", async () => {
  let calls = 0;
  const opts = {
    display: ":219", mode: { type: "changed" as const, baselinePath: "unused.png" },
    readBaseline: async (_file: string, deadline: number) => {
      calls += 1;
      expect(deadline).toBeLessThanOrEqual(Date.now() + 1000);
      throw new ObservationTimeoutError("baseline deadline");
    },
  };
  expect((await desktopWait({ ...opts, timeoutMs: 0 })).reason).toBe("timeout");
  expect(calls).toBe(0);
  expect((await desktopWait({ ...opts, timeoutMs: 1000 })).reason).toBe("timeout");
  expect(calls).toBe(1);
});

it("surfaces permanent query failures, even if their text contains timed out", async () => {
  const bin = writeBin("bin/xdotool", 'echo "Failed creating new xdo instance: timed out configuration" >&2; exit 1');
  await expect(desktopWait({ display: ":219", mode: { type: "window", name: "Any" }, timeoutMs: 1000, env: toolEnv(bin) })).rejects.toThrow(/Failed creating/);
  await expect(desktopWait({ display: ":219", mode: { type: "window", name: "Any" }, timeoutMs: 1000, env: { PATH: path.join(tmp, "missing") } })).rejects.toThrow(/not found/);
});

it("surfaces permanent title-query errors but tolerates a disappeared window", async () => {
  const bin = writeBin("bin/xdotool", 'case "$1" in\n search) echo 1 ;;\n getwindowname) echo "Failed creating new xdo instance." >&2; exit 1 ;;\nesac');
  await expect(desktopWait({ display: ":219", mode: { type: "window", name: "Any" }, timeoutMs: 1000, env: toolEnv(bin) })).rejects.toThrow(/title query failed/);
  writeBin("bin/xdotool", 'case "$1" in\n search) echo 1 ;;\n getwindowname) echo "X Error: BadWindow (invalid Window parameter)" >&2; exit 1 ;;\nesac');
  const result = await desktopWait({ display: ":219", mode: { type: "window", name: "Any" }, timeoutMs: 200, env: toolEnv(bin) });
  expect(result.reason).toBe("timeout");
});

it("counts only successful empty window observations and returns a no-window timeout", async () => {
  const bin = writeBin("bin/xdotool", "exit 1");
  const result = await desktopWait({ display: ":219", mode: { type: "window", name: "Any" }, timeoutMs: 250, env: toolEnv(bin) });
  expect(result.reason).toBe("timeout");
  expect(result.samples).toBeGreaterThan(0);
});

it("keeps legacy inventories complete while explicit bounds fail rather than truncate", async () => {
  const bin = writeBin("bin/xdotool", 'case "$1" in\n search) printf "1\\n2\\n3\\n" ;;\n getwindowname) /bin/sleep 0.08; echo Duplicate ;;\nesac');
  expect(await listWindows(":219", toolEnv(bin))).toHaveLength(3);
  await expect(listWindows(":219", toolEnv(bin), 120)).rejects.toBeInstanceOf(ObservationTimeoutError);
});

it("captures a valid PNG with image size and without inventing display size", async () => {
  const frame = path.join(tmp, "frame.png");
  fs.writeFileSync(frame, encodePng(2, 1, Buffer.from([1, 2, 3, 4, 5, 6])));
  const bin = writeCapture(
    `for a in "$@"; do out="$a"; done\n/bin/cp "${frame}" "$out"`,
  );
  const outPath = path.join(tmp, "shot.png");
  const result = await screenshot({
    display: ":219",
    outPath,
    env: toolEnv(bin),
    countWindows: false,
  });
  expect(result.imageSize).toEqual({ width: 2, height: 1 });
  expect(result.windowCount).toBeUndefined();
});
