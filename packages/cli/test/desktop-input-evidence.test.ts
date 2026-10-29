import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acquireHumanLease, withAgentPermit, createSession, listRuns, readActions, saveProjectConfig, type EnvLike, type EvidenceAction } from "@pickforge/lab-core";
import { runDesktopDoubleClick, runDesktopKey, runDesktopMove, runDesktopScroll, runDesktopType } from "../src/commands/desktop.js";

const IDENTITY = vi.hoisted(() => ({ display: ":42", pid: 4242, startTicks: 777 }));
const FOCUS = vi.hoisted(() => ({ x: 10, y: 20, width: 300, height: 200 }));
const state = vi.hoisted(() => ({
  order: [] as string[], fail: false, unowned: false, unprepared: false, inputs: [] as Record<string, unknown>[],
}));
vi.mock("@pickforge/lab-desktop-linux", async (original) => {
  const actual = await original<typeof import("@pickforge/lab-desktop-linux")>();
  const input = (name: string) => async (opts: { sessionId: string; display: string }) =>
    withAgentPermit(opts.sessionId, process.env, async () => {
      if (state.unowned) throw new actual.DesktopInputTargetError();
      if (state.unprepared && name === "type") throw new actual.DesktopTextPreparationError("Desktop text preparation failed; no text was sent");
      state.order.push("input");
      state.inputs.push({ name, ...opts });
      if (state.fail) throw new Error(`synthetic ${name} failure`);
    });
  return { ...actual,
    move: input("move"), scroll: input("scroll"), doubleClick: input("double-click"), pressKey: input("key"), typeText: input("type"),
    verifyOwnedDisplayTarget: vi.fn(async () => { state.order.push("verify"); return IDENTITY; }),
    focusedWindowGeometry: vi.fn(async () => { state.order.push("focus"); return FOCUS; }),
  };
});

const MARKER = "pf409-typed-marker-7d1c";
let root: string;
let env: EnvLike;
let logs: string[];
let errors: string[];
let stderr: string[];
let session: string;
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-desktop-input-"));
  env = { PICKFORGE_HOME: path.join(root, "home"), PICKFORGE_STORAGE_MODE: "project-local" };
  process.env.PICKFORGE_HOME = env.PICKFORGE_HOME;
  process.env.PICKFORGE_STORAGE_MODE = "project-local";
  logs = [];
  errors = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
  session = (await createSession({ type: "desktop", projectDir: root, status: "running", desktop: { display: ":42", homePolicy: "private" } }, env)).id;
  state.order = []; state.fail = false; state.unowned = false; state.unprepared = false; state.inputs = [];
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
function filesContaining(dir: string, needle: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => fs.readFileSync(file, "utf8").includes(needle));
}

const ROOT = { coordinateSpace: "xvfb-root" };
const commands = [
  ["move", () => runDesktopMove("2", "3", opts()), "desktop_move", { x: 2, y: 3, ...ROOT }, ["verify", "input", "verify"]],
  ["scroll", () => runDesktopScroll("0", "-2", opts()), "desktop_scroll", { wheelX: 0, wheelY: -2 }, ["input"]],
  ["scroll --at", () => runDesktopScroll("1", "2", { ...opts(), at: "5,6" }), "desktop_scroll", { x: 5, y: 6, wheelX: 1, wheelY: 2, ...ROOT }, ["verify", "input", "verify"]],
  ["double-click", () => runDesktopDoubleClick("2", "3", opts()), "desktop_double_click", { x: 2, y: 3, ...ROOT }, ["verify", "input", "verify"]],
  ["key", () => runDesktopKey("ctrl+s", opts()), "desktop_key", { length: 6, inputType: "other" }, ["input"]],
  ["type", () => runDesktopType(MARKER, opts()), "desktop_type", { length: MARKER.length, inputType: "text", focus: FOCUS, ...ROOT }, ["verify", "focus", "input", "verify"]],
] as const;

it.each(commands)("%s appends one completed record with the MCP target", async (_name, run, tool, target, order) => {
  expect(await run()).toBe(0);
  expect(state.order).toEqual(order);
  const recorded = await actions();
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ source: "cli", tool, sessionId: session, status: "ok", inputState: "completed" });
  expect(recorded[0]!.target).toEqual(target);
  expect(recorded[0]!.durationMs).toEqual(expect.any(Number));
});

it.each(commands)("%s records attempted input and the error when the input fails", async (_name, run, tool) => {
  state.fail = true;
  expect(await run()).toBe(1);
  expect(state.order).toContain("input");
  expect(await actions()).toMatchObject([{ tool, status: "error", inputState: "attempted", error: expect.stringContaining("synthetic") }]);
});

it.each(commands)("%s records not-attempted when human control refuses input", async (_name, run, tool) => {
  await acquireHumanLease(session, env);
  expect(await run()).toBe(1);
  expect(state.order).not.toContain("input");
  expect(await actions()).toMatchObject([{ tool, status: "error", inputState: "not-attempted", error: expect.stringContaining("human control is active") }]);
});

it.each(commands)("%s records not-attempted when the session display is not verified", async (_name, run, tool) => {
  state.unowned = true;
  expect(await run()).toBe(1);
  expect(await actions()).toMatchObject([{ tool, status: "error", inputState: "not-attempted", error: expect.stringContaining("no input was sent") }]);
});

it.each(commands)("%s records not-attempted when the session's permit storage is gone", async (_name, run, tool) => {
  fs.mkdirSync(path.join(env.PICKFORGE_HOME!, "sessions", session));
  fs.writeFileSync(path.join(env.PICKFORGE_HOME!, "sessions", session, "permits"), "blocked");
  expect(await run()).toBe(1);
  expect(state.order).not.toContain("input");
  expect(await actions()).toMatchObject([{ tool, status: "error", inputState: "not-attempted" }]);
});

it("records type as not-attempted when text preparation fails", async () => {
  state.unprepared = true;
  expect(await runDesktopType(MARKER, opts())).toBe(1);
  expect(await actions()).toMatchObject([{ tool: "desktop_type", status: "error", inputState: "not-attempted" }]);
});

it.each([["completed", false], ["failed", true]] as const)("keeps the typed text out of evidence, output and logs when type is %s", async (_name, fail) => {
  state.fail = fail;
  expect(await runDesktopType(MARKER, opts())).toBe(fail ? 1 : 0);
  expect(state.inputs).toMatchObject([{ name: "type", text: MARKER }]);
  expect(await actions()).toHaveLength(1);
  expect(filesContaining(root, MARKER)).toEqual([]);
  expect([...logs, ...errors, ...stderr].join("\n")).not.toContain(MARKER);
  if (!fail) expect(JSON.parse(logs.at(-1)!)).toEqual({ ok: true, sessionId: session, display: ":42", length: MARKER.length, errors: [] });
});

it("writes no record and skips the evidence checks when evidence is disabled", async () => {
  await saveProjectConfig(root, { evidence: { enabled: false } });
  for (const [, run] of commands) expect(await run()).toBe(0);
  expect(state.order).toEqual(commands.map(() => "input"));
  expect(await listRuns(root, env)).toEqual([]);
});

it("keeps one run for a sequence of inputs", async () => {
  for (const [, run] of commands) expect(await run()).toBe(0);
  expect(await listRuns(root, env)).toHaveLength(1);
  expect((await actions()).map((action) => action.tool)).toEqual(commands.map(([, , tool]) => tool));
});
