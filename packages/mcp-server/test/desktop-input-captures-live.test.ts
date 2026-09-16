import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { listRuns, readActions, type EvidenceAction } from "@pickforge/lab-core";
import { destroyDesktopSession, detectScreenshotTool, findOnPath } from "@pickforge/lab-desktop-linux";
import { pngPixelDigest } from "../../desktop-linux/src/png.js";
import { connectLab, makeLabDirs, parseToolJson, PNG_MAGIC, removeLabDirs } from "./helpers.js";

const available = ["Xvfb", "xdotool", "xprop", "zenity"].every((tool) => findOnPath(tool) !== null) && detectScreenshotTool() !== null;
if (process.env.PICKFORGE_REQUIRE_DESKTOP_CAPTURES === "1" && !available) {
  throw new Error("Required input capture integration needs Xvfb, xdotool, xprop, zenity and a screenshot tool");
}

it.skipIf(!available)("associates real input capture pairs, geometry, inspection and HTML on a private managed Xvfb", async () => {
  const dirs = makeLabDirs();
  const env = { ...process.env, PICKFORGE_HOME: dirs.home, PICKFORGE_STORAGE_MODE: "project-local" };
  const lab = await connectLab({ projectDir: dirs.projectDir, env });
  let session: string | undefined;
  const call = async (name: string, args: Record<string, unknown> = {}) => parseToolJson(await lab.client.callTool({ name, arguments: { session, ...args } }));
  try {
    const created = await call("session_create", { type: "desktop", width: 800, height: 600 });
    expect(created.ok).toBe(true);
    session = created.sessions[0].id;
    const launched = await call("desktop_exec", { command: "zenity", args: ["--entry", "--title", "Capture Fixture", "--text", "Synthetic input only"], windowTimeoutMs: 10_000 });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const windows = await call("desktop_windows");
    const window = windows.windows.find((item: { name: string }) => item.name === "Capture Fixture");
    expect(window).toBeDefined();
    expect((await call("desktop_focus", { id: window.id, capture: "both" })).ok).toBe(true);
    const marker = "capture-synthetic-value";
    const typed = await call("desktop_type", { text: marker, capture: "both" });
    expect(typed.ok, JSON.stringify(typed)).toBe(true);
    expect(typed.captures).toHaveLength(2);
    const [before, after] = typed.captures;
    expect(await pngPixelDigest(before.path)).not.toBe(await pngPixelDigest(after.path));
    for (const shot of typed.captures) {
      expect(shot).toMatchObject({ imageSize: { width: 800, height: 600 }, displaySize: { width: 800, height: 600 }, scale: 1, inputCoordinates: "image-pixels", windowCount: 1 });
      expect(fs.readFileSync(shot.path).subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
    }
    for (const [name, args] of [
      ["desktop_key", { key: "Left" }], ["desktop_click", { x: 780, y: 580 }],
      ["desktop_double_click", { x: 780, y: 580 }], ["desktop_scroll", { deltaX: 0, deltaY: 1 }],
      ["desktop_drag", { fromX: 780, fromY: 580, toX: 790, toY: 590, durationMs: 0 }],
    ] as const) {
      const result = await call(name, { ...args, capture: "after" });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.captures).toHaveLength(1);
    }
    const [manifest] = await listRuns(dirs.projectDir, env);
    const dir = path.join(dirs.projectDir, ".picklab/runs", manifest!.runId);
    const actions = await readActions(dir) as EvidenceAction[];
    const action = actions.find((item) => item.tool === "desktop_type")!;
    expect(action).toMatchObject({ status: "ok", target: { length: marker.length, inputType: "text" }, artifacts: [`screenshots/${action.actionId}-before.png`, `screenshots/${action.actionId}-after.png`] });
    expect(JSON.stringify({ typed, actions, manifest })).not.toContain(marker);
    expect(actions.filter((item) => item.artifacts?.length)).toHaveLength(7);
    const outcome = { runId: manifest!.runId, scenario: "Synthetic input", status: "pass" };
    // Capturing alone never claims inspection. Nonexistent and other-run paths
    // cannot be used to satisfy the existing inspected-image pass requirement.
    expect((await call("evidence_outcome", { ...outcome, inspectedScreenshots: [] })).ok).toBe(false);
    const other = await call("desktop_screenshot", { runSlug: "unrelated" });
    for (const inspectedScreenshots of [["screenshots/missing.png"], [other.path], [`../${other.runId}/screenshots/${path.basename(other.path)}`]]) {
      expect((await call("evidence_outcome", { ...outcome, inspectedScreenshots })).ok).toBe(false);
    }
    expect((await call("evidence_outcome", { ...outcome, inspectedScreenshots: action.artifacts })).ok).toBe(true);
    const destroyed = await call("session_destroy", { sessionId: session });
    expect(destroyed.ok, JSON.stringify(destroyed)).toBe(true);
    session = undefined;
    const html = fs.readFileSync(path.join(dir, "report.html"), "utf8");
    for (const file of action.artifacts!) expect(html).toContain(`src="${file}"`);
    expect(html).not.toContain(marker);
    expect(html).toContain("Synthetic input");
  } finally {
    if (session !== undefined) await destroyDesktopSession(session, env);
    await lab.close();
    removeLabDirs(dirs);
  }
}, 60_000);
