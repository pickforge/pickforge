import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSession, isPidAlive, type EnvLike } from "@pickforge/lab-core";
import {
  createAndroidSession,
  createAvd,
  destroyAndroidSession,
  detectKvm,
  detectSdkRoot,
  detectSdkTools,
  getAndroidSessionStatus,
  getUiTree,
  listAvds,
  listSystemImages,
  logcat,
  screenshot,
  tap,
  DEFAULT_AVD_NAME,
} from "../src/index.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BOOT_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 420_000;

const sdkRoot = detectSdkRoot();
const tools = detectSdkTools({ sdk: sdkRoot });
const kvm = detectKvm();
const systemImages = sdkRoot === null ? [] : listSystemImages(sdkRoot);
const avds = sdkRoot !== null ? await listAvds({ sdk: sdkRoot }) : [];
const avdExists = avds.includes(DEFAULT_AVD_NAME);
const avdCreatable = tools.avdmanager !== null && systemImages.length > 0;

const hasAndroidStack =
  sdkRoot !== null &&
  tools.emulator !== null &&
  tools.adb !== null &&
  kvm.supported &&
  (avdExists || avdCreatable);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-android-itest-"));
const home = path.join(tmpRoot, "home");
const projectDir = path.join(tmpRoot, "project");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
const registryEnv: EnvLike = { ...process.env, PICKLAB_HOME: home };

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe.skipIf(!hasAndroidStack)("android integration (emulator + adb)", () => {
  beforeAll(async () => {
    if (!avdExists && sdkRoot !== null) {
      const image = systemImages[0];
      if (image !== undefined) {
        await createAvd({ systemImage: image.packageId, sdk: sdkRoot });
      }
    }
  }, TEST_TIMEOUT_MS);

  it(
    "boots pickforge-avd and drives screenshot, tap, ui-tree, and logcat",
    async () => {
      const session = await createAndroidSession({
        projectDir,
        registryEnv,
        sdk: sdkRoot,
        bootTimeoutMs: BOOT_TIMEOUT_MS,
      });
      try {
        expect(session.serial).toMatch(/^emulator-\d+$/);
        expect(isPidAlive(session.emulatorPid)).toBe(true);

        const record = await getSession(session.id, registryEnv);
        expect(record?.status).toBe("running");

        const status = await getAndroidSessionStatus(session.id, registryEnv, {
          sdk: sdkRoot,
        });
        expect(status.emulatorAlive).toBe(true);
        expect(status.deviceState).toBe("device");

        const outPath = path.join(tmpRoot, "android-shot.png");
        await screenshot({ serial: session.serial, sdk: sdkRoot, outPath });
        const data = fs.readFileSync(outPath);
        expect(data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);

        await tap({ serial: session.serial, sdk: sdkRoot, x: 200, y: 400 });

        const xml = await getUiTree({ serial: session.serial, sdk: sdkRoot });
        expect(xml).toContain("<hierarchy");

        const log = await logcat({
          serial: session.serial,
          sdk: sdkRoot,
          lines: 100,
        });
        expect(log.length).toBeGreaterThan(0);
      } finally {
        await destroyAndroidSession(session.id, registryEnv, { sdk: sdkRoot });
      }
      expect(isPidAlive(session.emulatorPid)).toBe(false);
      expect(await getSession(session.id, registryEnv)).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe.skipIf(hasAndroidStack)("android integration prerequisites", () => {
  it("skips integration cleanly when the android stack is unavailable", () => {
    expect(hasAndroidStack).toBe(false);
  });
});
