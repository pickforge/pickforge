import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  GUEST_ABORTED,
  GuestReadinessError,
  isGuestReadinessError,
  maybeWaitForGuestReady,
  parseGuestNowSeconds,
  parseLmkQuietSeconds,
  waitForGuestReady,
} from "../src/index.js";

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "pickforge-lab-android-ready-"),
);
const SERIAL = "emulator-5554";

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let binCounter = 0;

function fakeAdbDir(script: string): string {
  binCounter += 1;
  const dir = path.join(tmpRoot, `bin-${binCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "adb"),
    `#!/bin/sh\nPATH="/usr/bin:/bin:$PATH"\n${script}\n`,
    { mode: 0o755 },
  );
  return dir;
}

function readyAdb(
  callLog: string,
  opts: { date?: string; logcat?: string; logcatScript?: string } = {},
): string {
  const date = opts.date ?? "echo 1000";
  const logcat =
    opts.logcatScript ??
    (opts.logcat === undefined
      ? "echo 'I/App( 1): started'"
      : `printf '%s\\n' '${opts.logcat}'`);
  return fakeAdbDir(
    [
      `echo "$*" >> '${callLog}'`,
      'case "$*" in',
      `  *"+%s"*) ${date} ;;`,
      `  *"logcat -d -v epoch"*) ${logcat} ;;`,
      '  *"am start"*|*"install -r"*|*"resolve-activity"*|*pidof*) echo SHOULD_NOT_RUN; exit 1 ;;',
      "esac",
    ].join("\n"),
  );
}

describe("parseLmkQuietSeconds", () => {
  it("is null when the buffer has no lowmemorykiller kill", () => {
    expect(parseLmkQuietSeconds("I/App( 1): started\n", 1000)).toBeNull();
    expect(parseLmkQuietSeconds("", 1000)).toBeNull();
  });

  it("uses the last kill timestamp against the guest clock", () => {
    const log = [
      "990.4  1  1 I lowmemorykiller: Kill 'launcher' (11) to free 1kB",
      "995.9  1  1 I lowmemorykiller: Kill 'gms' (12) to free 1kB",
      "996.1  1  1 I ActivityManager: Killing 12:gms/u0a12",
    ].join("\n");
    expect(parseLmkQuietSeconds(log, 1000)).toBe(5);
  });

  it("ignores malformed stamps and clamps negative deltas to 0", () => {
    expect(
      parseLmkQuietSeconds("not-a-time  1  1 I lowmemorykiller: Kill 'x'\n", 50),
    ).toBeNull();
    expect(
      parseLmkQuietSeconds("80.2  1  1 I lowmemorykiller: Kill 'x'\n", 50),
    ).toBe(0);
  });

  it("still sees a kill behind more than 2000 later lines", () => {
    const filler = Array.from(
      { length: 2500 },
      (_, i) => `${1000 + i}.0  1  1 I chatter: line ${i}`,
    ).join("\n");
    const log = [
      "990.0  1  1 I lowmemorykiller: Kill 'app' (1) to free 1kB",
      filler,
    ].join("\n");
    expect(parseLmkQuietSeconds(log, 1100)).toBe(110);
  });
});

describe("parseGuestNowSeconds", () => {
  it("reads the integer guest clock and rejects junk", () => {
    expect(parseGuestNowSeconds("1757035673\n")).toBe(1757035673);
    expect(parseGuestNowSeconds("  42  ")).toBe(42);
    expect(parseGuestNowSeconds("")).toBeUndefined();
    expect(parseGuestNowSeconds("not-a-clock")).toBeUndefined();
  });
});

describe("waitForGuestReady", () => {
  it("returns immediately when lowmemorykiller has never killed", async () => {
    const callLog = path.join(tmpRoot, "ready-quiet.log");
    const progress: string[] = [];
    const probe = await waitForGuestReady({
      serial: SERIAL,
      sdk: null,
      env: { PATH: readyAdb(callLog) },
      boundSeconds: 5,
      pollIntervalMs: 20,
      onProgress: (message) => progress.push(message),
    });
    expect(probe.kind).toBe("guest-ready");
    expect(probe.lmkQuietS).toBeNull();
    expect(probe.quietNeedS).toBe(30);
    expect(probe.waitedMs).toBeLessThan(1000);
    expect(progress).toEqual([
      `guest ready on ${SERIAL}: lowmemorykiller quiet never after 0s`,
    ]);
    expect(fs.readFileSync(callLog, "utf8")).not.toMatch(/am start|install -r/);
    expect(fs.readFileSync(callLog, "utf8")).toMatch(
      /logcat -d -v epoch -s lowmemorykiller:I/,
    );
    expect(fs.readFileSync(callLog, "utf8")).not.toMatch(/-t 2000/);
  });

  it("waits until kills fall outside the quiet window, then reports progress", async () => {
    const callLog = path.join(tmpRoot, "ready-wait.log");
    const countFile = path.join(tmpRoot, "ready-wait.count");
    const bin = readyAdb(callLog, {
      logcatScript: [
        `n=$(cat '${countFile}' 2>/dev/null || echo 0)`,
        "n=$((n+1))",
        `echo "$n" > '${countFile}'`,
        'if [ "$n" -ge 3 ]; then echo "I/App( 1): started";',
        'else echo "990.0  1  1 I lowmemorykiller: Kill \'gms\' (1)"; fi',
      ].join("\n"),
    });
    const progress: string[] = [];
    const probe = await waitForGuestReady({
      serial: SERIAL,
      sdk: null,
      env: { PATH: bin },
      boundSeconds: 5,
      quietSeconds: 30,
      pollIntervalMs: 20,
      onProgress: (message) => progress.push(message),
    });
    expect(probe.kind).toBe("guest-ready");
    expect(probe.lmkQuietS).toBeNull();
    expect(progress[0]).toMatch(
      new RegExp(
        `^waiting for guest ready on ${SERIAL}: lowmemorykiller quiet 10s \\(need 30s\\), 0s of 5s elapsed$`,
      ),
    );
    expect(progress.at(-1)).toMatch(
      new RegExp(`^guest ready on ${SERIAL}: lowmemorykiller quiet never after `),
    );
    expect(fs.readFileSync(callLog, "utf8")).not.toMatch(/am start|install -r/);
  });

  it("fails with a typed bounded error and does not start an action", async () => {
    const callLog = path.join(tmpRoot, "ready-timeout.log");
    const progress: string[] = [];
    let error: unknown;
    try {
      await waitForGuestReady({
        serial: SERIAL,
        sdk: null,
        env: {
          PATH: readyAdb(callLog, {
            logcat: "999.0  1  1 I lowmemorykiller: Kill 'app' (9)",
          }),
        },
        boundSeconds: 1,
        quietSeconds: 30,
        pollIntervalMs: 20,
        onProgress: (message) => progress.push(message),
      });
    } catch (caught) {
      error = caught;
    }
    expect(isGuestReadinessError(error)).toBe(true);
    const readiness = error as GuestReadinessError;
    expect(readiness.kind).toBe("guest-not-ready");
    expect(readiness.probe.lmkQuietS).toBe(1);
    expect(readiness.probe.quietNeedS).toBe(30);
    expect(readiness.probe.boundMs).toBe(1000);
    expect(readiness.probe.waitedMs).toBeLessThanOrEqual(readiness.probe.boundMs);
    expect(readiness.message).toContain("[guest-not-ready]");
    expect(readiness.message).toContain("this action was not started");
    expect(progress[0]).toContain("waiting for guest ready");
    expect(fs.readFileSync(callLog, "utf8")).not.toMatch(/am start|install -r/);
  });

  it("treats an unreadable guest clock or logcat as not quiet", async () => {
    const callLog = path.join(tmpRoot, "ready-unreadable.log");
    let error: unknown;
    try {
      await waitForGuestReady({
        serial: SERIAL,
        sdk: null,
        env: {
          PATH: readyAdb(callLog, { date: "echo nope; exit 1" }),
        },
        boundSeconds: 1,
        quietSeconds: 1,
        pollIntervalMs: 20,
      });
    } catch (caught) {
      error = caught;
    }
    expect(isGuestReadinessError(error)).toBe(true);
    const readiness = error as GuestReadinessError;
    expect(readiness.kind).toBe("guest-not-ready");
    expect(readiness.probe.probeError).toBe("guest clock unreadable");
    expect(readiness.message).toContain("guest clock or logcat unreadable");
    expect(readiness.message).toContain("this action was not started");
    expect(readiness.message).not.toContain("still killing processes");
  });

  it("returns a typed guest-not-ready when adb cannot even be started", async () => {
    let error: unknown;
    try {
      await waitForGuestReady({
        serial: SERIAL,
        sdk: null,
        env: { PATH: path.join(tmpRoot, "empty-bin") },
        boundSeconds: 1,
        quietSeconds: 1,
        pollIntervalMs: 20,
      });
    } catch (caught) {
      error = caught;
    }
    expect(isGuestReadinessError(error)).toBe(true);
    const readiness = error as GuestReadinessError;
    expect(readiness.kind).toBe("guest-not-ready");
    expect(readiness.probe.probeError).toBe("adb not found");
    expect(readiness.message).toContain("guest clock or logcat unreadable (adb not found)");
  });

  it("clamps a hung adb probe to the remaining wall-clock bound", async () => {
    const callLog = path.join(tmpRoot, "ready-hung.log");
    const startedAt = Date.now();
    let error: unknown;
    try {
      await waitForGuestReady({
        serial: SERIAL,
        sdk: null,
        env: {
          PATH: readyAdb(callLog, { date: "sleep 5; echo 1000" }),
        },
        boundSeconds: 1,
        quietSeconds: 1,
        pollIntervalMs: 20,
      });
    } catch (caught) {
      error = caught;
    }
    const elapsed = Date.now() - startedAt;
    expect(isGuestReadinessError(error)).toBe(true);
    const readiness = error as GuestReadinessError;
    expect(readiness.kind).toBe("guest-not-ready");
    expect(readiness.probe.waitedMs).toBeLessThanOrEqual(readiness.probe.boundMs);
    expect(elapsed).toBeLessThan(2500);
    expect(fs.readFileSync(callLog, "utf8")).not.toMatch(/am start|install -r/);
  });

  it("throws aborted and does not start an action when the signal is already aborted", async () => {
    const callLog = path.join(tmpRoot, "ready-aborted-before.log");
    const signal = AbortSignal.abort();
    let error: unknown;
    try {
      await waitForGuestReady({
        serial: SERIAL,
        sdk: null,
        env: { PATH: readyAdb(callLog) },
        boundSeconds: 5,
        pollIntervalMs: 20,
        signal,
      });
    } catch (caught) {
      error = caught;
    }
    expect(isGuestReadinessError(error)).toBe(true);
    const readiness = error as GuestReadinessError;
    expect(readiness.kind).toBe(GUEST_ABORTED);
    expect(readiness.message).toContain("[aborted]");
    expect(readiness.message).toContain("this action was not started");
    expect(fs.existsSync(callLog)).toBe(false);
  });

  it("throws aborted during the wait so a cancel never reports ready", async () => {
    const callLog = path.join(tmpRoot, "ready-aborted-during.log");
    const controller = new AbortController();
    const pending = waitForGuestReady({
      serial: SERIAL,
      sdk: null,
      env: {
        PATH: readyAdb(callLog, {
          logcat: "999.0  1  1 I lowmemorykiller: Kill 'app' (9)",
        }),
      },
      boundSeconds: 5,
      quietSeconds: 30,
      pollIntervalMs: 200,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    let error: unknown;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(isGuestReadinessError(error)).toBe(true);
    const readiness = error as GuestReadinessError;
    expect(readiness.kind).toBe(GUEST_ABORTED);
    expect(readiness.message).toContain("[aborted]");
    expect(fs.readFileSync(callLog, "utf8")).not.toMatch(/am start|install -r/);
  });
});

describe("maybeWaitForGuestReady", () => {
  it("is a no-op when the wait is omitted or 0", async () => {
    const callLog = path.join(tmpRoot, "ready-skip.log");
    const env = { PATH: readyAdb(callLog) };
    expect(
      await maybeWaitForGuestReady({ serial: SERIAL, sdk: null, env }),
    ).toBeUndefined();
    expect(
      await maybeWaitForGuestReady({
        serial: SERIAL,
        sdk: null,
        env,
        waitReadySeconds: 0,
      }),
    ).toBeUndefined();
    expect(fs.existsSync(callLog)).toBe(false);
  });

  it("rejects a non-positive bound other than the omitted/0 default", async () => {
    await expect(
      maybeWaitForGuestReady({
        serial: SERIAL,
        sdk: null,
        env: { PATH: "" },
        waitReadySeconds: -1,
      }),
    ).rejects.toThrow(/waitReadySeconds/);
  });

  it("waits when a positive bound is set and keeps JSON serializable", async () => {
    const callLog = path.join(tmpRoot, "ready-maybe.log");
    const probe = await maybeWaitForGuestReady({
      serial: SERIAL,
      sdk: null,
      env: { PATH: readyAdb(callLog) },
      waitReadySeconds: 5,
      pollIntervalMs: 20,
    });
    expect(probe?.kind).toBe("guest-ready");
    expect(probe?.lmkQuietS).toBeNull();
    expect(JSON.parse(JSON.stringify(probe))).toMatchObject({
      kind: "guest-ready",
      serial: SERIAL,
      lmkQuietS: null,
      quietNeedS: 30,
      boundMs: 5000,
    });
    expect(fs.readFileSync(callLog, "utf8")).not.toMatch(/am start|install -r/);
  });
});
