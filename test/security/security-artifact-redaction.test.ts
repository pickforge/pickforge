// Security guarantee 3: artifacts and log outputs do not contain secrets by
// default.
//
// Planted GitHub, OpenAI-style, and AWS credentials must come out as
// [REDACTED] from the MCP android_logcat tool, the MCP ui-tree tool, the
// pickforge://runs/{id}/logs/{name} resource, and the built CLI logcat command;
// run manifests must never embed environment values.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCliBuilt } from "../../packages/cli/test/build-once.js";
import {
  connectLab,
  FAKE_SERIAL,
  makeLabDirs,
  parseToolJson,
  removeLabDirs,
  writeAndroidSessionRecord,
  writeSyntheticRun,
  type ConnectedLab,
  type LabDirs,
} from "../../packages/mcp-server/test/helpers.js";
import {
  listFilesRecursive,
  makeRecorderAdbSdk,
  runBuiltCli,
} from "./util.js";

const GITHUB_TOKEN = `ghp_${"A".repeat(36)}`;
const OPENAI_KEY = `sk-${"a".repeat(24)}`;
const AWS_KEY = `AKIA${"B".repeat(16)}`;
const PLANTED = [GITHUB_TOKEN, OPENAI_KEY, AWS_KEY];

const LOGCAT_LINES = [
  `I/Auth( 101): GITHUB_TOKEN=${GITHUB_TOKEN}`,
  `I/Net( 102): api_key: ${OPENAI_KEY}`,
  `I/Aws( 103): using ${AWS_KEY} for upload`,
  "I/App( 104): plain boot line",
];

const UI_TREE_XML =
  '<?xml version="1.0"?><hierarchy rotation="0">' +
  `<node text="password=${GITHUB_TOKEN}" /></hierarchy>`;

function expectRedacted(text: string): void {
  expect(text).toContain("[REDACTED]");
  for (const secret of PLANTED) {
    expect(text).not.toContain(secret);
  }
}

describe("MCP tool outputs (fake adb with planted secrets)", () => {
  let dirs: LabDirs;
  let lab: ConnectedLab;

  beforeAll(async () => {
    dirs = makeLabDirs();
    const sdk = makeRecorderAdbSdk(dirs.root, {
      record: path.join(dirs.root, "adb-record.log"),
      logcatLines: LOGCAT_LINES,
      uiTreeXml: UI_TREE_XML,
    });
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

  it("redacts github, openai, and aws credentials from android_logcat", async () => {
    const report = parseToolJson(
      await lab.client.callTool({ name: "android_logcat", arguments: {} }),
    );
    expect(report.ok).toBe(true);
    expectRedacted(report.output as string);
    expect(report.output).toContain("plain boot line");
    expect(report.output).toContain("GITHUB_TOKEN=[REDACTED]");
  });

  it("redacts secrets from android_run_adb output", async () => {
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_run_adb",
        arguments: { args: ["logcat", "-d"] },
      }),
    );
    expect(report.ok).toBe(true);
    expectRedacted(report.stdout as string);
  });

  it("redacts secrets from the android UI tree", async () => {
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_get_ui_tree",
        arguments: {},
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.xml).toContain("[REDACTED]");
    expect(report.xml).not.toContain(GITHUB_TOKEN);
  });
});

describe("MCP run-log resource (planted log on disk)", () => {
  const RUN_ID = "20260609-130000-security";
  let dirs: LabDirs;
  let lab: ConnectedLab;

  beforeAll(async () => {
    dirs = makeLabDirs();
    writeSyntheticRun(dirs.projectDir, RUN_ID, {
      logBody: `boot ok\n${LOGCAT_LINES.join("\n")}\n`,
    });
    lab = await connectLab({
      projectDir: dirs.projectDir,
      env: { HOME: dirs.home, PICKLAB_HOME: dirs.home, PATH: dirs.binDir },
    });
  });

  afterAll(async () => {
    await lab.close();
    removeLabDirs(dirs);
  });

  it("serves pickforge://runs/{id}/logs/{name} with secrets redacted", async () => {
    const { contents } = await lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/logs/app.log`,
    });
    const text = (contents as Array<Record<string, unknown>>)[0]
      .text as string;
    expectRedacted(text);
    expect(text).toContain("boot ok");
  });
});

describe("run manifest hygiene (planted env secrets)", () => {
  const ENV_SECRET = `ghp_${"Z".repeat(36)}`;
  const ENV_PASSWORD = "hunter2-super-secret-value";
  let dirs: LabDirs;
  let lab: ConnectedLab;

  beforeAll(async () => {
    dirs = makeLabDirs();
    const sdk = makeRecorderAdbSdk(dirs.root, {
      record: path.join(dirs.root, "adb-record.log"),
    });
    writeAndroidSessionRecord(dirs.home, dirs.projectDir);
    lab = await connectLab({
      projectDir: dirs.projectDir,
      env: {
        HOME: dirs.home,
        PICKLAB_HOME: dirs.home,
        PATH: dirs.binDir,
        ANDROID_HOME: sdk,
        PICKLAB_TEST_SECRET: ENV_SECRET,
        DB_PASSWORD: ENV_PASSWORD,
      },
    });
  });

  afterAll(async () => {
    await lab.close();
    removeLabDirs(dirs);
  });

  it("writes run artifacts and manifests without embedding the environment", async () => {
    const report = parseToolJson(
      await lab.client.callTool({
        name: "android_screenshot",
        arguments: {},
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.runId).toBeDefined();

    const picklabDir = path.join(dirs.projectDir, ".picklab");
    const files = listFilesRecursive(picklabDir);
    expect(files.length).toBeGreaterThan(0);

    const manifestPath = path.join(
      picklabDir,
      "runs",
      report.runId as string,
      "manifest.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest).not.toHaveProperty("env");
    expect(manifest).not.toHaveProperty("meta.env");

    for (const file of files) {
      const content = fs.readFileSync(file, "latin1");
      expect({
        file,
        leaksEnvSecret:
          content.includes(ENV_SECRET) || content.includes(ENV_PASSWORD),
      }).toEqual({ file, leaksEnvSecret: false });
    }
  });
});

describe("built CLI logcat output", () => {
  let dirs: LabDirs;
  let env: Record<string, string>;

  beforeAll(async () => {
    await ensureCliBuilt();
    dirs = makeLabDirs();
    const sdk = makeRecorderAdbSdk(dirs.root, {
      record: path.join(dirs.root, "adb-record.log"),
      logcatLines: LOGCAT_LINES,
    });
    env = {
      HOME: dirs.home,
      PICKLAB_HOME: dirs.home,
      PATH: dirs.binDir,
      ANDROID_HOME: sdk,
    };
  }, 300_000);

  afterAll(() => {
    removeLabDirs(dirs);
  });

  it("redacts planted secrets from pickforge-lab android logcat (json)", async () => {
    const result = await runBuiltCli(
      ["android", "logcat", "--serial", FAKE_SERIAL, "--json"],
      env,
      dirs.projectDir,
    );
    expect(result.code).toBe(0);
    expectRedacted(result.stdout);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expectRedacted(report.output as string);
  });

  it("redacts planted secrets from pickforge-lab android logcat (plain)", async () => {
    const result = await runBuiltCli(
      ["android", "logcat", "--serial", FAKE_SERIAL],
      env,
      dirs.projectDir,
    );
    expect(result.code).toBe(0);
    expectRedacted(result.stdout);
    expect(result.stdout).toContain("plain boot line");
  });
});
