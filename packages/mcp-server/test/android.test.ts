import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activePointerPath,
  listRuns,
  readActions,
  saveProjectConfig,
} from "@pickforge/lab-core";
import {
  adbLogLines,
  connectLab,
  FAKE_SERIAL,
  killFakeEmulator,
  makeFakeAndroidSdk,
  makeLabDirs,
  parseToolJson,
  PLANTED_TOKEN,
  PNG_MAGIC,
  removeLabDirs,
  writeAndroidSessionRecord,
  writeFakeAdbSdk,
  writeScript,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

let dirs: LabDirs;
let lab: ConnectedLab;
let adbLog: string;
let sessionId: string;

beforeEach(async () => {
  dirs = makeLabDirs();
  adbLog = path.join(dirs.root, "adb.log");
  const sdk = writeFakeAdbSdk(dirs.root, adbLog);
  sessionId = writeAndroidSessionRecord(dirs.home, dirs.projectDir);
  lab = await connectLab({
    projectDir: dirs.projectDir,
    env: { PICKFORGE_HOME: dirs.home, PATH: dirs.binDir, ANDROID_HOME: sdk },
  });
});

afterEach(async () => {
  await lab.close();
  removeLabDirs(dirs);
});

function overwriteReadyAdb(opts: { logcat?: string } = {}): void {
  const logcatFile = path.join(dirs.root, "ready.logcat");
  fs.writeFileSync(logcatFile, `${opts.logcat ?? "I/App( 1): started"}\n`);
  writeScript(
    path.join(dirs.root, "adb-sdk", "platform-tools", "adb"),
    [
      'PATH="/usr/bin:/bin:$PATH"',
      `printf '%s\\n' "$*" >> "${adbLog}"`,
      'case "$*" in',
      '  *"+%s"*) echo 1000 ;;',
      `  *"logcat -d -v epoch"*) cat '${logcatFile}' ;;`,
      '  *"install -r"*) echo Success ;;',
      '  *resolve-activity*) echo "com.example.app/.MainActivity" ;;',
      '  *"am start"*) echo "Status: ok"; echo "LaunchState: COLD" ;;',
      "  *pidof*) echo 4242 ;;",
      "esac",
      "exit 0",
    ].join("\n"),
  );
}

describe("android tools (fake adb)", () => {
  it("threads the session serial through tap, type, back, and home", async () => {
    const tap = parseToolJson(
      await lab.client.callTool({
        name: "android_tap",
        arguments: { x: 10, y: 20 },
      }),
    );
    expect(tap.ok).toBe(true);
    expect(tap.serial).toBe(FAKE_SERIAL);
    expect(tap.sessionId).toBe(sessionId);

    await lab.client.callTool({
      name: "android_type",
      arguments: { text: "hi there" },
    });
    await lab.client.callTool({ name: "android_back", arguments: {} });
    await lab.client.callTool({ name: "android_home", arguments: {} });

    expect(adbLogLines(adbLog)).toEqual([
      `-s ${FAKE_SERIAL} shell input tap 10 20`,
      `-s ${FAKE_SERIAL} shell input text hi%sthere`,
      `-s ${FAKE_SERIAL} shell input keyevent KEYCODE_BACK`,
      `-s ${FAKE_SERIAL} shell input keyevent KEYCODE_HOME`,
    ]);
  });

  it("records sanitized session actions without typed-value leakage", async () => {
    const typedSecret = `password-${PLANTED_TOKEN}`;
    await lab.client.callTool({
      name: "android_tap",
      arguments: { x: 10, y: 20 },
    });
    await lab.client.callTool({
      name: "android_type",
      arguments: { text: typedSecret },
    });
    await lab.client.callTool({ name: "android_back", arguments: {} });

    const [manifest] = await listRuns(dirs.projectDir);
    const records = await readActions(
      path.join(dirs.projectDir, ".picklab", "runs", manifest!.runId),
    );
    expect(records.map((record) => record.actionId)).toHaveLength(3);
    expect(
      records.map((record) => "tool" in record && record.tool),
    ).toEqual(["android_tap", "android_type", "android_back"]);
    expect(records[0]).toMatchObject({
      source: "mcp",
      sessionId,
      status: "ok",
      target: { x: 10, y: 20 },
    });
    expect(records[1]).toMatchObject({
      source: "mcp",
      sessionId,
      status: "ok",
      target: { length: typedSecret.length, inputType: "text" },
    });
    expect(JSON.stringify(records)).not.toContain(typedSecret);
    expect(JSON.stringify(records)).not.toContain(PLANTED_TOKEN);
    expect(
      fs.readdirSync(
        path.join(
          dirs.projectDir,
          ".picklab",
          "runs",
          manifest!.runId,
          "screenshots",
        ),
      ),
    ).toEqual([]);
  });

  it("does not create evidence when capture is disabled", async () => {
    await saveProjectConfig(dirs.projectDir, {
      evidence: { enabled: false },
    });
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_tap",
        arguments: { x: 1, y: 2 },
      }),
    );
    expect(report.ok).toBe(true);
    expect(await listRuns(dirs.projectDir)).toEqual([]);
  });

  it("installs an apk resolved against the project dir", async () => {
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_install_apk",
        arguments: { apkPath: "build/app.apk" },
      }),
    );
    expect(report.ok).toBe(true);
    const expected = path.join(dirs.projectDir, "build", "app.apk");
    expect(report.apkPath).toBe(expected);
    expect(adbLogLines(adbLog)).toEqual([
      `-s ${FAKE_SERIAL} install -r ${expected}`,
    ]);
  });

  it("launches an app by package name", async () => {
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_launch_app",
        arguments: { packageName: "com.example.app" },
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.component).toBe("com.example.app/.MainActivity");
    expect(report.pid).toBe(4242);
    expect(adbLogLines(adbLog)).toEqual([
      `-s ${FAKE_SERIAL} shell cmd package resolve-activity --brief ` +
        "-a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.example.app",
      `-s ${FAKE_SERIAL} shell am start -W -n com.example.app/.MainActivity`,
      `-s ${FAKE_SERIAL} shell pidof com.example.app`,
    ]);
  });

  it("waits for guest ready before install and launch when waitReadySeconds is set", async () => {
    overwriteReadyAdb();
    const apk = path.join(dirs.projectDir, "build", "app.apk");
    fs.mkdirSync(path.dirname(apk), { recursive: true });
    fs.writeFileSync(apk, "apk");
    const installed = parseToolJson(
      await lab.client.callTool({
        name: "android_install_apk",
        arguments: { apkPath: "build/app.apk", waitReadySeconds: 5 },
      }),
    );
    expect(installed.ok).toBe(true);
    expect(installed.guestReady).toMatchObject({
      kind: "guest-ready",
      serial: FAKE_SERIAL,
      lmkQuietS: null,
      quietNeedS: 30,
      boundMs: 5000,
    });
    const launched = parseToolJson(
      await lab.client.callTool({
        name: "android_launch_app",
        arguments: { packageName: "com.example.app", waitReadySeconds: 5 },
      }),
    );
    expect(launched.ok).toBe(true);
    expect(launched.guestReady.kind).toBe("guest-ready");
    const lines = adbLogLines(adbLog);
    expect(lines.filter((line) => line.includes("date +%s"))).toHaveLength(2);
    expect(
      lines.filter((line) => line.includes("logcat -d -v epoch")),
    ).toHaveLength(2);
    expect(lines.some((line) => line.includes("install -r"))).toBe(true);
    expect(lines.some((line) => line.includes("am start"))).toBe(true);
    const installAt = lines.findIndex((line) => line.includes("install -r"));
    const startAt = lines.findIndex((line) => line.includes("am start"));
    expect(installAt).toBeGreaterThan(1);
    expect(startAt).toBeGreaterThan(installAt);
  });

  it("fails closed with guest-not-ready and does not install or launch", async () => {
    overwriteReadyAdb({
      logcat: "999.0  1  1 I lowmemorykiller: Kill 'app' (9)",
    });
    const installed = await lab.client.callTool({
      name: "android_install_apk",
      arguments: { apkPath: "build/app.apk", waitReadySeconds: 1 },
    });
    expect(installed.isError).toBe(true);
    const installReport = parseToolJson(installed);
    expect(installReport.errors.join("\n")).toContain("[guest-not-ready]");
    expect(installReport.errors.join("\n")).toContain(
      "this action was not started",
    );
    const launched = await lab.client.callTool({
      name: "android_launch_app",
      arguments: { packageName: "com.example.app", waitReadySeconds: 1 },
    });
    expect(launched.isError).toBe(true);
    expect(parseToolJson(launched).errors.join("\n")).toContain(
      "[guest-not-ready]",
    );
    expect(adbLogLines(adbLog).join("\n")).not.toMatch(/install -r|am start/);
  });

  it("treats waitReadySeconds 0 as the default no-wait", async () => {
    overwriteReadyAdb();
    const launched = parseToolJson(
      await lab.client.callTool({
        name: "android_launch_app",
        arguments: { packageName: "com.example.app", waitReadySeconds: 0 },
      }),
    );
    expect(launched.ok).toBe(true);
    expect(launched.guestReady).toBeUndefined();
    expect(adbLogLines(adbLog).join("\n")).not.toMatch(/date \+%s|logcat/);
    expect(adbLogLines(adbLog).some((line) => line.includes("am start"))).toBe(
      true,
    );
  });

  it("rejects a negative or non-integer waitReadySeconds", async () => {
    for (const waitReadySeconds of [-1, 1.5]) {
      const result = await lab.client.callTool({
        name: "android_launch_app",
        arguments: { packageName: "com.example.app", waitReadySeconds },
      });
      expect(result.isError).toBe(true);
    }
    expect(adbLogLines(adbLog)).toEqual([]);
  });

  it("honours MCP cancellation during wait-ready so launch never starts", async () => {
    overwriteReadyAdb({
      logcat: "999.0  1  1 I lowmemorykiller: Kill 'app' (9)",
    });
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = lab.client.callTool(
      {
        name: "android_launch_app",
        arguments: { packageName: "com.example.app", waitReadySeconds: 30 },
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    let result: unknown;
    try {
      result = await pending;
    } catch {
      result = undefined;
    }
    expect(Date.now() - startedAt).toBeLessThan(2000);
    if (result !== undefined) {
      expect(parseToolJson(result).errors.join("\n")).toMatch(/aborted/);
    }
    expect(adbLogLines(adbLog).join("\n")).not.toMatch(/install -r|am start/);
  });

  it("returns the ui tree xml with secrets redacted", async () => {
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_get_ui_tree",
        arguments: {},
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.xml).toContain("<hierarchy");
    expect(report.xml).toContain("[REDACTED]");
    expect(report.xml).not.toContain(PLANTED_TOKEN);
    expect(adbLogLines(adbLog)).toContain(
      `-s ${FAKE_SERIAL} shell uiautomator dump /sdcard/pickforge-lab-ui.xml`,
    );
  });

  it("redacts secrets from android_logcat output", async () => {
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_logcat",
        arguments: { lines: 5 },
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.output).toContain("[REDACTED]");
    expect(report.output).not.toContain(PLANTED_TOKEN);
  });

  it("redacts secrets from android_run_adb output", async () => {
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_run_adb",
        arguments: { args: ["logcat", "-d", "-t", "5"] },
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.stdout).toContain("[REDACTED]");
    expect(report.stdout).not.toContain(PLANTED_TOKEN);
    expect(adbLogLines(adbLog)).toEqual([
      `-s ${FAKE_SERIAL} logcat -d -t 5`,
    ]);
  });

  it("captures a screenshot into a run with inline image content", async () => {
    const result = await lab.client.callTool({
      name: "android_screenshot",
      arguments: {},
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(true);
    expect(report.serial).toBe(FAKE_SERIAL);
    expect(report.runId).toBeDefined();
    const file = fs.readFileSync(report.path as string);
    expect(file.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);
    const content = result.content as Array<Record<string, any>>;
    const image = content.find((block) => block.type === "image");
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe("image/png");
    expect(
      Buffer.from(image?.data as string, "base64")
        .subarray(0, PNG_MAGIC.length)
        .equals(PNG_MAGIC),
    ).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(
          dirs.projectDir,
          ".picklab",
          "runs",
          report.runId as string,
          "manifest.json",
        ),
        "utf8",
      ),
    );
    expect(manifest.sessionId).toBe(sessionId);
    expect(manifest.evidenceVersion).toBe(1);
    expect(manifest.artifacts).toEqual([]);
    const records = await readActions(
      path.join(
        dirs.projectDir,
        ".picklab",
        "runs",
        report.runId as string,
      ),
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: "mcp",
      tool: "android_screenshot",
      sessionId,
      status: "ok",
    });
    expect(
      "artifacts" in records[0]! ? records[0].artifacts : undefined,
    ).toEqual([
      path.join("screenshots", path.basename(report.path as string)),
    ]);
  });

  it("uses an explicit serial without a session", async () => {
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_tap",
        arguments: { serial: "emulator-5556", x: 1, y: 2 },
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.serial).toBe("emulator-5556");
    expect(report.sessionId).toBeUndefined();
    expect(adbLogLines(adbLog)).toEqual([
      "-s emulator-5556 shell input tap 1 2",
    ]);
  });

  it("rejects passing both session and serial", async () => {
    const result = await lab.client.callTool({
      name: "android_tap",
      arguments: { session: sessionId, serial: "emulator-5556", x: 1, y: 2 },
    });
    expect(result.isError).toBe(true);
  });

  it("surfaces session ambiguity instead of running serial-less adb", async () => {
    writeAndroidSessionRecord(dirs.home, dirs.projectDir, "emulator-5558");
    const result = await lab.client.callTool({
      name: "android_run_adb",
      arguments: { args: ["devices"] },
    });
    expect(result.isError).toBe(true);
    const report = parseToolJson(result);
    expect(report.errors[0]).toContain("Multiple running android sessions");
    expect(adbLogLines(adbLog)).toEqual([]);
  });

  it("marks inline screenshots with inlineImage in the tool data", async () => {
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_screenshot",
        arguments: {},
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.inlineImage).toBe(true);
  });
});

describe("android_start (fake sdk)", () => {
  it("starts and destroys an emulator session", async () => {
    const startDirs = makeLabDirs();
    const { sdk, pidFile, avdHome } = makeFakeAndroidSdk(startDirs.root);
    const startLab = await connectLab({
      projectDir: startDirs.projectDir,
      env: {
        PICKFORGE_HOME: startDirs.home,
        PATH: startDirs.binDir,
        ANDROID_HOME: sdk,
        ANDROID_AVD_HOME: avdHome,
      },
    });
    try {
      const started = parseToolJson(
        await startLab.client.callTool({
          name: "android_start",
          arguments: {},
        }),
      );
      expect(started.ok).toBe(true);
      const session = started.sessions[0];
      expect(session.id).toMatch(/^andr-[0-9a-f]+$/);
      expect(session.avdName).toBe("pickforge-avd");
      expect(session.serial).toMatch(/^emulator-\d+$/);

      const [activeManifest] = await listRuns(startDirs.projectDir);
      expect(activeManifest).toMatchObject({
        sessionId: session.id,
        status: "running",
        evidenceVersion: 1,
      });
      expect(
        await readActions(
          path.join(
            startDirs.projectDir,
            ".picklab",
            "runs",
            activeManifest!.runId,
          ),
        ),
      ).toMatchObject([
        {
          source: "mcp",
          tool: "android_start",
          sessionId: session.id,
          status: "ok",
        },
      ]);

      const destroyed = parseToolJson(
        await startLab.client.callTool({
          name: "session_destroy",
          arguments: { sessionId: session.id },
        }),
      );
      expect(destroyed.ok).toBe(true);
      expect(destroyed.destroyed).toEqual([session.id]);
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      expect(() => process.kill(pid, 0)).toThrow();
      const [finalizedManifest] = await listRuns(startDirs.projectDir);
      expect(finalizedManifest).toMatchObject({
        runId: activeManifest!.runId,
        status: "completed",
      });
      expect(
        await readActions(
          path.join(
            startDirs.projectDir,
            ".picklab",
            "runs",
            finalizedManifest!.runId,
          ),
        ),
      ).toMatchObject([
        { tool: "android_start", status: "ok" },
        { tool: "session_destroy", status: "ok" },
      ]);
      expect(
        await fs.promises.readFile(
          path.join(
            startDirs.projectDir,
            ".picklab",
            "runs",
            finalizedManifest!.runId,
            "report.html",
          ),
          "utf8",
        ),
      ).toContain("session_destroy");
      expect(
        fs.existsSync(await activePointerPath(startDirs.projectDir, session.id)),
      ).toBe(false);
    } finally {
      killFakeEmulator(pidFile);
      await startLab.close();
      removeLabDirs(startDirs);
    }
  }, 60_000);

  it("emits progress notifications while the emulator boots", async () => {
    const startDirs = makeLabDirs();
    const { sdk, pidFile, avdHome } = makeFakeAndroidSdk(startDirs.root, {
      bootAfterPolls: 2,
    });
    const startLab = await connectLab({
      projectDir: startDirs.projectDir,
      env: {
        PICKFORGE_HOME: startDirs.home,
        PATH: startDirs.binDir,
        ANDROID_HOME: sdk,
        ANDROID_AVD_HOME: avdHome,
      },
    });
    const progress: Array<{ progress: number; message?: string }> = [];
    try {
      const started = parseToolJson(
        await startLab.client.callTool(
          { name: "android_start", arguments: {} },
          {
            timeout: 9_000,
            resetTimeoutOnProgress: true,
            onprogress: (notification) => {
              progress.push(notification);
            },
          },
        ),
      );
      expect(started.ok).toBe(true);
      expect(progress.length).toBeGreaterThanOrEqual(1);
      expect(
        progress.some((entry) => /boot|emulator/i.test(entry.message ?? "")),
      ).toBe(true);
    } finally {
      killFakeEmulator(pidFile);
      await startLab.close();
      removeLabDirs(startDirs);
    }
  }, 10_000);
});
