import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { createRun } from "@pickforge/lab-core";
import { encodePng } from "../../core/src/png-raster.js";
import { ensureCliBuilt } from "./build-once.js";
import { cliSpawnTimeout } from "./spawn-timeout.js";
import { buildProgram } from "../src/program.js";
import { runArtifactsExport } from "../src/commands/artifacts.js";

let project: string;
beforeAll(async () => {
  await ensureCliBuilt();
}, 300_000);
beforeEach(async () => {
  const base = path.join(process.cwd(), "node_modules/.cache");
  await fs.promises.mkdir(base, { recursive: true });
  project = await fs.promises.mkdtemp(path.join(base, "cli-exports-"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});
afterEach(async () => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.promises.rm(project, { recursive: true, force: true });
});
const cli = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
  spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), "packages/cli/dist/pickforge-lab.js"),
      "artifacts",
      "export",
      ...args,
      "--project-dir",
      project,
    ],
    {
      env: { ...process.env, PICKFORGE_STORAGE_MODE: "project-local", ...extraEnv },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
async function fixture() {
  const run = await createRun(project, "export", { evidence: true });
  const bytes = encodePng({ width: 4, height: 4, pixels: Buffer.alloc(64, 255) });
  await fs.promises.writeFile(path.join(run.dir, "screenshots/a.png"), bytes);
  await fs.promises.writeFile(
    path.join(run.dir, "actions.jsonl"),
    JSON.stringify({
      actionId: "a",
      source: "cli",
      tool: "desktop_click",
      status: "ok",
      startedAt: "2026-10-03T12:00:00Z",
      artifacts: ["screenshots/a.png"],
    }) + "\n",
  );
  return run;
}
it("exports the latest run in built CLI JSON and supports explicit ids and text", async () => {
  const run = await fixture();
  const json = cli(["--json", "--frame-ms", "250"]);
  expect(json.status, json.stderr).toBe(0);
  const result = JSON.parse(json.stdout);
  expect(result).toMatchObject({
    ok: true,
    runId: run.runId,
    complete: true,
    frameCount: 1,
    annotatedCount: 0,
    videoPath: null,
    errors: [],
  });
  expect(fs.existsSync(path.join(result.exportDir, "export.json"))).toBe(true);
  expect(fs.existsSync(result.pointerTrackPath)).toBe(true);
  const text = cli([run.runId]);
  expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toMatch(
    /Export: .*exports\/.*\nFrames: 1\nAnnotated: 0\nPointer track: .*pointer-track.json\nVideo: none/,
  );
}, cliSpawnTimeout(2));
it.each(["0", "60001", "1.2", "bad"])("reports invalid frame duration %s", async (duration) => {
  await fixture();
  const result = cli(["--json", "--frame-ms", duration]);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    errors: [expect.stringContaining("--frame-ms")],
  });
});
it("rejects non-evidence and Rust runs with clear errors", async () => {
  const plain = await createRun(project, "plain");
  expect(JSON.parse(cli([plain.runId, "--json"]).stdout).errors[0]).toMatch(/lab evidence run/);
  const rustDir = path.join(project, ".picklab/runs/rust-run");
  await fs.promises.mkdir(rustDir);
  await fs.promises.writeFile(
    path.join(rustDir, "evidence.json"),
    JSON.stringify({
      schemaVersion: 3,
      runId: "rust-run",
      projectId: "p",
      createdAt: "2026-10-03T12:00:00Z",
      scenario: "s",
      outcome: "passed",
      steps: [],
    }),
  );
  const rust = cli(["rust-run", "--json"]);
  expect(rust.status).toBe(1);
  expect(JSON.parse(rust.stdout).errors[0]).toMatch(/Rust runs are unsupported/);
}, cliSpawnTimeout(2));
it("returns a clear missing ffmpeg error and exports without video on the same PATH", async () => {
  await fixture();
  const video = cli(["--video", "--json"], { PATH: project });
  expect(video.status).toBe(1);
  expect(JSON.parse(video.stdout).errors[0]).toMatch(/requires ffmpeg on PATH/);
  expect(cli(["--json"], { PATH: project }).status).toBe(0);
}, cliSpawnTimeout(2));
it("returns preserved export paths and an error when ffmpeg fails", async () => {
  await fixture();
  await fs.promises.writeFile(path.join(project, "ffmpeg"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const failed = cli(["--video", "--json"], { PATH: project });
  expect(failed.status).toBe(1);
  const result = JSON.parse(failed.stdout);
  expect(result).toMatchObject({
    ok: false,
    complete: false,
    frameCount: 1,
    videoPath: null,
    errors: [expect.stringContaining("incomplete export")],
  });
  expect(fs.existsSync(result.pointerTrackPath)).toBe(true);
  expect(fs.existsSync(path.join(result.exportDir, "export.json"))).toBe(false);
});
it("registers options and uses runReported in the source command", async () => {
  const run = await fixture();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await buildProgram().parseAsync(
    ["artifacts", "export", run.runId, "--json", "--project-dir", project, "--frame-ms", "100"],
    { from: "user" },
  );
  expect(process.exitCode).toBe(0);
  expect(JSON.parse(output.mock.calls.at(-1)![0])).toMatchObject({ ok: true, frameCount: 1 });
  expect(await runArtifactsExport("missing", { projectDir: project, json: true })).toBe(1);
  expect(JSON.parse(output.mock.calls.at(-1)![0]).errors[0]).toMatch(/Run not found/);
});
