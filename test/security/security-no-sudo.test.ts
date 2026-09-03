// Security guarantee 1: MCP tools never invoke sudo.
//
// Proven three ways:
//   1. Statically: the mcp-server source tree contains no "sudo" and never
//      imports the CLI provisioning code (the only sudo user in PickLab).
//   2. Behaviorally: the MCP server runs a representative tool set with a
//      poisoned PATH where "sudo" is a recorder script; the recorder file
//      must stay absent, and the tool list exposes no provisioning tools.
//   3. In the shipped bundle: the built pickforge-mcp entrypoint and every
//      chunk it imports contain zero "sudo" occurrences.

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureCliBuilt } from "../../packages/cli/test/build-once.js";
import {
  connectLab,
  killFakeEmulator,
  makeFakeAndroidSdk,
  makeLabDirs,
  parseToolJson,
  removeLabDirs,
  writeAndroidSessionRecord,
  writeFakeAdbSdk,
  type ConnectedLab,
  type LabDirs,
} from "../../packages/mcp-server/test/helpers.js";
import {
  listPackageSourceFiles,
  packagesDir,
  plantSudoRecorder,
} from "./util.js";

const PROVISIONING_TOOL_NAME =
  /(sudo|setup|provision|doctor|init|lab[-_]?user)/i;

const IMPORT_SPECIFIER_RE =
  /\b(?:import|export)\b[^"'\n]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function importSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe("static: mcp-server source", () => {
  const files = listPackageSourceFiles("mcp-server");

  it("contains no occurrence of sudo at all", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      expect({ file, containsSudo: /sudo/i.test(content) }).toEqual({
        file,
        containsSudo: false,
      });
    }
  });

  it("never imports the CLI package or its provisioning code", () => {
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(content)) {
        expect({ file, specifier, ok: !/provision/i.test(specifier) }).toEqual({
          file,
          specifier,
          ok: true,
        });
        expect({
          file,
          specifier,
          ok:
            specifier !== "pickforge" &&
            !specifier.includes("/cli/") &&
            !specifier.endsWith("/cli"),
        }).toEqual({ file, specifier, ok: true });
      }
    }
  });

  it("does not declare a dependency on the CLI package", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(packagesDir, "mcp-server", "package.json"),
        "utf8",
      ),
    ) as Record<string, Record<string, string> | undefined>;
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];
    expect(declared).not.toContain("pickforge");
  });
});

describe("behavioral: MCP server with poisoned PATH", () => {
  let dirs: LabDirs;
  let lab: ConnectedLab;
  let sudoRecord: string;

  beforeAll(async () => {
    dirs = makeLabDirs();
    sudoRecord = path.join(dirs.root, "sudo-invocations.log");
    plantSudoRecorder(dirs.binDir, sudoRecord);
    const adbLog = path.join(dirs.root, "adb.log");
    const sdk = writeFakeAdbSdk(dirs.root, adbLog);
    writeAndroidSessionRecord(dirs.home, dirs.projectDir);
    lab = await connectLab({
      projectDir: dirs.projectDir,
      env: {
        HOME: dirs.home,
        PICKFORGE_HOME: dirs.home,
        PATH: dirs.binDir,
        ANDROID_HOME: sdk,
      },
    });
  });

  afterAll(async () => {
    await lab.close();
    removeLabDirs(dirs);
  });

  it("exposes no provisioning, setup, or sudo tools", async () => {
    const { tools } = await lab.client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect({
        name: tool.name,
        looksPrivileged: PROVISIONING_TOOL_NAME.test(tool.name),
      }).toEqual({ name: tool.name, looksPrivileged: false });
    }
  });

  it("runs android, desktop, session, and artifact tools without touching sudo", async () => {
    const adb = parseToolJson(
      await lab.client.callTool({
        name: "android_run_adb",
        arguments: { args: ["shell", "pm", "list", "packages"] },
      }),
    );
    expect(adb.ok).toBe(true);

    await lab.client.callTool({
      name: "android_tap",
      arguments: { x: 1, y: 2 },
    });
    await lab.client.callTool({ name: "android_logcat", arguments: {} });
    await lab.client.callTool({ name: "android_get_ui_tree", arguments: {} });
    await lab.client.callTool({ name: "session_status", arguments: {} });
    await lab.client.callTool({ name: "artifact_list", arguments: {} });

    // Error paths must not escalate either: there is no desktop session and
    // no Xvfb on the poisoned PATH.
    const shot = await lab.client.callTool({
      name: "desktop_screenshot",
      arguments: {},
    });
    expect(shot.isError).toBe(true);
    const desktop = await lab.client.callTool({
      name: "session_create",
      arguments: { type: "desktop" },
    });
    expect(desktop.isError).toBe(true);

    expect(fs.existsSync(sudoRecord)).toBe(false);
  });

  it(
    "boots and destroys an emulator session without touching sudo",
    async () => {
      const startDirs = makeLabDirs();
      const startSudoRecord = path.join(startDirs.root, "sudo-invocations.log");
      plantSudoRecorder(startDirs.binDir, startSudoRecord);
      const { sdk, pidFile } = makeFakeAndroidSdk(startDirs.root);
      const startLab = await connectLab({
        projectDir: startDirs.projectDir,
        env: {
          HOME: startDirs.home,
          PICKFORGE_HOME: startDirs.home,
          PATH: startDirs.binDir,
          ANDROID_HOME: sdk,
        },
      });
      try {
        const started = parseToolJson(
          await startLab.client.callTool({
            name: "session_create",
            arguments: { type: "android" },
          }),
        );
        expect(started.ok).toBe(true);
        const destroyed = parseToolJson(
          await startLab.client.callTool({
            name: "session_destroy",
            arguments: { sessionId: started.sessions[0].id },
          }),
        );
        expect(destroyed.ok).toBe(true);
        expect(fs.existsSync(startSudoRecord)).toBe(false);
      } finally {
        killFakeEmulator(pidFile);
        await startLab.close();
        removeLabDirs(startDirs);
      }
    },
    60_000,
  );
});

describe("bundle: built pickforge-mcp entrypoint", () => {
  const distDir = path.join(packagesDir, "cli", "dist");

  beforeAll(async () => {
    await ensureCliBuilt();
  }, 300_000);

  function bundleFiles(entry: string): Map<string, string> {
    const contents = new Map<string, string>();
    const queue = [entry];
    while (queue.length > 0) {
      const name = queue.pop() as string;
      if (contents.has(name)) continue;
      const content = fs.readFileSync(path.join(distDir, name), "utf8");
      contents.set(name, content);
      for (const match of content.matchAll(
        /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.\.?\/[^"']+)["']/g,
      )) {
        queue.push(path.normalize(path.join(path.dirname(name), match[1])));
      }
    }
    return contents;
  }

  it("contains zero sudo occurrences across all imported chunks", () => {
    const contents = bundleFiles("pickforge-lab-mcp.js");
    // The entrypoint plus at least one shared chunk must have been scanned.
    expect(contents.size).toBeGreaterThanOrEqual(2);
    for (const [name, content] of contents) {
      expect({ name, sudoOccurrences: content.match(/sudo/gi) ?? [] }).toEqual(
        { name, sudoOccurrences: [] },
      );
    }
  });

  it("control: the scanner does find sudo in the CLI bundle that owns provisioning", () => {
    const contents = bundleFiles("picklab.js");
    const total = [...contents.values()]
      .map((content) => content.match(/sudo/gi)?.length ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });
});
