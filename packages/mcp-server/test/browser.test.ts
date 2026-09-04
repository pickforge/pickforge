import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { destroyBrowserSession } from "@pickforge/lab-browser";
import { listSessions } from "@pickforge/lab-core";
import { findOnPath } from "@pickforge/lab-desktop-linux";
import { fakePath, writeFakeChrome } from "../../browser/test/fakes.js";
import {
  connectLab,
  makeLabDirs,
  parseToolJson,
  removeLabDirs,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

const hasXvfb = findOnPath("Xvfb") !== null;
const TEST_TIMEOUT_MS = 60_000;

describe.skipIf(!hasXvfb)("MCP browser lifecycle", () => {
  let dirs: LabDirs;
  let lab: ConnectedLab;
  let registryEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    dirs = makeLabDirs();
    writeFakeChrome(dirs.binDir, "ready");
    registryEnv = {
      HOME: dirs.home,
      PICKFORGE_HOME: dirs.home,
      PATH: fakePath(dirs.binDir),
      SECRET_TOKEN: "pickforge-lab-mcp-browser-secret",
    };
    lab = await connectLab({ projectDir: dirs.projectDir, env: registryEnv });
  });

  afterAll(async () => {
    for (const record of await listSessions(registryEnv)) {
      if (record.type === "browser") {
        await destroyBrowserSession(record.id, registryEnv).catch(() => {});
      }
    }
    await lab.close();
    removeLabDirs(dirs);
  });

  it(
    "creates, reports, lists, destroys, and destroys all browser sessions",
    async () => {
      const firstCreate = parseToolJson(
        await lab.client.callTool({
          name: "session_create",
          arguments: { type: "browser", width: 900, height: 600 },
        }),
      );
      expect(firstCreate.ok).toBe(true);
      const first = firstCreate.sessions[0] as Record<string, any>;
      expect(first.id).toMatch(/^brow-[0-9a-f]+$/);
      expect(first.type).toBe("browser");
      expect(first.display).toMatch(/^:\d+$/);
      expect(first.cdpPort).toBeGreaterThan(0);

      const chromeEnv = JSON.parse(
        fs.readFileSync(
          path.join(first.profileDir as string, "fake-chrome-env.json"),
          "utf8",
        ),
      ) as Record<string, string>;
      expect(chromeEnv.SECRET_TOKEN).toBeUndefined();

      const status = parseToolJson(
        await lab.client.callTool({
          name: "session_status",
          arguments: { sessionId: first.id },
        }),
      ).sessions[0] as Record<string, any>;
      expect(status.status).toBe("running");
      expect(status.desktop.xvfbAlive).toBe(true);
      expect(status.desktop.displayAlive).toBe(true);
      expect(status.browser.browserAlive).toBe(true);
      expect(status.browser.cdpPort).toBe(first.cdpPort);
      expect(status.viewer).toEqual({
        endpoint: null,
        ready: false,
        readOnly: false,
        hostGuiLaunchSupported: false,
      });

      const second = parseToolJson(
        await lab.client.callTool({
          name: "session_create",
          arguments: { type: "browser" },
        }),
      ).sessions[0] as Record<string, any>;
      expect(second.id).not.toBe(first.id);
      expect(second.display).not.toBe(first.display);
      expect(second.cdpPort).not.toBe(first.cdpPort);
      expect(second.profileDir).not.toBe(first.profileDir);

      const allStatus = parseToolJson(
        await lab.client.callTool({
          name: "session_status",
          arguments: {},
        }),
      ).sessions as Array<Record<string, any>>;
      expect(allStatus.map((entry) => entry.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );

      const oneDestroyed = parseToolJson(
        await lab.client.callTool({
          name: "session_destroy",
          arguments: { sessionId: first.id },
        }),
      );
      expect(oneDestroyed.ok).toBe(true);
      expect(oneDestroyed.destroyed).toEqual([first.id]);
      expect(fs.existsSync(first.profileDir as string)).toBe(false);

      const allDestroyed = parseToolJson(
        await lab.client.callTool({
          name: "session_destroy",
          arguments: { all: true },
        }),
      );
      expect(allDestroyed.ok).toBe(true);
      expect(allDestroyed.destroyed).toEqual([second.id]);
      expect(fs.existsSync(second.profileDir as string)).toBe(false);
      expect(await listSessions(registryEnv)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "returns captured Chrome diagnostics when browser creation fails",
    async () => {
      writeFakeChrome(dirs.binDir, "crash");

      const result = await lab.client.callTool({
        name: "session_create",
        arguments: { type: "browser" },
      });
      const report = parseToolJson(result);

      expect(result.isError).toBe(true);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toContain(
        "file was not created before the Chrome process exited",
      );
      expect(report.errors[0]).toContain(
        "fake Chrome crashed before publishing a port",
      );
    },
    TEST_TIMEOUT_MS,
  );
});
