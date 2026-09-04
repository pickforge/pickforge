import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessGroupAlive } from "@pickforge/picklab-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { imageContent } from "../src/context.js";
import { createMcpServer } from "../src/index.js";
import {
  connectLab,
  makeLabDirs,
  parseToolJson,
  PLANTED_TOKEN,
  removeLabDirs,
  writeDesktopSessionRecord,
  writeScript,
  writeSyntheticRun,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

const EXPECTED_TOOLS = [
  "session_create",
  "session_status",
  "session_destroy",
  "desktop_launch",
  "desktop_exec",
  "desktop_screenshot",
  "desktop_click",
  "desktop_move",
  "desktop_scroll",
  "desktop_drag",
  "desktop_double_click",
  "desktop_type",
  "desktop_key",
  "android_start",
  "android_install_apk",
  "android_launch_app",
  "android_screenshot",
  "android_tap",
  "android_type",
  "android_back",
  "android_home",
  "android_get_ui_tree",
  "android_logcat",
  "android_run_adb",
  "artifact_list",
  "artifact_report",
  "takeover_status",
  "request_user_input",
];

let dirs: LabDirs;
let lab: ConnectedLab;

beforeEach(async () => {
  dirs = makeLabDirs();
  lab = await connectLab({
    projectDir: dirs.projectDir,
    env: { PICKLAB_HOME: dirs.home, PATH: dirs.binDir },
  });
});

afterEach(async () => {
  await lab.close();
  removeLabDirs(dirs);
});

describe("tool inventory", () => {
  it("lists every PickLab tool with an input schema and description", async () => {
    const { tools } = await lab.client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description).toBeTruthy();
    }
  });

  it("declares required coordinates for click and tap", async () => {
    const { tools } = await lab.client.listTools();
    const click = tools.find((tool) => tool.name === "desktop_click");
    const tap = tools.find((tool) => tool.name === "android_tap");
    expect(click?.inputSchema.required).toEqual(
      expect.arrayContaining(["x", "y"]),
    );
    expect(tap?.inputSchema.required).toEqual(
      expect.arrayContaining(["x", "y"]),
    );
  });

  it("declares required arguments for the desktop input tools", async () => {
    const { tools } = await lab.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("desktop_move")?.inputSchema.required).toEqual(
      expect.arrayContaining(["x", "y"]),
    );
    expect(byName.get("desktop_scroll")?.inputSchema.required).toEqual(
      expect.arrayContaining(["deltaX", "deltaY"]),
    );
    expect(byName.get("desktop_scroll")?.inputSchema.required).not.toEqual(
      expect.arrayContaining(["x", "y"]),
    );
    expect(byName.get("desktop_drag")?.inputSchema.required).toEqual(
      expect.arrayContaining(["fromX", "fromY", "toX", "toY"]),
    );
    expect(byName.get("desktop_drag")?.inputSchema.required).not.toEqual(
      expect.arrayContaining(["button", "durationMs"]),
    );
    expect(byName.get("desktop_double_click")?.inputSchema.required).toEqual(
      expect.arrayContaining(["x", "y"]),
    );
    expect(
      byName.get("desktop_double_click")?.inputSchema.required,
    ).not.toEqual(expect.arrayContaining(["button", "intervalMs"]));
  });
});

describe("input validation", () => {
  it("rejects an invalid session type", async () => {
    const result = await lab.client.callTool({
      name: "session_create",
      arguments: { type: "mainframe" },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects non-integer coordinates", async () => {
    const result = await lab.client.callTool({
      name: "desktop_click",
      arguments: { x: "10", y: 20 },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects invalid desktop_move coordinates", async () => {
    for (const args of [
      { x: -1, y: 2 },
      { x: 1.5, y: 2 },
      { x: 1 },
    ]) {
      const result = await lab.client.callTool({
        name: "desktop_move",
        arguments: args,
      });
      expect(result.isError).toBe(true);
    }
  });

  it("rejects invalid desktop_scroll deltas and positions", async () => {
    for (const args of [
      { deltaX: 0.5, deltaY: 0 },
      { deltaX: 0, deltaY: 101 },
      { deltaX: -101, deltaY: 0 },
      { deltaX: 0 },
      { deltaX: 0, deltaY: 1, x: -1, y: 2 },
    ]) {
      const result = await lab.client.callTool({
        name: "desktop_scroll",
        arguments: args,
      });
      expect(result.isError).toBe(true);
    }
  });

  it("rejects invalid desktop_drag buttons and durations", async () => {
    for (const args of [
      { fromX: 0, fromY: 0, toX: 1, toY: 1, button: 0 },
      { fromX: 0, fromY: 0, toX: 1, toY: 1, button: 10 },
      { fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: -1 },
      { fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: 10_001 },
      { fromX: 0, fromY: 0, toX: 1 },
      { fromX: -1, fromY: 0, toX: 1, toY: 1 },
    ]) {
      const result = await lab.client.callTool({
        name: "desktop_drag",
        arguments: args,
      });
      expect(result.isError).toBe(true);
    }
  });

  it("rejects invalid desktop_double_click buttons and intervals", async () => {
    for (const args of [
      { x: 0, y: 0, button: 0 },
      { x: 0, y: 0, button: 10 },
      { x: 0, y: 0, intervalMs: -1 },
      { x: 0, y: 0, intervalMs: 2_001 },
      { x: 0, y: 0.5 },
    ]) {
      const result = await lab.client.callTool({
        name: "desktop_double_click",
        arguments: args,
      });
      expect(result.isError).toBe(true);
    }
  });

  it("rejects negative tap coordinates", async () => {
    const result = await lab.client.callTool({
      name: "android_tap",
      arguments: { x: -1, y: 5 },
    });
    expect(result.isError).toBe(true);
  });

  it("rejects missing required arguments", async () => {
    const result = await lab.client.callTool({
      name: "android_install_apk",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it("rejects empty adb argument lists", async () => {
    const result = await lab.client.callTool({
      name: "android_run_adb",
      arguments: { args: [] },
    });
    expect(result.isError).toBe(true);
  });
});

describe("artifact report", () => {
  it("includes a deterministic redacted evidence timeline", async () => {
    const runId = "20260609-120000-evidence";
    const { dir } = writeSyntheticRun(dirs.projectDir, runId);
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.evidenceVersion = 1;
    manifest.actionLog = "actions.jsonl";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(
      path.join(dir, "actions.jsonl"),
      [
        JSON.stringify({
          actionId: "second",
          source: "mcp",
          tool: "desktop_type",
          startedAt: "2026-06-09T12:00:04.000Z",
          status: "error",
          error: `Authorization: Bearer ${PLANTED_TOKEN}`,
        }),
        JSON.stringify({
          actionId: "first",
          source: "mcp",
          tool: "desktop_click",
          startedAt: "2026-06-09T12:00:03.000Z",
          status: "ok",
        }),
        "",
      ].join("\n"),
    );

    const result = await lab.client.callTool({
      name: "artifact_report",
      arguments: { runId },
    });
    expect(result.isError).toBeFalsy();
    const report = parseToolJson(result).report as string;
    expect(report.indexOf("Step 1 — mcp / desktop_click")).toBeLessThan(
      report.indexOf("Step 2 — mcp / desktop_type"),
    );
    expect(report).toContain("[REDACTED]");
    expect(report).not.toContain(PLANTED_TOKEN);
  });

  it("fails closed for an unsafe evidence journal", async () => {
    const runId = "20260609-120000-unsafe-evidence";
    const { dir } = writeSyntheticRun(dirs.projectDir, runId);
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.evidenceVersion = 1;
    manifest.actionLog = "actions.jsonl";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.symlinkSync(manifestPath, path.join(dir, "actions.jsonl"));

    const result = await lab.client.callTool({
      name: "artifact_report",
      arguments: { runId },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Unsafe run catalog file");
  });
});

describe("desktop isolation tools", () => {
  it.each(["desktop_launch", "desktop_exec"])(
    "confines %s cwd to the project directory",
    async (tool) => {
      const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
      for (const cwd of ["/etc", "../"]) {
        const result = await lab.client.callTool({
          name: tool,
          arguments: { session: id, command: "true", cwd },
        });
        expect(result.isError).toBe(true);
        expect(parseToolJson(result).errors.join("\n")).toContain(
          "working directory outside the project directory",
        );
      }
    },
  );

  it("executes a command as an argv array and waits for its client window", async () => {
    const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
    const searchMarker = path.join(dirs.root, "xdotool-searched");
    writeScript(
      path.join(dirs.binDir, "xdotool"),
      'case "$1" in\n  search)\n' +
        `    if [ -f "${searchMarker}" ]; then echo 4242; else : > "${searchMarker}"; exit 1; fi ;;\n` +
        "  getwindowname) echo picklab-mcp-window ;;\nesac",
    );
    const command = path.join(dirs.root, "mcp-exec");
    const capture = path.join(dirs.root, "mcp-exec.txt");
    writeScript(
      command,
      `printf 'DISPLAY=%s\\nGDK_BACKEND=%s\\nARG=%s\\n' "$DISPLAY" "$GDK_BACKEND" "$1" > "${capture}"\nexec /bin/sleep 30`,
    );

    const result = await lab.client.callTool({
      name: "desktop_exec",
      arguments: {
        session: id,
        command,
        args: ["hello world"],
        windowTimeoutMs: 1000,
      },
    });
    const report = parseToolJson(result);
    try {
      expect(report.ok).toBe(true);
      expect(report.processGroupId).toBe(report.pid);
      expect(report.windowCount).toBe(1);
      expect(report.windows).toEqual([
        { id: "4242", name: "picklab-mcp-window" },
      ]);
      expect(fs.readFileSync(capture, "utf8")).toBe(
        "DISPLAY=:987\nGDK_BACKEND=x11\nARG=hello world\n",
      );
    } finally {
      if (typeof report.pid === "number") {
        try {
          process.kill(-report.pid, "SIGTERM");
        } catch {
          // The test command has already exited.
        }
      }
    }
  });

  it("stops a possibly escaped command when no client window appears", async () => {
    const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
    const pidFile = path.join(dirs.root, "windowless.pid");
    const command = path.join(dirs.root, "windowless-command");
    writeScript(path.join(dirs.binDir, "xdotool"), "exit 1");
    writeScript(command, `echo $$ > "${pidFile}"\nexec /bin/sleep 30`);

    const result = await lab.client.callTool({
      name: "desktop_exec",
      arguments: { session: id, command, windowTimeoutMs: 100 },
    });

    expect(result.isError).toBe(true);
    const report = parseToolJson(result);
    expect(report.errors.join("\n")).toContain("PickLab stopped process group");
    expect(report.errors.join("\n")).toContain("--window-timeout");
    const processGroupId = Number(fs.readFileSync(pidFile, "utf8").trim());
    const deadline = Date.now() + 2_000;
    while (isProcessGroupAlive(processGroupId) && Date.now() < deadline) {
      await sleep(20);
    }
    expect(isProcessGroupAlive(processGroupId)).toBe(false);
  });

  it("screenshots without xdotool and returns only the missing-tool warning", async () => {
    const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
    writeScript(
      path.join(dirs.binDir, "import"),
      'for arg in "$@"; do out="$arg"; done\nprintf "\\211PNG\\r\\n\\032\\n" > "$out"',
    );

    const result = await lab.client.callTool({
      name: "desktop_screenshot",
      arguments: { session: id, out: "shot.png" },
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(true);
    expect(report.windowCount).toBeUndefined();
    expect(report.warnings).toEqual([expect.stringContaining("xdotool")]);
    expect(report.warnings[0]).toContain("missing");
    expect(report.warnings[0]).not.toContain("escaped the lab");
  });

  it("reports a zero-window screenshot with the shared escape warning", async () => {
    const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
    writeScript(path.join(dirs.binDir, "xdotool"), "exit 1");
    writeScript(
      path.join(dirs.binDir, "import"),
      'for arg in "$@"; do out="$arg"; done\nprintf "\\211PNG\\r\\n\\032\\n" > "$out"',
    );

    const result = await lab.client.callTool({
      name: "desktop_screenshot",
      arguments: { session: id, out: "shot.png" },
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(true);
    expect(report.windowCount).toBe(0);
    expect(report.warnings).toEqual([
      expect.stringContaining("may have escaped the lab"),
    ]);
    expect(report.warnings[0]).toContain("opened on your real desktop");
  });
});

describe("empty lab", () => {
  it("reports no sessions", async () => {
    const result = await lab.client.callTool({
      name: "session_status",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const report = parseToolJson(result);
    expect(report.ok).toBe(true);
    expect(report.sessions).toEqual([]);
  });

  it("reports no runs", async () => {
    const result = await lab.client.callTool({
      name: "artifact_list",
      arguments: {},
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(true);
    expect(report.runs).toEqual([]);
  });

  it("fails artifact_report when there are no runs", async () => {
    const result = await lab.client.callTool({
      name: "artifact_report",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const report = parseToolJson(result);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toContain("No runs found");
  });

  it("requires a session id or all flag for session_destroy", async () => {
    const result = await lab.client.callTool({
      name: "session_destroy",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it("fails desktop tools with an actionable error when no session runs", async () => {
    const result = await lab.client.callTool({
      name: "desktop_click",
      arguments: { x: 1, y: 2 },
    });
    expect(result.isError).toBe(true);
    const report = parseToolJson(result);
    expect(report.errors[0]).toContain("No running desktop session");
    expect(report.errors[0]).toContain("session_create");
  });
});

describe("inline image content", () => {
  it("reports a reason when the image file is missing", async () => {
    const image = await imageContent(path.join(dirs.root, "missing.png"));
    expect(image.content).toEqual([]);
    expect(image.meta.inlineImage).toBe(false);
    expect(image.meta.inlineImageReason).toContain("not readable");
  });

  it("reports a reason when the image is over the inline limit", async () => {
    const big = path.join(dirs.root, "big.png");
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1));
    const image = await imageContent(big);
    expect(image.content).toEqual([]);
    expect(image.meta.inlineImage).toBe(false);
    expect(image.meta.inlineImageReason).toContain("inline limit");
  });

  it("inlines a small image and flags it as inlined", async () => {
    const small = path.join(dirs.root, "small.png");
    fs.writeFileSync(small, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const image = await imageContent(small);
    expect(image.meta).toEqual({ inlineImage: true });
    expect(image.content).toHaveLength(1);
  });
});

describe("server context", () => {
  it("falls back to PICKLAB_PROJECT_DIR from the environment", async () => {
    const projectDir = path.join(dirs.root, "env-project");
    const server = createMcpServer({
      env: {
        PICKLAB_HOME: dirs.home,
        PATH: dirs.binDir,
        PICKLAB_PROJECT_DIR: projectDir,
      },
    });
    const client = new Client({ name: "picklab-test", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const report = parseToolJson(
        await client.callTool({ name: "artifact_list", arguments: {} }),
      );
      expect(report.projectDir).toBe(projectDir);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
