import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginEvidenceRun, EVIDENCE_MAX_BYTES, listRuns, readActions, saveProjectConfig, withAgentPermit, type EvidenceAction } from "@pickforge/lab-core";
import { connectLab, makeLabDirs, MINI_PNG, parseToolJson, removeLabDirs, writeDesktopSessionRecord, type ConnectedLab, type LabDirs } from "./helpers.js";

type Identity = { display: string; pid: number; startTicks: number } | undefined | "reject";
const IDENTITY = vi.hoisted(() => ({ display: ":99", pid: 4242, startTicks: 777 }));
const state = vi.hoisted(() => ({
  order: [] as string[], fail: "", publishedFailure: false, captureBytes: 0,
  verify: [] as Identity[], verifyArgs: [] as unknown[][], inputDisplays: [] as string[],
}));
vi.mock("@pickforge/lab-desktop-linux", async (original) => {
  const actual = await original<typeof import("@pickforge/lab-desktop-linux")>();
  const input = async (opts: { sessionId: string; display: string; env: NodeJS.ProcessEnv }) => withAgentPermit(opts.sessionId, opts.env, async () => {
    state.order.push("input");
    state.inputDisplays.push(opts.display);
    if (state.fail === "input") throw new Error("synthetic input failure");
  });
  return { ...actual, click: input, doubleClick: input, drag: input, scroll: input, move: input,
    verifyOwnedDisplayTarget: vi.fn(async (...args: unknown[]) => {
      state.order.push("verify");
      state.verifyArgs.push(args);
      const next = state.verify.length > 0 ? state.verify.shift() : IDENTITY;
      if (next === "reject") throw new Error("synthetic verification rejection");
      return next;
    }),
    screenshot: async (opts: { outPath: string }) => {
      const phase = state.order.includes("input") ? "after" : "before";
      state.order.push(phase);
      if (state.fail === phase) throw new Error("synthetic capture failure");
      fs.writeFileSync(opts.outPath, MINI_PNG);
      if (state.captureBytes > 0) fs.truncateSync(opts.outPath, state.captureBytes);
      return { tool: "import", windowCount: 1, warnings: [], imageSize: state.publishedFailure ? undefined : { width: 1, height: 1 }, displaySize: { width: 1, height: 1 } };
    },
  };
});

let dirs: LabDirs;
let lab: ConnectedLab;
let session: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  dirs = makeLabDirs();
  env = { ...process.env, PICKFORGE_HOME: dirs.home, PICKFORGE_STORAGE_MODE: "project-local" };
  session = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
  lab = await connectLab({ projectDir: dirs.projectDir, env });
  state.order = []; state.fail = ""; state.publishedFailure = false; state.captureBytes = 0; state.verify = []; state.verifyArgs = []; state.inputDisplays = [];
});
afterEach(async () => { await lab.close(); removeLabDirs(dirs); });

async function raw(tool: string, args: Record<string, unknown>) {
  return lab.client.callTool({ name: tool, arguments: { session, ...args } });
}
async function call(tool: string, args: Record<string, unknown>) {
  return parseToolJson(await raw(tool, args));
}
async function actions(): Promise<EvidenceAction[]> {
  const [manifest] = await listRuns(dirs.projectDir, env);
  return await readActions(path.join(dirs.projectDir, ".picklab/runs", manifest!.runId)) as EvidenceAction[];
}
async function last(): Promise<EvidenceAction> {
  return (await actions()).at(-1)!;
}
function links(action: EvidenceAction, phases: string[]) {
  return phases.map((phase) => ({ path: `screenshots/${action.actionId}-${phase}.png`, phase, width: 1, height: 1 }));
}

const pointer: [string, Record<string, unknown>, Record<string, number>, string[]][] = [
  ["desktop_click", { x: 2, y: 3 }, { x: 2, y: 3 }, ["button", "x", "y"]],
  ["desktop_double_click", { x: 2, y: 3 }, { x: 2, y: 3 }, ["button", "x", "y"]],
  ["desktop_drag", { fromX: 1, fromY: 4, toX: 2, toY: 3 }, { fromX: 1, fromY: 4, x: 2, y: 3 }, ["button", "fromX", "fromY", "toX", "toY"]],
  ["desktop_scroll", { deltaX: 0, deltaY: 1, x: 5, y: 6 }, { x: 5, y: 6 }, ["deltaX", "deltaY", "x", "y"]],
];
const captureKeys = ["display", "displaySize", "imageSize", "inlineImage", "inputCoordinates", "path", "phase", "runDir", "runId", "scale", "sessionId", "tool", "windowCount"];

it.each(pointer)("%s records target, space, input state and capture links without changing the response", async (tool, args, target, dataKeys) => {
  for (const capture of [undefined, "after", "both"]) {
    state.order = [];
    const response = await raw(tool, { ...args, capture });
    expect((response.content as unknown[]).length).toBe(1);
    const result = parseToolJson(response);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const base = ["display", "errors", "ok", "sessionId", ...dataKeys];
    expect(Object.keys(result).sort()).toEqual((capture === undefined ? base : [...base, "artifacts", "capture", "captures", "inputState"]).sort());
    const phases = capture === undefined ? [] : capture === "both" ? ["before", "after"] : ["after"];
    expect(state.order).toEqual(["verify", ...phases.filter((phase) => phase === "before"), "input", ...phases.filter((phase) => phase === "after"), "verify"]);
    const action = await last();
    expect(action).toMatchObject({ tool, status: "ok", inputState: "completed" });
    expect(action.target).toEqual({ ...target, coordinateSpace: "xvfb-root" });
    if (capture === undefined) {
      expect(action.captures).toBeUndefined();
      continue;
    }
    expect(action.captures).toEqual(links(action, phases));
    expect(action.artifacts).toEqual(action.captures!.map((link) => link.path));
    expect(result.inputState).toBe("completed");
    for (const shot of result.captures) {
      expect(Object.keys(shot).sort()).toEqual(captureKeys);
      expect(fs.readFileSync(shot.path)).toEqual(MINI_PNG);
    }
  }
});

it.each(pointer)("%s verifies the session display with the server env, not a host DISPLAY", async (tool, args) => {
  await lab.close();
  lab = await connectLab({ projectDir: dirs.projectDir, env: { ...env, DISPLAY: ":7" } });
  expect((await call(tool, args)).ok).toBe(true);
  expect(state.inputDisplays).toEqual([":987"]);
  expect(state.verifyArgs).toHaveLength(2);
  for (const [sessionId, display, verifyEnv] of state.verifyArgs) {
    expect(sessionId).toBe(session);
    expect(display).toBe(":987");
    expect(verifyEnv).toMatchObject({ PICKFORGE_HOME: dirs.home, PICKFORGE_STORAGE_MODE: "project-local", DISPLAY: ":7" });
  }
});

it("records desktop_move with input state and a verified space", async () => {
  const result = await call("desktop_move", { x: 7, y: 8 });
  expect(Object.keys(result).sort()).toEqual(["display", "errors", "ok", "sessionId", "x", "y"]);
  expect(state.order).toEqual(["verify", "input", "verify"]);
  expect(await last()).toMatchObject({ tool: "desktop_move", inputState: "completed", target: { x: 7, y: 8, coordinateSpace: "xvfb-root" } });
  state.fail = "input";
  expect((await call("desktop_move", { x: 7, y: 8 })).ok).toBe(false);
  expect(await last()).toMatchObject({ status: "error", inputState: "attempted", target: { x: 7, y: 8, coordinateSpace: "xvfb-root" } });
});

it.each([
  ["input", "attempted", ["before"]],
  ["before", "not-attempted", []],
  ["after", "completed", ["before"]],
])("keeps the input state when %s fails", async (fail, inputState, phases) => {
  state.fail = fail;
  const result = await call("desktop_drag", { fromX: 1, fromY: 4, toX: 2, toY: 3, capture: "both" });
  expect(result).toMatchObject({ ok: false, inputState });
  const action = await last();
  expect(action).toMatchObject({ status: "error", inputState, target: { fromX: 1, fromY: 4, x: 2, y: 3, coordinateSpace: "xvfb-root" } });
  expect(action.captures).toEqual(phases.length === 0 ? undefined : links(action, phases));
});

it("records attempted input when an uncaptured input throws", async () => {
  state.fail = "input";
  expect((await call("desktop_click", { x: 2, y: 3 })).ok).toBe(false);
  expect(await last()).toMatchObject({ status: "error", inputState: "attempted", target: { x: 2, y: 3, coordinateSpace: "xvfb-root" } });
});

it.each<[string, Identity[]]>([
  ["undefined before", [undefined]],
  ["undefined after", [IDENTITY, undefined]],
  ["a different pid after", [IDENTITY, { ...IDENTITY, pid: 4243 }]],
  ["different start ticks after", [IDENTITY, { ...IDENTITY, startTicks: 778 }]],
  ["a different display after", [IDENTITY, { ...IDENTITY, display: ":98" }]],
  ["a rejection before", ["reject"]],
  ["a rejection after", [IDENTITY, "reject"]],
])("drops the coordinate space on %s without blocking input", async (_name, verify) => {
  state.verify = verify;
  const result = await call("desktop_click", { x: 2, y: 3, capture: "after" });
  expect(result.ok).toBe(true);
  expect(state.order).toContain("input");
  const action = await last();
  expect(action.target).toEqual({ x: 2, y: 3 });
  expect(action).toMatchObject({ status: "ok", inputState: "completed" });
});

it("records no coordinates, no space and no verification for a scroll without a point", async () => {
  const result = await call("desktop_scroll", { deltaX: 0, deltaY: 1, capture: "after" });
  expect(result.ok).toBe(true);
  expect(state.order).toEqual(["input", "after"]);
  const action = await last();
  expect(action.target).toBeUndefined();
  expect(action.inputState).toBe("completed");
  expect(action.captures).toEqual(links(action, ["after"]));
});

it("skips verification when evidence is disabled", async () => {
  await saveProjectConfig(dirs.projectDir, { evidence: { enabled: false } });
  expect((await call("desktop_drag", { fromX: 1, fromY: 4, toX: 2, toY: 3 })).ok).toBe(true);
  expect(state.order).toEqual(["input"]);
  expect(await listRuns(dirs.projectDir, env)).toEqual([]);
});

it("keeps a published capture with failed metadata as an artifact without a link", async () => {
  state.publishedFailure = true;
  expect((await call("desktop_click", { x: 2, y: 3, capture: "both" })).ok).toBe(false);
  const action = await last();
  expect(action.artifacts).toHaveLength(1);
  expect(action.captures).toBeUndefined();
  expect(action.inputState).toBe("not-attempted");
});

it("persists the input state on capped records without links", async () => {
  state.captureBytes = EVIDENCE_MAX_BYTES;
  const result = await call("desktop_click", { x: 2, y: 3, capture: "after" });
  expect(result).toMatchObject({ ok: false, captureRecording: "capped", inputState: "completed" });
  const recorded = (await actions()).filter((action) => action.tool === "desktop_click");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ status: "error", inputState: "completed", target: { x: 2, y: 3, coordinateSpace: "xvfb-root" } });
  expect(recorded[0]!.artifacts).toBeUndefined();
  expect(recorded[0]!.captures).toBeUndefined();
});

it("records not-attempted input when a known capped run refuses captures", async () => {
  const { run } = await beginEvidenceRun(dirs.projectDir, session, {}, env);
  fs.writeFileSync(path.join(run.dir, "logs/padding.log"), "");
  fs.truncateSync(path.join(run.dir, "logs/padding.log"), EVIDENCE_MAX_BYTES);
  await call("desktop_click", { x: 2, y: 3 });
  const result = await call("desktop_click", { x: 2, y: 3, capture: "both" });
  expect(result).toMatchObject({ ok: false, inputState: "not-attempted" });
  expect(state.order.filter((entry) => entry === "input")).toHaveLength(1);
  const recorded = (await actions()).filter((action) => action.tool === "desktop_click");
  expect(recorded.map((action) => action.inputState)).toEqual(["completed", "not-attempted"]);
});

it("never links a later screenshot to an earlier action", async () => {
  await call("desktop_click", { x: 2, y: 3 });
  const shot = await call("desktop_screenshot", {});
  expect(shot.ok).toBe(true);
  const [click, screenshot] = await actions();
  expect(click!.captures).toBeUndefined();
  expect(click!.artifacts).toBeUndefined();
  expect(screenshot).toMatchObject({ tool: "desktop_screenshot" });
  expect(screenshot!.captures).toBeUndefined();
  expect(screenshot!.inputState).toBeUndefined();
  expect(fs.readFileSync(shot.path)).toEqual(MINI_PNG);
});
