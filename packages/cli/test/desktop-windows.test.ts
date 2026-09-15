import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { listRuns, readActions } from "@pickforge/lab-core";
import { windowFixture } from "../../desktop-linux/test/windows-fixture.js";
import { buildProgram } from "../src/program.js";
import { ensureCliBuilt } from "./build-once.js";

beforeAll(ensureCliBuilt, 300_000);

let fixture: Awaited<ReturnType<typeof windowFixture>>;
let logs: string[];
beforeEach(async () => {
  fixture = await windowFixture();
  for (const [key, value] of Object.entries(fixture.env)) vi.stubEnv(key, value);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => { logs.push(String(line)); });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fixture.cleanup(); process.exitCode = 0; });

async function command(args: string[]) {
  await buildProgram().parseAsync(["desktop", ...args, "--session", fixture.session.id, "--project-dir", fixture.root, "--json"], { from: "user" });
  return JSON.parse(logs.at(-1)!);
}

it("wires inventory and exact-name focus with window identity evidence", async () => {
  expect((await command(["windows"])).windows).toHaveLength(2);
  expect(await command(["focus", "--name", "Two"])).toMatchObject({ ok: true, window: { id: "22", name: "Two", focused: true } });
  const runs = await listRuns(fixture.root, fixture.env);
  const actions = await readActions(path.join(fixture.root, ".picklab/runs", runs[0]!.runId));
  expect(actions).toContainEqual(expect.objectContaining({ tool: "desktop_focus", source: "cli", status: "ok", target: { role: "window", name: "Two", selector: "22" } }));
});

it("runs the rebuilt CLI with literal selector argv", () => {
  const name = "--odd .*; $(touch nope)";
  fixture.state({ names: ["One", name] });
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../dist/pickforge-lab.js", import.meta.url)),
    "desktop", "focus", "--name", name, "--session", fixture.session.id,
    "--project-dir", fixture.root, "--json",
  ], { env: fixture.env, timeout: 10_000, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, window: { id: "22", name } });
});

it("records focus timeout errors and refuses ambiguous names", async () => {
  fixture.state({ ignore: true });
  expect(await command(["focus", "--id", "22", "--timeout", "150"])).toMatchObject({ ok: false });
  const runs = await listRuns(fixture.root, fixture.env);
  expect(await readActions(path.join(fixture.root, ".picklab/runs", runs[0]!.runId))).toContainEqual(expect.objectContaining({ tool: "desktop_focus", status: "timeout", error: expect.stringMatching(/timed out/i) }));
  fixture.state({ names: ["Same", "Same"] });
  expect((await command(["focus", "--name", "Same"])).errors[0]).toContain("Ambiguous");
  expect((await command(["focus", "--id", "11", "--name", "Same"])).errors[0]).toContain("exactly one");
  expect(await readActions(path.join(fixture.root, ".picklab/runs", runs[0]!.runId))).toContainEqual(expect.objectContaining({ tool: "desktop_focus", status: "error", error: expect.stringContaining("Ambiguous") }));
});
