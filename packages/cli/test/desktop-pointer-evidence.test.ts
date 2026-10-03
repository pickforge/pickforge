import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSession, listRuns, readActions, saveProjectConfig, type EnvLike, type EvidenceAction } from "@pickforge/lab-core";
import { runDesktopClick, runDesktopDrag } from "../src/commands/desktop.js";

type Identity = { display: string; pid: number; startTicks: number } | undefined | "reject";
const IDENTITY = vi.hoisted(() => ({ display: ":42", pid: 4242, startTicks: 777 }));
const state = vi.hoisted(() => ({ order: [] as string[], fail: false, verify: [] as Identity[], appendFail: false, beginFail: false }));
vi.mock("@pickforge/lab-core", async (original) => {
  const actual = await original<typeof import("@pickforge/lab-core")>();
  return { ...actual,
    appendAction: async (...args: Parameters<typeof actual.appendAction>) => {
      if (state.appendFail) throw new Error("synthetic append failure");
      return actual.appendAction(...args);
    },
    beginEvidenceRun: async (...args: Parameters<typeof actual.beginEvidenceRun>) => {
      if (state.beginFail) throw new Error("synthetic begin failure");
      return actual.beginEvidenceRun(...args);
    },
  };
});
vi.mock("@pickforge/lab-desktop-linux", async (original) => {
  const actual = await original<typeof import("@pickforge/lab-desktop-linux")>();
  const input = async () => {
    state.order.push("input");
    if (state.fail) throw new Error("synthetic input failure");
  };
  return { ...actual, click: input, drag: input,
    verifyOwnedDisplayTarget: vi.fn(async () => {
      state.order.push("verify");
      const next = state.verify.length > 0 ? state.verify.shift() : IDENTITY;
      if (next === "reject") throw new Error("synthetic verification rejection");
      return next;
    }),
  };
});

let root: string;
let env: EnvLike;
let logs: string[];
let errors: string[];
let stderr: string[];
let session: string;
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-desktop-pointer-"));
  env = { PICKFORGE_HOME: path.join(root, "home"), PICKFORGE_STORAGE_MODE: "project-local" };
  process.env.PICKFORGE_HOME = env.PICKFORGE_HOME;
  process.env.PICKFORGE_STORAGE_MODE = "project-local";
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  errors = [];
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
  session = (await createSession({ type: "desktop", projectDir: root, status: "running", desktop: { display: ":42", homePolicy: "private" } }, env)).id;
  state.order = []; state.fail = false; state.verify = []; state.appendFail = false; state.beginFail = false;
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.PICKFORGE_HOME;
  delete process.env.PICKFORGE_STORAGE_MODE;
  process.exitCode = 0;
  await fs.promises.rm(root, { recursive: true, force: true });
});

const opts = () => ({ session, projectDir: root, json: true });
async function actions(): Promise<EvidenceAction[]> {
  const runs = await listRuns(root, env);
  return runs.length === 0 ? [] : await readActions(path.join(root, ".picklab/runs", runs[0]!.runId)) as EvidenceAction[];
}
const click = () => runDesktopClick("2", "3", opts());
const drag = () => runDesktopDrag("1", "4", "2", "3", opts());

it.each([
  ["click", click, "desktop_click", { x: 2, y: 3 }, { sessionId: "", display: ":42", x: 2, y: 3, button: 1 }],
  ["drag", drag, "desktop_drag", { fromX: 1, fromY: 4, x: 2, y: 3 }, { sessionId: "", display: ":42", fromX: 1, fromY: 4, toX: 2, toY: 3, button: 1 }],
] as const)("%s appends one verified record and keeps its JSON output", async (_name, run, tool, target, data) => {
  expect(await run()).toBe(0);
  expect(JSON.parse(logs.at(-1)!)).toEqual({ ok: true, ...data, sessionId: session, errors: [] });
  expect(state.order).toEqual(["verify", "input", "verify"]);
  const recorded = await actions();
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ source: "cli", tool, sessionId: session, status: "ok", inputState: "completed", target: { ...target, coordinateSpace: "xvfb-root" } });
  expect(recorded[0]!.durationMs).toEqual(expect.any(Number));
  expect(recorded[0]!.captures).toBeUndefined();
});

it("records attempted input and the error when the input fails", async () => {
  state.fail = true;
  expect(await drag()).toBe(1);
  const [action] = await actions();
  expect(action).toMatchObject({ tool: "desktop_drag", status: "error", inputState: "attempted", error: expect.stringContaining("synthetic input failure") });
});

it.each<[string, Identity[]]>([
  ["undefined before", [undefined]],
  ["undefined after", [IDENTITY, undefined]],
  ["a different identity after", [IDENTITY, { ...IDENTITY, startTicks: 778 }]],
  ["a rejection before", ["reject"]],
  ["a rejection after", [IDENTITY, "reject"]],
])("drops the coordinate space on %s without blocking input", async (_name, verify) => {
  state.verify = verify;
  expect(await click()).toBe(0);
  expect(state.order).toContain("input");
  const [action] = await actions();
  expect(action!.target).toEqual({ x: 2, y: 3 });
  expect(action!.inputState).toBe("completed");
});

it("writes no record and skips verification when evidence is disabled", async () => {
  await saveProjectConfig(root, { evidence: { enabled: false } });
  expect(await click()).toBe(0);
  expect(await drag()).toBe(0);
  expect(state.order).toEqual(["input", "input"]);
  expect(await listRuns(root, env)).toEqual([]);
});

it("writes no record for argument errors raised before session resolution", async () => {
  expect(await runDesktopClick("x", "3", opts())).toBe(1);
  expect(await runDesktopDrag("1", "4", "2", "3", { ...opts(), button: "10" })).toBe(1);
  expect(state.order).toEqual([]);
  expect(await listRuns(root, env)).toEqual([]);
});

it("keeps the text output unchanged", async () => {
  expect(await runDesktopClick("2", "3", { session, projectDir: root })).toBe(0);
  expect(await runDesktopDrag("1", "4", "2", "3", { session, projectDir: root })).toBe(0);
  expect(logs).toEqual(["clicked (2, 3) on :42", "dragged (1, 4) -> (2, 3) on :42"]);
});

it("keeps a completed input successful when the append fails", async () => {
  state.appendFail = true;
  expect(await click()).toBe(0);
  expect(JSON.parse(logs.at(-1)!)).toEqual({ ok: true, sessionId: session, display: ":42", x: 2, y: 3, button: 1, errors: [] });
  expect(stderr).toEqual(["[pickforge-lab evidence] desktop_click: synthetic append failure\n"]);
});

it("reports the input error, not the append error, when both fail", async () => {
  state.fail = true; state.appendFail = true;
  expect(await drag()).toBe(1);
  const output = [...logs, ...errors].join("\n");
  expect(output).toContain("synthetic input failure");
  expect(output).not.toContain("synthetic append failure");
  expect(stderr).toEqual(["[pickforge-lab evidence] desktop_drag: synthetic append failure\n"]);
});

it("runs the input without a record when the evidence run cannot begin", async () => {
  state.beginFail = true;
  expect(await click()).toBe(0);
  expect(state.order).toEqual(["input"]);
  expect(stderr).toEqual(["[pickforge-lab evidence] desktop_click: synthetic begin failure\n"]);
  expect(await listRuns(root, env)).toEqual([]);
});
