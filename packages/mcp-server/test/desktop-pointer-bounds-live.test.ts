import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { getSession, listRuns, readActions, type EvidenceAction } from "@pickforge/lab-core";
import { destroyDesktopSession, findOnPath } from "@pickforge/lab-desktop-linux";
import { connectLab, makeLabDirs, parseToolJson, removeLabDirs } from "./helpers.js";

const available = ["Xvfb", "xdotool"].every((tool) => findOnPath(tool) !== null);

// pickforge/pickforge#424: X clamps a point past the edge and wraps one past 32767.
it.skipIf(!available)("refuses pointer points past the screen as not attempted, with no X event", async () => {
  const dirs = makeLabDirs();
  const env = { ...process.env, PICKFORGE_HOME: dirs.home, PICKFORGE_STORAGE_MODE: "project-local" };
  const lab = await connectLab({ projectDir: dirs.projectDir, env });
  let session: string | undefined;
  const call = async (name: string, args: Record<string, unknown> = {}) => parseToolJson(await lab.client.callTool({ name, arguments: { session, ...args } }));
  try {
    const created = await call("session_create", { type: "desktop", width: 640, height: 480 });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    session = created.sessions[0].id as string;
    const display = (await getSession(session, env))!.desktop!.display;
    const pointer = () => execFileSync("xdotool", ["getmouselocation", "--shell"], { env: { ...process.env, DISPLAY: display }, encoding: "utf8" })
      .split("\n").slice(0, 2).join(" ");
    const tools: Record<string, (x: number, y: number) => [string, Record<string, unknown>]> = {
      click: (x, y) => ["desktop_click", { x, y }],
      "double click": (x, y) => ["desktop_double_click", { x, y }],
      move: (x, y) => ["desktop_move", { x, y }],
      scroll: (x, y) => ["desktop_scroll", { deltaX: 0, deltaY: 1, x, y }],
      "drag start": (x, y) => ["desktop_drag", { fromX: x, fromY: y, toX: 5, toY: 5, durationMs: 0 }],
      "drag end": (x, y) => ["desktop_drag", { fromX: 5, fromY: 5, toX: x, toY: y, durationMs: 0 }],
    };
    const outside: Array<[number, number, number]> = [[640, 0, 640], [0, 480, 480], [32768, 100, 32768], [100, 65537, 65537]];
    for (const [name, tool] of Object.entries(tools)) {
      expect((await call("desktop_move", { x: 100, y: 100 })).ok, name).toBe(true);
      for (const [x, y, value] of outside) {
        const [toolName, args] = tool(x, y);
        const result = await call(toolName, args);
        expect(result.ok, `${name} ${x},${y}`).toBe(false);
        expect(result.errors.join("; ")).toMatch(new RegExp(` ${value} is outside the 640x480 screen \\(x 0-639, y 0-479\\); no input was sent`));
        expect(pointer(), `${name} ${x},${y}`).toBe("X=100 Y=100");
      }
      const [toolName, args] = tool(639, 479);
      expect((await call(toolName, args)).ok, name).toBe(true);
      expect(pointer(), name).toBe(name === "drag start" ? "X=5 Y=5" : "X=639 Y=479");
    }
    const [manifest] = await listRuns(dirs.projectDir, env);
    const actions = (await readActions(path.join(dirs.projectDir, ".picklab/runs", manifest!.runId)) as EvidenceAction[])
      .filter((action) => action.tool !== "session_create");
    const pointerActions = actions.filter((action) => !(action.tool === "desktop_move" && action.target?.x === 100 && action.target.y === 100));
    expect(pointerActions.map((action) => action.inputState)).toEqual(
      Object.keys(tools).flatMap(() => [...outside.map(() => "not-attempted"), "completed"]),
    );
    expect(pointerActions.filter((action) => action.inputState === "not-attempted").every((action) => action.status === "error")).toBe(true);
  } finally {
    if (session !== undefined) await destroyDesktopSession(session, env);
    await lab.close();
    removeLabDirs(dirs);
  }
}, 90_000);
