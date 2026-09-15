import fs from "node:fs";
import path from "node:path";
import { encodePng } from "../../desktop-linux/test/png-fixture.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createRun,
  listRuns,
  readActions,
  resolveRunStorage,
  saveProjectConfig,
} from "@pickforge/lab-core";
import {
  connectLab,
  makeLabDirs,
  MINI_PNG,
  parseToolJson,
  removeLabDirs,
  writeDesktopSessionRecord,
  writeScript,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

let dirs: LabDirs;
let lab: ConnectedLab;

beforeEach(async () => {
  dirs = makeLabDirs();
  writeScript(path.join(dirs.binDir, "convert"), 'exec /usr/bin/convert "$@"');
  writeScript(path.join(dirs.binDir, "magick"), 'exec /usr/bin/magick "$@"');
  lab = await connectLab({
    projectDir: dirs.projectDir,
    env: { PICKFORGE_HOME: dirs.home, PICKFORGE_STORAGE_MODE: "home", PATH: dirs.binDir },
  });
});

afterEach(async () => {
  await lab.close();
  removeLabDirs(dirs);
});

function fakeCapture(): string {
  const fixture = path.join(dirs.root, "mini.png");
  fs.writeFileSync(fixture, MINI_PNG);
  const body = `for arg in "$@"; do out="$arg"; done\n/bin/cp "${fixture}" "$out"`;
  writeScript(path.join(dirs.binDir, "import"), body);
  writeScript(path.join(dirs.binDir, "maim"), body);
  return writeDesktopSessionRecord(dirs.home, dirs.projectDir);
}

it.each(["query", "capture", "baseline", "raster"])("redacts failed %s observations in MCP responses and journals", async (kind) => {
  const secret = `ghp_${"b".repeat(36)}`;
  const id = fakeCapture();
  const fail = `echo "actionable ${secret}" >&2; exit 1`;
  writeScript(path.join(dirs.binDir, "xdotool"), fail);
  if (kind === "capture") {
    writeScript(path.join(dirs.binDir, "maim"), fail);
    writeScript(path.join(dirs.binDir, "import"), fail);
  }
  if (kind === "raster") {
    fs.writeFileSync(path.join(dirs.root, "mini.png"), encodePng(16, 16, Buffer.alloc(768)));
    writeScript(path.join(dirs.binDir, "convert"), fail);
    writeScript(path.join(dirs.binDir, "magick"), fail);
  }
  const mode = kind === "query" ? { window: "Never" } : kind === "baseline"
    ? { baseline: path.join(dirs.root, `outside-${secret}.png`) } : { stableMs: 100 };
  const response = await lab.client.callTool({ name: "desktop_wait", arguments: { session: id, timeoutMs: 2000, ...mode } });
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response)).not.toContain(secret);
  expect(JSON.stringify(response)).toContain(kind === "baseline" ? "Refusing" : "actionable");
  const env = { PICKFORGE_HOME: dirs.home };
  const [run] = await listRuns(dirs.projectDir, env);
  const storage = await resolveRunStorage(dirs.projectDir, env);
  const actions = await readActions(path.join(storage.runsDir, run!.runId));
  expect(actions).toEqual([expect.objectContaining({ tool: "desktop_wait", status: "error" })]);
  expect(JSON.stringify(actions)).not.toContain(secret);
});

it("records capture geometry on the active evidence run and any one-shot run", async () => {
  const id = fakeCapture();
  const shot = parseToolJson(
    await lab.client.callTool({ name: "desktop_screenshot", arguments: { session: id } }),
  );
  expect(shot.ok).toBe(true);
  expect(shot.imageSize).toEqual({ width: 1, height: 1 });
  // Fake framebuffer is 1x1; stale registry dimensions must not invent a different display.
  expect(shot.displaySize).toEqual({ width: 1, height: 1 });
  expect(shot.scale).toBe(1);
  expect(shot.inputCoordinates).toBe("image-pixels");
  const [active] = await listRuns(dirs.projectDir, { PICKFORGE_HOME: dirs.home });
  expect(active?.device?.image).toEqual({ width: 1, height: 1 });
  expect(active?.device?.viewport).toEqual({ width: 1, height: 1 });
  expect(active?.device?.scale).toBe(1);
  expect(active?.device?.coordinateSpace).toBe("image-pixels");

  const out = parseToolJson(
    await lab.client.callTool({
      name: "desktop_screenshot",
      arguments: { session: id, out: "explicit.png" },
    }),
  );
  expect(out.ok).toBe(true);
  expect(out.path).toContain("explicit.png");
  const afterOut = await listRuns(dirs.projectDir, { PICKFORGE_HOME: dirs.home });
  expect(afterOut.some((run) => run.device?.image?.width === 1)).toBe(true);

  const slugged = parseToolJson(
    await lab.client.callTool({
      name: "desktop_screenshot",
      arguments: { session: id, runSlug: "oneshot" },
    }),
  );
  expect(slugged.ok).toBe(true);
  expect(slugged.runId).toMatch(/oneshot/);
  const runs = await listRuns(dirs.projectDir, { PICKFORGE_HOME: dirs.home });
  const oneShot = runs.find((run) => run.runId === slugged.runId);
  const evidence = runs.find((run) => run.runId === active?.runId);
  expect(oneShot?.device?.image).toEqual({ width: 1, height: 1 });
  expect(evidence?.device?.image).toEqual({ width: 1, height: 1 });
});

it("keeps evidence-disabled one-shot and output-only geometry without inventing a journal run", async () => {
  await saveProjectConfig(dirs.projectDir, { evidence: { enabled: false } });
  const id = fakeCapture();
  const oneShot = parseToolJson(
    await lab.client.callTool({ name: "desktop_screenshot", arguments: { session: id } }),
  );
  expect(oneShot.ok).toBe(true);
  expect(oneShot.runId).toBeDefined();
  expect(oneShot.imageSize).toEqual({ width: 1, height: 1 });
  const listed = await listRuns(dirs.projectDir, { PICKFORGE_HOME: dirs.home });
  expect(listed).toHaveLength(1);
  expect(listed[0]?.device?.image).toEqual({ width: 1, height: 1 });

  const outputOnly = parseToolJson(
    await lab.client.callTool({
      name: "desktop_screenshot",
      arguments: { session: id, out: "only.png" },
    }),
  );
  expect(outputOnly.ok).toBe(true);
  expect(outputOnly.runId).toBeUndefined();
  expect(outputOnly.imageSize).toEqual({ width: 1, height: 1 });
  expect(await listRuns(dirs.projectDir, { PICKFORGE_HOME: dirs.home })).toHaveLength(1);
});

it("journals baseline failures and zero-budget observations without reading the file", async () => {
  const id = fakeCapture();
  const missing = path.join(dirs.projectDir, "missing timed out.png");
  const zero = parseToolJson(await lab.client.callTool({ name: "desktop_wait", arguments: { session: id, baseline: missing, timeoutMs: 0 } }));
  expect(zero.reason).toBe("timeout");
  const failed = await lab.client.callTool({ name: "desktop_wait", arguments: { session: id, baseline: missing, timeoutMs: 1000 } });
  expect(failed.isError).toBe(true);
  const env = { PICKFORGE_HOME: dirs.home };
  const [run] = await listRuns(dirs.projectDir, env);
  const storage = await resolveRunStorage(dirs.projectDir, env);
  const actions = await readActions(path.join(storage.runsDir, run!.runId));
  expect(actions.filter((action) => "tool" in action && action.tool === "desktop_wait")).toEqual([
    expect.objectContaining({ status: "timeout" }), expect.objectContaining({ status: "error" }),
  ]);
});

it("directly reads a verified home run screenshot outside the project", async () => {
  const id = fakeCapture();
  const run = await createRun(dirs.projectDir, "home-owned", {}, { PICKFORGE_HOME: dirs.home });
  fs.writeFileSync(path.join(run.dir, "screenshots", "owned.png"), MINI_PNG);
  const result = parseToolJson(await lab.client.callTool({ name: "desktop_wait", arguments: { session: id, baseline: path.join(run.dir, "screenshots", "owned.png"), timeoutMs: 150 } }));
  expect(result.ok).toBe(true);
  expect(result.reason).toBe("timeout");
});

it("refuses a substituted run screenshots directory and reads an owned screenshot", async () => {
  const id = fakeCapture();
  const env = { PICKFORGE_HOME: dirs.home, PICKFORGE_STORAGE_MODE: "project-local" };
  const run = await createRun(dirs.projectDir, "owned", { sessionId: id }, env);
  fs.writeFileSync(path.join(run.dir, "screenshots", "ok.png"), MINI_PNG);
  const owned = parseToolJson(
    await lab.client.callTool({
      name: "desktop_wait",
      arguments: {
        session: id,
        baseline: path.join(run.dir, "screenshots", "ok.png"),
        timeoutMs: 200,
      },
    }),
  );
  expect(owned.ok).toBe(true);
  expect(owned.reason).toBe("timeout");

  const outside = path.join(dirs.root, "leak.png");
  fs.writeFileSync(outside, MINI_PNG);
  fs.rmSync(path.join(run.dir, "screenshots"), { recursive: true });
  fs.symlinkSync(dirs.root, path.join(run.dir, "screenshots"));
  const refused = await lab.client.callTool({
    name: "desktop_wait",
    arguments: {
      session: id,
      baseline: path.join(run.dir, "screenshots", "leak.png"),
      timeoutMs: 200,
    },
  });
  expect(refused.isError).toBe(true);
  expect(parseToolJson(refused).errors.join("\n")).toMatch(/project directory|verified run|symlink/);
});
