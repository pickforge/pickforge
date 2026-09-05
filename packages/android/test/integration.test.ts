import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getSession, isPidAlive, type EnvLike } from "@pickforge/lab-core";
import {
  avdExists,
  consolePortLockPath,
  createAndroidSession,
  createAvd,
  DEFAULT_AVD_NAME,
  destroyAndroidSession,
  detectKvm,
  detectSdkRoot,
  detectSdkTools,
  getAndroidSessionStatus,
  getUiTree,
  installApk,
  launchApp,
  listDevices,
  listSystemImages,
  logcat,
  runAdb,
  screenshot,
  tap,
  type AndroidSessionHandle,
} from "../src/index.js";

/**
 * Live emulator proof. Runs only with PICKFORGE_LIVE_ANDROID=1 and a working
 * SDK, emulator, adb, and KVM. Optional knobs:
 *
 * - PICKFORGE_LIVE_ANDROID_AVD: boot this existing AVD instead of creating a
 *   throwaway one under the temp root.
 * - PICKFORGE_LIVE_ANDROID_APK and PICKFORGE_LIVE_ANDROID_PACKAGE: install and
 *   launch a real APK after boot and assert it owns the UI tree.
 * - PICKFORGE_LIVE_ANDROID_ARTIFACTS: directory that receives every session
 *   record and emulator log, pass or fail.
 *
 * On failure the temp root (and the emulator logs named by the errors) is
 * preserved and its path printed, unless the artifacts directory took a copy.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BOOT_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 900_000;
const APP_SETTLE_TIMEOUT_MS = 60_000;
const APP_SETTLE_POLL_MS = 2_000;
const GUEST_SETTLE_TIMEOUT_MS = 120_000;
const GUEST_SETTLE_MIN_AVAILABLE_KB = 800 * 1024;
const GUEST_SETTLE_MAX_LOAD1 = 2.5;
const LAUNCH_ATTEMPTS = 3;
const ADB_FORGET_TIMEOUT_MS = 15_000;

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

const liveAvd = nonEmpty(process.env.PICKFORGE_LIVE_ANDROID_AVD);
const apkPath = nonEmpty(process.env.PICKFORGE_LIVE_ANDROID_APK);
const apkPackage = nonEmpty(process.env.PICKFORGE_LIVE_ANDROID_PACKAGE);
const artifactDir = nonEmpty(process.env.PICKFORGE_LIVE_ANDROID_ARTIFACTS);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-android-itest-"));
const homeA = path.join(tmpRoot, "home-a");
const homeB = path.join(tmpRoot, "home-b");
const projectA = path.join(tmpRoot, "project-a");
const projectB = path.join(tmpRoot, "project-b");
for (const dir of [homeA, homeB, projectA, projectB]) {
  fs.mkdirSync(dir, { recursive: true });
}

// A throwaway AVD lives under the temp root so the real AVD home is never
// written. A named existing AVD is used from wherever the emulator resolves it.
const toolEnv: EnvLike =
  liveAvd === undefined
    ? { ...process.env, ANDROID_AVD_HOME: path.join(tmpRoot, "avd") }
    : { ...process.env };
const avdName = liveAvd ?? DEFAULT_AVD_NAME;
const registryEnvA: EnvLike = { ...toolEnv, PICKFORGE_HOME: homeA };
const registryEnvB: EnvLike = { ...toolEnv, PICKFORGE_HOME: homeB };

const sdkRoot = detectSdkRoot();
const tools = detectSdkTools({ sdk: sdkRoot });
const kvm = detectKvm();
const systemImages = sdkRoot === null ? [] : listSystemImages(sdkRoot);
const avdReady =
  liveAvd === undefined
    ? tools.avdmanager !== null && systemImages.length > 0
    : avdExists(liveAvd, toolEnv);

const hasAndroidStack =
  sdkRoot !== null &&
  tools.emulator !== null &&
  tools.adb !== null &&
  kvm.supported &&
  avdReady;

const opOpts = { sdk: sdkRoot, env: toolEnv };

let failed = false;

afterEach((context) => {
  if (context.task.result?.state === "fail") {
    failed = true;
  }
});

function copyDiagnostics(home: string, dest: string): void {
  const sessionsDir = path.join(home, "sessions");
  if (!fs.existsSync(sessionsDir)) {
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    const source = path.join(sessionsDir, entry.name);
    if (entry.isFile()) {
      fs.copyFileSync(source, path.join(dest, entry.name));
    } else if (entry.isDirectory()) {
      fs.cpSync(source, path.join(dest, entry.name), { recursive: true });
    }
  }
  const ports = path.join(home, "ports");
  if (fs.existsSync(ports)) {
    fs.cpSync(ports, path.join(dest, "ports"), { recursive: true });
  }
}

afterAll(() => {
  let copied = false;
  if (artifactDir !== undefined) {
    copyDiagnostics(homeA, path.join(artifactDir, "home-a"));
    copyDiagnostics(homeB, path.join(artifactDir, "home-b"));
    copied = true;
  }
  if (failed && !copied) {
    console.error(
      `android integration failed; emulator logs and session records are preserved under ${tmpRoot}`,
    );
    return;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectPng(serial: string, outPath: string): Promise<void> {
  await screenshot({ serial, ...opOpts, outPath });
  const data = fs.readFileSync(outPath);
  expect(data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);
}

async function appProcessAlive(serial: string, packageName: string): Promise<boolean> {
  const result = await runAdb({ serial, ...opOpts, args: ["shell", "pidof", packageName] });
  return result.ok && /\d/.test(result.stdout);
}

async function waitForAppInUiTree(
  serial: string,
  packageName: string,
): Promise<{ xml: string; owned: boolean }> {
  const deadline = Date.now() + APP_SETTLE_TIMEOUT_MS;
  let xml = "";
  while (Date.now() < deadline) {
    xml = await getUiTree({ serial, ...opOpts });
    if (xml.includes(`package="${packageName}"`)) {
      return { xml, owned: true };
    }
    if (!(await appProcessAlive(serial, packageName))) {
      return { xml, owned: false };
    }
    await sleep(APP_SETTLE_POLL_MS);
  }
  return { xml, owned: false };
}

/** MemAvailable (kB) and the 1-minute load average of the guest; zeros when unreadable. */
async function guestPressure(serial: string): Promise<{ availableKb: number; load1: number }> {
  const result = await runAdb({
    serial,
    ...opOpts,
    args: ["shell", "grep MemAvailable /proc/meminfo; cat /proc/loadavg"],
  });
  const availableKb = Number(/MemAvailable:\s*(\d+)/.exec(result.stdout)?.[1] ?? 0);
  const load1 = Number(/^([\d.]+) /m.exec(result.stdout.split("\n").at(-2) ?? "")?.[1] ?? 0);
  return {
    availableKb: Number.isFinite(availableKb) ? availableKb : 0,
    load1: Number.isFinite(load1) ? load1 : 0,
  };
}

/**
 * Right after a quickboot restore, and again right after an APK install on a
 * Play image (Play Protect verifies the sideload), a 2 GB AVD sits at the
 * low-memory watermark and kills the first launched process (see the #93
 * evidence). Wait for the guest to report room and a falling load before
 * launching; the wait is bounded and logged.
 */
async function waitForGuestSettled(serial: string): Promise<void> {
  const deadline = Date.now() + GUEST_SETTLE_TIMEOUT_MS;
  let pressure = { availableKb: 0, load1: 0 };
  while (Date.now() < deadline) {
    pressure = await guestPressure(serial);
    if (
      pressure.availableKb >= GUEST_SETTLE_MIN_AVAILABLE_KB &&
      pressure.load1 <= GUEST_SETTLE_MAX_LOAD1
    ) {
      return;
    }
    await sleep(APP_SETTLE_POLL_MS);
  }
  console.warn(
    `guest still busy after ${GUEST_SETTLE_TIMEOUT_MS}ms (MemAvailable ${pressure.availableKb} kB, ` +
      `load1 ${pressure.load1}); launching anyway`,
  );
}

async function launchOnce(
  serial: string,
  packageName: string,
): Promise<{ xml: string; owned: boolean; detail: string }> {
  try {
    const launched = await launchApp({ serial, ...opOpts, packageName });
    const { xml, owned } = await waitForAppInUiTree(serial, packageName);
    const alive = await appProcessAlive(serial, packageName);
    return {
      xml,
      owned,
      detail: `pid ${launched.pid}, ${launched.launchState ?? "unknown"} launch, process ${alive ? "alive" : "dead"}`,
    };
  } catch (error) {
    return { xml: "", owned: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Launch the APK and wait until it owns the UI tree. A launch the guest drops
 * (rejected by launchApp, or a process that dies before owning the tree) is
 * reported and retried once after the guest settles, so the proof still fails
 * when the app cannot stay up.
 */
async function launchAndSettle(serial: string, packageName: string): Promise<string> {
  let lastDetail = "";
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt += 1) {
    await waitForGuestSettled(serial);
    const { xml, owned, detail } = await launchOnce(serial, packageName);
    if (owned) {
      return xml;
    }
    lastDetail = detail;
    console.warn(
      `${packageName} did not own the UI tree on launch attempt ${attempt}: ${detail}`,
    );
  }
  throw new Error(
    `${packageName} did not stay in the foreground after ${LAUNCH_ATTEMPTS} launches; ` +
      `last attempt: ${lastDetail}`,
  );
}

/** adb drops a dead emulator's transport a moment after the process exits. */
async function waitForAdbToForget(serial: string): Promise<string[]> {
  const deadline = Date.now() + ADB_FORGET_TIMEOUT_MS;
  let serials: string[] = [];
  for (;;) {
    serials = (await listDevices(opOpts)).map((device) => device.serial);
    if (!serials.includes(serial) || Date.now() >= deadline) {
      return serials;
    }
    await sleep(500);
  }
}

async function expectGone(session: AndroidSessionHandle, registryEnv: EnvLike) {
  expect(isPidAlive(session.emulatorPid)).toBe(false);
  expect(await getSession(session.id, registryEnv)).toBeUndefined();
  expect(fs.existsSync(consolePortLockPath(session.consolePort, registryEnv))).toBe(false);
  expect(await waitForAdbToForget(session.serial)).not.toContain(session.serial);
}

async function destroyIfPresent(
  session: AndroidSessionHandle | undefined,
  registryEnv: EnvLike,
): Promise<void> {
  if (session === undefined || (await getSession(session.id, registryEnv)) === undefined) {
    return;
  }
  await destroyAndroidSession(session.id, registryEnv, {
    ...opOpts,
    timeoutMs: STOP_TIMEOUT_MS,
  });
}

describe.skipIf(!hasAndroidStack)("android integration (emulator + adb)", () => {
  beforeAll(async () => {
    if (liveAvd === undefined && sdkRoot !== null) {
      const image = systemImages[0];
      if (image !== undefined) {
        await createAvd({ systemImage: image.packageId, sdk: sdkRoot, env: toolEnv });
      }
    }
  }, TEST_TIMEOUT_MS);

  it(
    "boots the AVD, drives screenshot, tap, ui-tree, and logcat (plus the APK when provided), and destroys cleanly",
    async () => {
      const session = await createAndroidSession({
        projectDir: projectA,
        registryEnv: registryEnvA,
        ...opOpts,
        avdName,
        bootTimeoutMs: BOOT_TIMEOUT_MS,
      });
      try {
        expect(session.serial).toMatch(/^emulator-\d+$/);
        expect(isPidAlive(session.emulatorPid)).toBe(true);
        expect(["warm", "cold", "unknown"]).toContain(session.bootMode);
        expect(fs.existsSync(session.logPath)).toBe(true);

        const record = await getSession(session.id, registryEnvA);
        expect(record?.status).toBe("running");
        expect(record?.android?.bootMode).toBe(session.bootMode);

        const status = await getAndroidSessionStatus(session.id, registryEnvA, opOpts);
        expect(status.emulatorAlive).toBe(true);
        expect(status.deviceState).toBe("device");

        await expectPng(session.serial, path.join(tmpRoot, "android-shot.png"));

        if (apkPath !== undefined && apkPackage !== undefined) {
          await installApk({ serial: session.serial, ...opOpts, apkPath });
          const xml = await launchAndSettle(session.serial, apkPackage);
          expect(xml).toContain("<hierarchy");
          await expectPng(session.serial, path.join(tmpRoot, "android-app.png"));
        }

        await tap({ serial: session.serial, ...opOpts, x: 200, y: 400 });

        const xml = await getUiTree({ serial: session.serial, ...opOpts });
        expect(xml).toContain("<hierarchy");

        const log = await logcat({ serial: session.serial, ...opOpts, lines: 100 });
        expect(log.length).toBeGreaterThan(0);
      } finally {
        await destroyAndroidSession(session.id, registryEnvA, {
          ...opOpts,
          timeoutMs: STOP_TIMEOUT_MS,
        });
      }
      await expectGone(session, registryEnvA);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "cold boots a read-only session and runs a concurrent read-only session from another home without collisions",
    async () => {
      // Pickforge shares an AVD only among read-only sessions (see
      // AVD_SHARING_POLICY), so both concurrent sessions run read-only; the
      // first also skips the snapshot.
      const first = await createAndroidSession({
        projectDir: projectA,
        registryEnv: registryEnvA,
        ...opOpts,
        avdName,
        coldBoot: true,
        readOnly: true,
        bootTimeoutMs: BOOT_TIMEOUT_MS,
      });
      let second: AndroidSessionHandle | undefined;
      try {
        expect(first.bootMode).toBe("cold");
        expect(first.readOnly).toBe(true);
        second = await createAndroidSession({
          projectDir: projectB,
          registryEnv: registryEnvB,
          ...opOpts,
          avdName,
          readOnly: true,
          bootTimeoutMs: BOOT_TIMEOUT_MS,
        });
        expect(second.readOnly).toBe(true);
        expect(second.consolePort).not.toBe(first.consolePort);
        expect(second.serial).not.toBe(first.serial);
        expect(second.logDir).not.toBe(first.logDir);

        for (const [session, registryEnv] of [
          [first, registryEnvA],
          [second, registryEnvB],
        ] as const) {
          const status = await getAndroidSessionStatus(session.id, registryEnv, opOpts);
          expect(status.emulatorAlive).toBe(true);
          expect(status.deviceState).toBe("device");
          await expectPng(session.serial, path.join(tmpRoot, `${session.id}.png`));
        }

        // Destroying the first session leaves the second untouched.
        await destroyAndroidSession(first.id, registryEnvA, {
          ...opOpts,
          timeoutMs: STOP_TIMEOUT_MS,
        });
        await expectGone(first, registryEnvA);
        const survivor = await getAndroidSessionStatus(second.id, registryEnvB, opOpts);
        expect(survivor.emulatorAlive).toBe(true);
        expect(survivor.deviceState).toBe("device");
        expect(await getSession(second.id, registryEnvB)).toBeDefined();
      } finally {
        await destroyIfPresent(second, registryEnvB);
        await destroyIfPresent(first, registryEnvA);
      }
      await expectGone(first, registryEnvA);
      if (second !== undefined) {
        await expectGone(second, registryEnvB);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe.skipIf(hasAndroidStack)("android integration prerequisites", () => {
  it("skips integration cleanly when the android stack is unavailable", () => {
    expect(hasAndroidStack).toBe(false);
  });
});
