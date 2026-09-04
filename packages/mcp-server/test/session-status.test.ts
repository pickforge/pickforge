import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  connectLab,
  makeLabDirs,
  parseToolJson,
  removeLabDirs,
  writeDesktopSessionRecord,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

let dirs: LabDirs;
let lab: ConnectedLab;

beforeEach(async () => {
  dirs = makeLabDirs();
  lab = await connectLab({
    projectDir: dirs.projectDir,
    env: { PICKFORGE_HOME: dirs.home, PATH: dirs.binDir },
  });
});

afterEach(async () => {
  await lab.close();
  removeLabDirs(dirs);
});

describe("session_status", () => {
  it("reports dead when a running desktop session pid is gone", async () => {
    const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);

    const result = await lab.client.callTool({
      name: "session_status",
      arguments: { sessionId: id },
    });

    expect(result.isError).toBeFalsy();
    const report = parseToolJson(result);
    expect(report.sessions[0].id).toBe(id);
    expect(report.sessions[0].status).toBe("dead");
    expect(report.sessions[0].desktop.xvfbAlive).toBe(false);
  });

  it("reports viewer status without launching a host GUI", async () => {
    const marker = path.join(dirs.root, "viewer-opened");
    const viewer = path.join(dirs.binDir, "remote-viewer");
    fs.writeFileSync(
      viewer,
      `#!/bin/sh\nprintf opened > ${JSON.stringify(marker)}\n`,
    );
    fs.chmodSync(viewer, 0o755);
    const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);

    const result = await lab.client.callTool({
      name: "session_status",
      arguments: { sessionId: id },
    });
    const report = parseToolJson(result);
    expect(report.sessions[0].viewer).toEqual({
      endpoint: null,
      ready: false,
      readOnly: false,
      hostGuiLaunchSupported: false,
    });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
