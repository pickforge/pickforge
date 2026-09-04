import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listRuns,
  listSessions,
  readActions,
} from "@pickforge/lab-core";
import {
  detectScreenshotTool,
  destroyDesktopSession,
  findOnPath,
} from "@pickforge/lab-desktop-linux";
import {
  connectLab,
  makeLabDirs,
  parseToolJson,
  PNG_MAGIC,
  removeLabDirs,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

const hasDesktopStack =
  findOnPath("Xvfb") !== null &&
  findOnPath("xdotool") !== null &&
  detectScreenshotTool() !== null;

const TEST_TIMEOUT_MS = 60_000;

describe.skipIf(!hasDesktopStack)("desktop flow (real Xvfb)", () => {
  let dirs: LabDirs;
  let lab: ConnectedLab;
  let registryEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    dirs = makeLabDirs();
    registryEnv = { ...process.env, PICKFORGE_HOME: dirs.home };
    lab = await connectLab({ projectDir: dirs.projectDir, env: registryEnv });
  });

  afterAll(async () => {
    for (const record of await listSessions(registryEnv)) {
      await destroyDesktopSession(record.id, registryEnv).catch(() => {});
    }
    await lab.close();
    removeLabDirs(dirs);
  });

  it(
    "creates a session, screenshots, drives input, and destroys",
    async () => {
      const created = parseToolJson(
        await lab.client.callTool({
          name: "session_create",
          arguments: { type: "desktop", width: 800, height: 600 },
        }),
      );
      expect(created.ok).toBe(true);
      const session = created.sessions[0];
      expect(session.id).toMatch(/^desk-[0-9a-f]+$/);
      expect(session.display).toMatch(/^:\d+$/);

      const status = parseToolJson(
        await lab.client.callTool({
          name: "session_status",
          arguments: { sessionId: session.id },
        }),
      );
      expect(status.ok).toBe(true);
      expect(status.sessions[0].desktop.xvfbAlive).toBe(true);

      const launch = parseToolJson(
        await lab.client.callTool({
          name: "desktop_launch",
          arguments: { command: "sleep", args: ["30"] },
        }),
      );
      expect(launch.ok).toBe(true);
      expect(launch.pid).toBeGreaterThan(0);
      expect(fs.existsSync(launch.logPath as string)).toBe(true);

      const shotResult = await lab.client.callTool({
        name: "desktop_screenshot",
        arguments: {},
      });
      const shot = parseToolJson(shotResult);
      expect(shot.ok).toBe(true);
      expect(shot.sessionId).toBe(session.id);
      expect(shot.windowCount).toBe(0);
      expect(shot.warnings).toEqual([
        expect.stringContaining("may have escaped the lab"),
      ]);
      expect(shot.runId).toBeDefined();
      expect(
        shot.path.startsWith(path.join(dirs.projectDir, ".picklab", "runs")),
      ).toBe(true);
      const png = fs.readFileSync(shot.path as string);
      expect(png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);
      const content = shotResult.content as Array<Record<string, any>>;
      const image = content.find((block) => block.type === "image");
      expect(image?.mimeType).toBe("image/png");

      const click = parseToolJson(
        await lab.client.callTool({
          name: "desktop_click",
          arguments: { x: 10, y: 10 },
        }),
      );
      expect(click.ok).toBe(true);

      const moved = parseToolJson(
        await lab.client.callTool({
          name: "desktop_move",
          arguments: { x: 100, y: 120 },
        }),
      );
      expect(moved.ok).toBe(true);
      expect(moved.x).toBe(100);
      expect(moved.y).toBe(120);

      const scrolled = parseToolJson(
        await lab.client.callTool({
          name: "desktop_scroll",
          arguments: { deltaX: -1, deltaY: 2, x: 200, y: 150 },
        }),
      );
      expect(scrolled.ok).toBe(true);
      expect(scrolled.deltaX).toBe(-1);
      expect(scrolled.deltaY).toBe(2);

      const zeroScroll = await lab.client.callTool({
        name: "desktop_scroll",
        arguments: { deltaX: 0, deltaY: 0 },
      });
      expect(zeroScroll.isError).toBe(true);
      expect(parseToolJson(zeroScroll).errors[0]).toContain("non-zero");

      const halfPosition = await lab.client.callTool({
        name: "desktop_scroll",
        arguments: { deltaX: 0, deltaY: 1, x: 10 },
      });
      expect(halfPosition.isError).toBe(true);
      expect(parseToolJson(halfPosition).errors[0]).toContain("both x and y");

      const dragged = parseToolJson(
        await lab.client.callTool({
          name: "desktop_drag",
          arguments: {
            fromX: 50,
            fromY: 50,
            toX: 250,
            toY: 200,
            durationMs: 200,
          },
        }),
      );
      expect(dragged.ok).toBe(true);
      expect(dragged.button).toBe(1);

      const doubleClicked = parseToolJson(
        await lab.client.callTool({
          name: "desktop_double_click",
          arguments: { x: 60, y: 60 },
        }),
      );
      expect(doubleClicked.ok).toBe(true);
      expect(doubleClicked.button).toBe(1);

      const typed = parseToolJson(
        await lab.client.callTool({
          name: "desktop_type",
          arguments: { text: "pickforge-lab" },
        }),
      );
      expect(typed.ok).toBe(true);

      const key = parseToolJson(
        await lab.client.callTool({
          name: "desktop_key",
          arguments: { key: "Return" },
        }),
      );
      expect(key.ok).toBe(true);

      const destroyed = parseToolJson(
        await lab.client.callTool({
          name: "session_destroy",
          arguments: { sessionId: session.id },
        }),
      );
      expect(destroyed.ok).toBe(true);
      expect(destroyed.destroyed).toEqual([session.id]);
      expect(await listSessions(registryEnv)).toEqual([]);
      const [manifest] = await listRuns(dirs.projectDir);
      expect(manifest).toMatchObject({
        sessionId: session.id,
        status: "completed",
      });
      const actions = await readActions(
        path.join(
          dirs.projectDir,
          ".picklab",
          "runs",
          manifest!.runId,
        ),
      );
      expect(
        actions.find(
          (action) => "tool" in action && action.tool === "desktop_key",
        ),
      ).toMatchObject({
        target: { length: 6, inputType: "other" },
      });
      expect(
        fs.existsSync(
          path.join(
            dirs.projectDir,
            ".picklab",
            "runs",
            `.active-${session.id}.json`,
          ),
        ),
      ).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
