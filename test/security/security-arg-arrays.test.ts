// Security guarantee 2: user inputs are spawned as argument arrays, never as
// shell strings.
//
// Proven statically (no shell:true / exec / execSync anywhere in src) and
// behaviorally: shell metacharacters travel verbatim through every user-input
// path (core runCommand, desktop and android argv builders, the android adb
// layer, the MCP android_run_adb tool, and the built CLI), and a canary file
// targeted by `$(touch ...)` style payloads is never created.

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildKeyeventArgs,
  buildTapArgs,
  buildTypeTextArgs,
  escapeInputText,
  runAdb,
  tap,
  typeText,
} from "../../packages/android/src/index.js";
import { runCommand } from "../../packages/core/src/index.js";
import {
  buildClickArgs,
  buildDoubleClickArgs,
  buildDragArgs,
  buildKeyArgs,
  buildMoveArgs,
  buildScrollArgs,
  buildTypeArgs,
} from "../../packages/desktop-linux/src/index.js";
import { ensureCliBuilt } from "../../packages/cli/test/build-once.js";
import {
  connectLab,
  FAKE_SERIAL,
  makeLabDirs,
  parseToolJson,
  removeLabDirs,
  writeAndroidSessionRecord,
  type ConnectedLab,
  type LabDirs,
} from "../../packages/mcp-server/test/helpers.js";
import {
  listPackageSourceFiles,
  makeRecorderAdbSdk,
  readRecordedInvocations,
  runBuiltCli,
} from "./util.js";

describe("static: no shell execution primitives in any package source", () => {
  const files = listPackageSourceFiles();

  it("scans a non-trivial source tree", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("never passes shell: true to a spawn", () => {
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      const shellOptions = content.match(/\bshell\s*:\s*[^,\n}]+/g) ?? [];
      for (const option of shellOptions) {
        expect({ file, option: option.trim() }).toEqual({
          file,
          option: "shell: false",
        });
      }
    }
  });

  it("never calls exec, execSync, execFile, or execFileSync", () => {
    // Excludes method calls like `pattern.exec(...)` (RegExp.prototype.exec).
    const re = /(?<![.\w$])exec(?:File)?(?:Sync)?\s*\(/g;
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      expect({ file, calls: content.match(re) ?? [] }).toEqual({
        file,
        calls: [],
      });
    }
  });

  it("imports only spawn/spawnSync from node:child_process", () => {
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toMatch(/require\s*\(\s*["'](node:)?child_process/);
      for (const match of content.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g,
      )) {
        const names = match[1]
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== "");
        for (const name of names) {
          expect({ file, name, allowed: /^(type\s+\w+|spawn|spawnSync)$/.test(name) })
            .toEqual({ file, name, allowed: true });
        }
      }
    }
  });
});

describe("behavioral: core runCommand", () => {
  let dirs: LabDirs;

  beforeAll(() => {
    dirs = makeLabDirs();
  });

  afterAll(() => {
    removeLabDirs(dirs);
  });

  it("delivers shell metacharacters verbatim and never expands them", async () => {
    const canary = path.join(dirs.root, "CANARY-core");
    const printer = path.join(dirs.root, "print-argv.cjs");
    fs.writeFileSync(
      printer,
      "console.log(JSON.stringify(process.argv.slice(2)));\n",
    );
    const hostile = [
      `; touch ${canary}`,
      `$(touch ${canary})`,
      "`touch " + canary + "`",
      `&& touch ${canary}`,
      `| touch ${canary}`,
      `> ${canary}`,
      `'; touch ${canary} #`,
      '" ; touch CANARY ; "',
    ];
    const result = await runCommand(process.execPath, [printer, ...hostile]);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual(hostile);
    expect(fs.existsSync(canary)).toBe(false);
  });
});

describe("behavioral: desktop input builders (pure argv)", () => {
  const hostile = "$(touch /tmp/pickforge-lab-canary) `evil` ; rm -rf /tmp/x | cat";

  it("keeps hostile text as a single argv element after --", () => {
    expect(buildTypeArgs(hostile)).toEqual([
      "type",
      "--delay",
      "50",
      "--",
      hostile,
    ]);
  });

  it("keeps hostile key chords as a single argv element after --", () => {
    expect(buildKeyArgs(hostile)).toEqual(["key", "--", hostile]);
  });

  it("builds click argv from validated integers only", () => {
    expect(buildClickArgs({ x: 10, y: 20 })).toEqual([
      "mousemove",
      "--sync",
      "10",
      "20",
      "click",
      "1",
    ]);
    expect(() => buildClickArgs({ x: 1.5, y: 2 })).toThrow(/Invalid x/);
  });

  it("builds move, scroll, drag, and double-click argv from validated numbers only", () => {
    expect(buildMoveArgs({ x: 3, y: 4 })).toEqual([
      "mousemove",
      "--sync",
      "3",
      "4",
    ]);
    expect(buildScrollArgs({ deltaX: 0, deltaY: -1 })).toEqual(["click", "4"]);
    expect(
      buildDragArgs({ fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: 100 }),
    ).toEqual([
      "mousemove",
      "--sync",
      "0",
      "0",
      "mousedown",
      "1",
      "sleep",
      "0.05",
      "mousemove",
      "--sync",
      "1",
      "1",
      "sleep",
      "0.05",
      "mouseup",
      "1",
    ]);
    expect(buildDoubleClickArgs({ x: 2, y: 2, intervalMs: 50 })).toEqual([
      "mousemove",
      "--sync",
      "2",
      "2",
      "click",
      "--repeat",
      "2",
      "--delay",
      "50",
      "1",
    ]);
    expect(() => buildMoveArgs({ x: Number.NaN, y: 2 })).toThrow(/Invalid x/);
    expect(() => buildScrollArgs({ deltaX: 0.5, deltaY: 0 })).toThrow(
      /Invalid deltaX/,
    );
    expect(() =>
      buildDragArgs({ fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: 1.5 }),
    ).toThrow(/Invalid durationMs/);
    expect(() =>
      buildDoubleClickArgs({ x: 0, y: 0, intervalMs: Number.NaN }),
    ).toThrow(/Invalid intervalMs/);
  });
});

describe("behavioral: android argv builders", () => {
  it("rejects serials containing shell metacharacters", () => {
    expect(() => buildTapArgs("emulator-5554; rm -rf /", 1, 2)).toThrow(
      /Invalid device serial/,
    );
    expect(() => buildTypeTextArgs("$(evil)", "hi")).toThrow(
      /Invalid device serial/,
    );
  });

  it("rejects keyevents that are not KEYCODE names or digits", () => {
    expect(() => buildKeyeventArgs(FAKE_SERIAL, "1; reboot")).toThrow(
      /Invalid key/,
    );
  });

  it("escapes every device-shell metacharacter in typed text", () => {
    expect(escapeInputText("a b")).toBe("a%sb");
    expect(escapeInputText("$`\"'\\;&|()<>*~")).toBe(
      "\\$\\`\\\"\\'\\\\\\;\\&\\|\\(\\)\\<\\>\\*\\~",
    );
  });

  it("emits hostile text as one escaped argv element", () => {
    expect(buildTypeTextArgs(FAKE_SERIAL, "$(touch /tmp/pwn) `evil`")).toEqual([
      "-s",
      FAKE_SERIAL,
      "shell",
      "input",
      "text",
      "\\$\\(touch%s/tmp/pwn\\)%s\\`evil\\`",
    ]);
  });
});

describe("behavioral: android adb layer (recorder adb)", () => {
  let dirs: LabDirs;
  let record: string;
  let env: Record<string, string>;
  let canary: string;

  beforeAll(() => {
    dirs = makeLabDirs();
    record = path.join(dirs.root, "adb-record.log");
    canary = path.join(dirs.root, "CANARY-adb");
    const sdk = makeRecorderAdbSdk(dirs.root, { record });
    env = { PATH: dirs.binDir, ANDROID_HOME: sdk };
  });

  afterAll(() => {
    removeLabDirs(dirs);
  });

  it("passes tap, type, and raw adb args with exact boundaries", async () => {
    await tap({ serial: FAKE_SERIAL, x: 5, y: 9, env });
    await typeText({
      serial: FAKE_SERIAL,
      text: `$(touch ${canary})`,
      env,
    });
    const result = await runAdb({
      serial: FAKE_SERIAL,
      args: ["shell", "echo", `$(touch ${canary})`, `; touch ${canary}`],
      env,
    });
    expect(result.ok).toBe(true);

    expect(readRecordedInvocations(record)).toEqual([
      ["-s", FAKE_SERIAL, "shell", "input", "tap", "5", "9"],
      [
        "-s",
        FAKE_SERIAL,
        "shell",
        "input",
        "text",
        `\\$\\(touch%s${canary}\\)`,
      ],
      [
        "-s",
        FAKE_SERIAL,
        "shell",
        "echo",
        `$(touch ${canary})`,
        `; touch ${canary}`,
      ],
    ]);
    expect(fs.existsSync(canary)).toBe(false);
  });
});

describe("behavioral: MCP android_run_adb (InMemoryTransport + recorder adb)", () => {
  let dirs: LabDirs;
  let lab: ConnectedLab;
  let record: string;
  let canary: string;

  beforeAll(async () => {
    dirs = makeLabDirs();
    record = path.join(dirs.root, "adb-record.log");
    canary = path.join(dirs.root, "CANARY-mcp");
    const sdk = makeRecorderAdbSdk(dirs.root, { record });
    writeAndroidSessionRecord(dirs.home, dirs.projectDir);
    lab = await connectLab({
      projectDir: dirs.projectDir,
      env: {
        HOME: dirs.home,
        PICKLAB_HOME: dirs.home,
        PATH: dirs.binDir,
        ANDROID_HOME: sdk,
      },
    });
  });

  afterAll(async () => {
    await lab.close();
    removeLabDirs(dirs);
  });

  it("hands hostile tool arguments to adb verbatim, unexpanded", async () => {
    const hostileArgs = [
      "shell",
      "echo",
      `$(touch ${canary})`,
      "`touch " + canary + "`",
      `; touch ${canary}`,
    ];
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_run_adb",
        arguments: { args: hostileArgs },
      }),
    );
    expect(report.ok).toBe(true);
    expect(readRecordedInvocations(record)).toEqual([
      ["-s", FAKE_SERIAL, ...hostileArgs],
    ]);
    expect(fs.existsSync(canary)).toBe(false);
  });
});

describe("behavioral: built CLI (spawned pickforge-lab binary)", () => {
  let dirs: LabDirs;
  let record: string;
  let canary: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    await ensureCliBuilt();
    dirs = makeLabDirs();
    record = path.join(dirs.root, "adb-record.log");
    canary = path.join(dirs.root, "CANARY-cli");
    const sdk = makeRecorderAdbSdk(dirs.root, { record });
    env = {
      HOME: dirs.home,
      PICKLAB_HOME: dirs.home,
      PATH: dirs.binDir,
      ANDROID_HOME: sdk,
    };
  }, 300_000);

  afterEach(() => {
    fs.rmSync(record, { force: true });
  });

  afterAll(() => {
    removeLabDirs(dirs);
  });

  it("escapes hostile text typed through pickforge-lab android type", async () => {
    const result = await runBuiltCli(
      [
        "android",
        "type",
        `$(touch ${canary})`,
        "--serial",
        FAKE_SERIAL,
        "--json",
      ],
      env,
      dirs.projectDir,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    expect(readRecordedInvocations(record)).toEqual([
      [
        "-s",
        FAKE_SERIAL,
        "shell",
        "input",
        "text",
        `\\$\\(touch%s${canary}\\)`,
      ],
    ]);
    expect(fs.existsSync(canary)).toBe(false);
  });

  it("passes hostile raw adb args through pickforge-lab android adb verbatim", async () => {
    const result = await runBuiltCli(
      [
        "android",
        "adb",
        "--serial",
        FAKE_SERIAL,
        "--json",
        "--",
        "shell",
        "echo",
        `$(touch ${canary})`,
      ],
      env,
      dirs.projectDir,
    );
    expect(result.code).toBe(0);
    expect(readRecordedInvocations(record)).toEqual([
      ["-s", FAKE_SERIAL, "shell", "echo", `$(touch ${canary})`],
    ]);
    expect(fs.existsSync(canary)).toBe(false);
  });
});
