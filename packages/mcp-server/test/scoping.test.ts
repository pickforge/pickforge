import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectLab,
  makeLabDirs,
  parseToolJson,
  removeLabDirs,
  writeAndroidSessionRecord,
  writeFakeAdbSdk,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

let dirs: LabDirs;
let projectA: string;
let projectB: string;
let labA: ConnectedLab;
let labB: ConnectedLab;
let sessionA: string;
let sessionB: string;

beforeEach(async () => {
  dirs = makeLabDirs();
  projectA = path.join(dirs.root, "project-a");
  projectB = path.join(dirs.root, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  const sdk = writeFakeAdbSdk(dirs.root, path.join(dirs.root, "adb.log"));
  const env = {
    PICKFORGE_HOME: dirs.home,
    PATH: dirs.binDir,
    ANDROID_HOME: sdk,
  };
  sessionA = writeAndroidSessionRecord(dirs.home, projectA, "emulator-5554");
  sessionB = writeAndroidSessionRecord(dirs.home, projectB, "emulator-5556");
  labA = await connectLab({ projectDir: projectA, env });
  labB = await connectLab({ projectDir: projectB, env });
});

afterEach(async () => {
  await labA.close();
  await labB.close();
  removeLabDirs(dirs);
});

describe("project-scoped default session resolution", () => {
  it("resolves each server's default session to its own project", async () => {
    const tapA = parseToolJson(
      await labA.client.callTool({
        name: "android_tap",
        arguments: { x: 1, y: 2 },
      }),
    );
    const tapB = parseToolJson(
      await labB.client.callTool({
        name: "android_tap",
        arguments: { x: 1, y: 2 },
      }),
    );
    expect(tapA.ok).toBe(true);
    expect(tapA.sessionId).toBe(sessionA);
    expect(tapA.serial).toBe("emulator-5554");
    expect(tapB.ok).toBe(true);
    expect(tapB.sessionId).toBe(sessionB);
    expect(tapB.serial).toBe("emulator-5556");
  });

  it("reports a project-scoped error when the project has no session", async () => {
    const projectC = path.join(dirs.root, "project-c");
    fs.mkdirSync(projectC, { recursive: true });
    const labC = await connectLab({
      projectDir: projectC,
      env: { PICKFORGE_HOME: dirs.home, PATH: dirs.binDir },
    });
    try {
      const result = await labC.client.callTool({
        name: "android_tap",
        arguments: { x: 1, y: 2 },
      });
      expect(result.isError).toBe(true);
      const report = parseToolJson(result);
      expect(report.errors[0]).toContain(
        "No running android session for this project",
      );
      expect(report.errors[0]).toContain("session_create");
    } finally {
      await labC.close();
    }
  });

  it("still reaches another project's session via an explicit id", async () => {
    const tap = parseToolJson(
      await labA.client.callTool({
        name: "android_tap",
        arguments: { x: 1, y: 2, session: sessionB },
      }),
    );
    expect(tap.ok).toBe(true);
    expect(tap.sessionId).toBe(sessionB);
    expect(tap.serial).toBe("emulator-5556");
  });
});
