import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireHumanLease, readActions, readHumanLease, releaseHumanLease, resolveRunStorage, type EnvLike } from "@pickforge/lab-core";
import { registerTakeoverTools } from "../src/tools/takeover.js";
import { connectLab, makeLabDirs, MINI_PNG, parseToolJson, writeDesktopSessionRecord, writeScript, type ConnectedLab, type LabDirs } from "./helpers.js";

let dirs: LabDirs;
let env: EnvLike;
let lab: ConnectedLab;
let id: string;
let captureLog: string;

beforeEach(async () => {
  dirs = makeLabDirs();
  env = { PICKFORGE_HOME: dirs.home, PICKFORGE_STORAGE_MODE: "project-local", PATH: dirs.binDir };
  const fixture = path.join(dirs.root, "fresh.png");
  captureLog = path.join(dirs.root, "captures");
  fs.writeFileSync(fixture, MINI_PNG);
  const body = `echo capture >> "${captureLog}"\nfor arg in "$@"; do out="$arg"; done\n/bin/cp "${fixture}" "$out"`;
  writeScript(path.join(dirs.binDir, "import"), body);
  writeScript(path.join(dirs.binDir, "maim"), body);
  id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
  lab = await connectLab({ projectDir: dirs.projectDir, env });
});

afterEach(async () => {
  await lab.close();
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

describe("takeover_wait", () => {
  it("waits for return, then captures through the observation and evidence path", async () => {
    const lease = await acquireHumanLease(id, env);
    const pending = lab.client.callTool({ name: "takeover_wait", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fs.existsSync(captureLog)).toBe(false);
    await releaseHumanLease(id, lease.leaseId, env);
    const result = parseToolJson(await pending);
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(result.outcome).toBe("returned");
    expect(result.heldMs).toBeGreaterThanOrEqual(50);
    expect(result.screenshot).toMatchObject({ sessionId: id, scale: 1, inputCoordinates: "image-pixels" });
    expect(fs.readFileSync(result.screenshot.path)).toEqual(MINI_PNG);
    expect(fs.readFileSync(captureLog, "utf8").trim().split("\n")).toHaveLength(1);
    const actions = await readActions(result.screenshot.runDir);
    expect(actions).toContainEqual(expect.objectContaining({ tool: "takeover_wait", status: "ok" }));
  });

  it("captures immediately when there is no human lease", async () => {
    const result = parseToolJson(await lab.client.callTool({ name: "takeover_wait", arguments: { session: id, timeoutMs: 0 } }));
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("returned");
    expect(result.heldMs).toBe(0);
    expect(result.screenshot.path).toBeTruthy();
  });

  it("counts control held before takeover_wait was called", async () => {
    await acquireHumanLease(id, env, { now: new Date(Date.now() - 2_000) });
    const result = parseToolJson(await lab.client.callTool({ name: "takeover_wait", arguments: { session: id, timeoutMs: 0 } }));
    expect(result.heldMs).toBeGreaterThanOrEqual(2_000);
  });

  it("times out without capturing or changing a live lease", async () => {
    const lease = await acquireHumanLease(id, env);
    const result = parseToolJson(await lab.client.callTool({ name: "takeover_wait", arguments: { session: id, timeoutMs: 60 } }));
    expect(result).toMatchObject({ ok: true, outcome: "timeout", screenshot: null });
    expect(result.heldMs).toBeGreaterThanOrEqual(60);
    expect(result.heldMs).toBeLessThan(2_000);
    expect(fs.existsSync(captureLog)).toBe(false);
    expect(await readHumanLease(id, env)).toMatchObject({ leaseId: lease.leaseId });
  });

  it("returns cancelled from the handler when the MCP request signal aborts", async () => {
    await acquireHumanLease(id, env);
    const registerTool = vi.fn();
    registerTakeoverTools({ registerTool } as unknown as McpServer, { projectDir: dirs.projectDir, env });
    const handler = registerTool.mock.calls.find(([name]) => name === "takeover_wait")![2];
    const controller = new AbortController();
    const pending = handler({ session: id }, { mcpReq: { signal: controller.signal } });
    setTimeout(() => controller.abort(), 50);
    const result = parseToolJson(await pending);
    expect(result).toMatchObject({ ok: true, outcome: "cancelled", screenshot: null });
    expect(result.heldMs).toBeLessThan(2_000);
    expect(fs.existsSync(captureLog)).toBe(false);
  });

  it("honours cancellation across the MCP transport", async () => {
    await acquireHumanLease(id, env);
    const controller = new AbortController();
    const pending = lab.client.callTool({ name: "takeover_wait", arguments: { session: id } }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
    const { runsDir } = await resolveRunStorage(dirs.projectDir, env);
    await expect.poll(async () => {
      const runs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((name) => !name.startsWith(".")) : [];
      const actions = await Promise.all(runs.map((name) => readActions(path.join(runsDir, name))));
      return actions.flat().some((action) => "tool" in action && action.tool === "takeover_wait" && action.status === "cancelled");
    }).toBe(true);
    expect(fs.existsSync(captureLog)).toBe(false);
  });

  it.each([-1, 1.5, 3_600_001])("rejects timeoutMs %s", async (timeoutMs) => {
    const result = await lab.client.callTool({ name: "takeover_wait", arguments: { session: id, timeoutMs } });
    expect(result.isError).toBe(true);
    expect(fs.existsSync(captureLog)).toBe(false);
  });
});
