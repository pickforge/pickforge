import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acquireHumanLease, appendAction, beginEvidenceRun, EVIDENCE_MAX_BYTES, isEvidenceTruncated, listRuns, readActions, recordEvidenceOutcome, releaseHumanLease, saveProjectConfig, withAgentPermit, type EvidenceAction } from "@pickforge/lab-core";
import { connectLab, makeLabDirs, MINI_PNG, parseToolJson, removeLabDirs, writeDesktopSessionRecord, type ConnectedLab, type LabDirs } from "./helpers.js";

const state = vi.hoisted(() => ({ order: [] as string[], fail: "", publishedFailure: false, captureBytes: 0, inputEffect: undefined as (() => void) | undefined }));
vi.mock("@pickforge/lab-desktop-linux", async (original) => {
  const actual = await original<typeof import("@pickforge/lab-desktop-linux")>();
  const input = async (opts: { sessionId: string; env: NodeJS.ProcessEnv }) => withAgentPermit(opts.sessionId, opts.env, async () => {
    state.order.push("input");
    state.inputEffect?.();
    if (state.fail === "input") throw new Error("synthetic typed marker ghp_" + "b".repeat(36));
  });
  return { ...actual, click: input, doubleClick: input, drag: input, scroll: input, typeText: input, pressKey: input,
    selectDesktopWindow: async () => ({ id: "11", name: "Fixture", class: "Zenity", focused: false, geometry: { x: 0, y: 0, width: 800, height: 600 } }),
    focusWindow: input,
    screenshot: async (opts: { outPath: string }) => {
      const phase = state.order.includes("input") ? "after" : "before";
      state.order.push(phase);
      if (state.fail === phase) throw new Error("synthetic typed marker ghp_" + "b".repeat(36));
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
const cases: [string, Record<string, unknown>][] = [
  ["desktop_click", { x: 2, y: 3 }], ["desktop_double_click", { x: 2, y: 3 }],
  ["desktop_drag", { fromX: 1, fromY: 1, toX: 2, toY: 3 }],
  ["desktop_scroll", { deltaX: 0, deltaY: 1 }],
  ["desktop_type", { text: "synthetic typed marker ghp_" + "b".repeat(36) }],
  ["desktop_key", { key: "Tab" }], ["desktop_focus", { id: "11" }],
];
beforeEach(async () => {
  dirs = makeLabDirs();
  env = { ...process.env, PICKFORGE_HOME: dirs.home, PICKFORGE_STORAGE_MODE: "project-local" };
  session = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
  lab = await connectLab({ projectDir: dirs.projectDir, env });
  state.order = []; state.fail = ""; state.publishedFailure = false;
  state.captureBytes = 0; state.inputEffect = undefined;
});
afterEach(async () => { await lab.close(); removeLabDirs(dirs); });
async function call(tool: string, args: Record<string, unknown>) {
  return parseToolJson(await lab.client.callTool({ name: tool, arguments: { session, ...args } }));
}
async function evidence() {
  const [manifest] = await listRuns(dirs.projectDir, env);
  const dir = path.join(dirs.projectDir, ".picklab/runs", manifest!.runId);
  return { manifest: manifest!, dir, actions: await readActions(dir) as EvidenceAction[] };
}

it.each(cases)("%s exposes explicit default-off capture and orders every mode", async (tool, args) => {
  const schema = (await lab.client.listTools()).tools.find((item) => item.name === tool)!;
  expect(schema.description).toContain("Default off");
  expect(schema.inputSchema.properties?.capture).toMatchObject({ enum: ["after", "both"] });
  expect(schema.inputSchema.required ?? []).not.toContain("capture");
  for (const capture of [undefined, "after", "both"]) {
    state.order = [];
    const result = await call(tool, { ...args, capture });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(state.order).toEqual(capture === undefined ? ["input"] : capture === "after" ? ["input", "after"] : ["before", "input", "after"]);
    const { dir, actions, manifest } = await evidence();
    const action = actions.at(-1)!;
    expect(action.tool).toBe(tool);
    expect(action.status).toBe("ok");
    if (capture === undefined) {
      expect(action.artifacts).toBeUndefined();
      expect(result.captures).toBeUndefined();
    } else {
      const phases = capture === "both" ? ["before", "after"] : ["after"];
      expect(action.artifacts).toEqual(phases.map((phase) => `screenshots/${action.actionId}-${phase}.png`));
      expect(result.captures.map((shot: { phase: string }) => shot.phase)).toEqual(phases);
      expect(result.inputState).toBe("completed");
      for (const shot of result.captures) {
        expect(shot).toMatchObject({ runId: manifest.runId, imageSize: { width: 1, height: 1 }, scale: 1, inputCoordinates: "image-pixels" });
        expect(fs.readFileSync(shot.path)).toEqual(MINI_PNG);
        expect(path.dirname(shot.path)).toBe(path.join(dir, "screenshots"));
      }
      expect(manifest.device?.image).toEqual({ width: 1, height: 1 });
    }
    if (tool === "desktop_type") {
      expect(action.target).toEqual({ length: (args.text as string).length, inputType: "text" });
      expect(JSON.stringify({ result, actions, manifest })).not.toContain(args.text);
    }
  }
});

it.each(["before", "input", "after"])("preserves partial evidence when %s fails without retrying", async (phase) => {
  state.fail = phase;
  const result = await call("desktop_type", { ...cases[4]![1], capture: "both" });
  expect(result.ok).toBe(false);
  expect(result.errors[0]).toContain(`${phase === "input" ? "input" : phase + " capture"} failed`);
  expect(result.inputState).toBe(phase === "before" ? "not-attempted" : phase === "input" ? "attempted" : "completed");
  expect(state.order).toEqual(phase === "before" ? ["before"] : phase === "input" ? ["before", "input"] : ["before", "input", "after"]);
  const { actions, dir } = await evidence();
  expect(actions).toHaveLength(1);
  expect(actions[0]!.status).toBe("error");
  expect(actions[0]!.artifacts ?? []).toHaveLength(phase === "before" ? 0 : 1);
  expect(JSON.stringify({ result, actions })).not.toContain("synthetic typed marker");
  expect(JSON.stringify({ result, actions })).not.toContain("b".repeat(36));
  for (const file of actions[0]!.artifacts ?? []) expect(fs.existsSync(path.join(dir, file))).toBe(true);
});

it("links a published PNG even if its subsequent metadata processing fails", async () => {
  state.publishedFailure = true;
  const result = await call("desktop_click", { x: 1, y: 1, capture: "both" });
  expect(result.ok).toBe(false);
  expect(result.inputState).toBe("not-attempted");
  expect(result.artifacts).toHaveLength(1);
  const { actions } = await evidence();
  expect(actions[0]!.artifacts).toHaveLength(1);
  expect(actions[0]!.status).toBe("error");
  expect(state.order).toEqual(["before"]);
});

it.each(cases)("%s refuses explicit captures without evidence before input", async (tool, args) => {
  await saveProjectConfig(dirs.projectDir, { evidence: { enabled: false } });
  expect((await call(tool, { ...args, capture: "both" })).errors[0]).toContain("requires available, enabled evidence");
  expect(state.order).toEqual([]);
  expect(await listRuns(dirs.projectDir, env)).toEqual([]);
  expect((await call(tool, args)).ok).toBe(true);
  expect(state.order).toEqual(["input"]);
});

it("refuses unavailable evidence rather than falling back to a one-shot run", async () => {
  fs.mkdirSync(path.join(dirs.projectDir, ".picklab"), { recursive: true });
  fs.writeFileSync(path.join(dirs.projectDir, ".picklab/runs"), "not a directory");
  expect((await call("desktop_click", { x: 1, y: 1, capture: "after" })).errors[0]).toContain("input was not attempted");
  expect(state.order).toEqual([]);
});

function sparseFile(file: string, size: number): void {
  fs.writeFileSync(file, "");
  fs.truncateSync(file, size);
}

it.each(["after", "both"])("refuses %s captures on a known capped run before input, while metadata-only input still records", async (capture) => {
  const { run } = await beginEvidenceRun(dirs.projectDir, session, {}, env);
  sparseFile(path.join(run.dir, "logs/padding.log"), EVIDENCE_MAX_BYTES);
  await appendAction(run, { actionId: "setup", tool: "desktop_windows", source: "mcp", status: "ok", startedAt: new Date().toISOString() });
  expect(await isEvidenceTruncated(run)).toBe(true);
  const result = await call("desktop_type", { ...cases[4]![1], capture });
  expect(result.ok).toBe(false);
  expect(result.inputState).toBe("not-attempted");
  expect(result.errors.join(" ")).toMatch(/cap/i);
  expect(state.order).toEqual([]);
  expect(fs.readdirSync(path.join(run.dir, "screenshots"))).toEqual([]);
  const recorded = (await evidence()).actions.filter((action) => action.tool === "desktop_type");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ status: "error", error: expect.stringContaining("not-attempted") });
  expect(recorded[0]!.artifacts).toBeUndefined();
  expect((await call("desktop_type", cases[4]![1])).ok).toBe(true);
  expect(state.order).toEqual(["input"]);
  expect((await evidence()).actions.filter((action) => action.tool === "desktop_type").map((action) => action.status)).toEqual(["error", "ok"]);
});

it.each(["after", "both"])("reports completed input and retained paths when %s captures cross the real cap and attachment is dropped", async (capture) => {
  state.captureBytes = EVIDENCE_MAX_BYTES;
  const result = await call("desktop_type", { ...cases[4]![1], capture });
  expect(result.ok).toBe(false);
  expect(result.inputState).toBe("completed");
  expect(result.captureRecording).toBe("capped");
  expect(result.errors.join(" ")).toMatch(/not linked.*input completed/i);
  expect(state.order).toEqual(capture === "both" ? ["before", "input", "after"] : ["input", "after"]);
  expect(result.artifacts).toHaveLength(capture === "both" ? 2 : 1);
  for (const file of result.artifacts) expect(fs.statSync(file).size).toBe(EVIDENCE_MAX_BYTES);
  const { actions, manifest } = await evidence();
  const recorded = actions.filter((action) => action.tool === "desktop_type");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ status: "error", error: expect.stringContaining("input completed") });
  expect(recorded[0]!.artifacts).toBeUndefined();
  expect(JSON.stringify({ result, actions })).not.toContain(cases[4]![1].text);
  await expect(recordEvidenceOutcome(dirs.projectDir, manifest.runId, {
    scenario: "Capture cap", status: "pass", inspectedScreenshots: result.artifacts.map((file: string) => `screenshots/${path.basename(file)}`),
  }, env)).rejects.toThrow(/successful interaction/);
});

it("keeps attempted input in the bounded error record when its before capture exhausts the cap", async () => {
  state.captureBytes = EVIDENCE_MAX_BYTES;
  state.fail = "input";
  const result = await call("desktop_type", { ...cases[4]![1], capture: "both" });
  expect(result).toMatchObject({ ok: false, inputState: "attempted", captureRecording: "capped" });
  expect(state.order).toEqual(["before", "input"]);
  expect(result.artifacts).toHaveLength(1);
  const { actions } = await evidence();
  const recorded = actions.filter((action) => action.tool === "desktop_type");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ status: "error", error: expect.stringContaining("input attempted") });
  expect(recorded[0]!.artifacts).toBeUndefined();
  expect(JSON.stringify({ result, actions })).not.toContain(cases[4]![1].text);
});

it("accepts a truncated append when the artifact-bearing caller record was actually written", async () => {
  const { run } = await beginEvidenceRun(dirs.projectDir, session, {}, env);
  sparseFile(path.join(run.dir, "logs/padding.log"), EVIDENCE_MAX_BYTES - MINI_PNG.length - 1);
  const result = await call("desktop_click", { x: 1, y: 1, capture: "after" });
  expect(result.ok).toBe(true);
  expect(await isEvidenceTruncated(run)).toBe(true);
  const recorded = (await evidence()).actions.filter((action) => action.tool === "desktop_click");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]!.status).toBe("ok");
  expect(recorded[0]!.artifacts).toHaveLength(1);
  expect(state.order).toEqual(["input", "after"]);
});

it.each(["after", "both"])("does not claim %s linkage on a genuine journal append failure after input", async (capture) => {
  const { run } = await beginEvidenceRun(dirs.projectDir, session, {}, env);
  // Corrupt only this synthetic fixture after the operation's run preflight.
  state.inputEffect = () => {
    fs.renameSync(path.join(run.dir, "actions.jsonl"), path.join(run.dir, "journal-backup"));
    fs.mkdirSync(path.join(run.dir, "actions.jsonl"));
  };
  const result = await call("desktop_type", { ...cases[4]![1], capture });
  expect(result.ok).toBe(false);
  expect(result.inputState).toBe("completed");
  expect(result.captureRecording).toBe("unconfirmed");
  expect(result.errors.join(" ")).toMatch(/not confirmed.*input completed/i);
  expect(result.artifacts).toHaveLength(capture === "both" ? 2 : 1);
  for (const file of result.artifacts) expect(fs.readFileSync(file)).toEqual(MINI_PNG);
  expect(state.order.filter((entry) => entry === "input")).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(cases[4]![1].text);
});

it.each(cases)("%s retains takeover refusal even when a before image exists", async (tool, args) => {
  const lease = await acquireHumanLease(session, env);
  try {
    const result = await call(tool, { ...args, capture: "both" });
    expect(result.ok).toBe(false);
    expect(result.inputState).toBe("attempted");
    expect(state.order).toEqual(["before"]);
    const { actions, manifest } = await evidence();
    expect(actions[0]!.status).toBe("error");
    expect(actions[0]!.artifacts).toHaveLength(1);
    await expect(recordEvidenceOutcome(dirs.projectDir, manifest.runId, { scenario: "Refused", status: "pass", inspectedScreenshots: actions[0]!.artifacts! }, env)).rejects.toThrow(/successful interaction/);
  } finally { await releaseHumanLease(session, lease.leaseId, env); }
});
