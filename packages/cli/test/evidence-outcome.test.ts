import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendAction, createRun } from "@pickforge/lab-core";
import { buildProgram } from "../src/program.js";

let project: string;
beforeEach(async () => {
  project = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cli-outcome-"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});
afterEach(async () => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.promises.rm(project, { recursive: true, force: true });
});

it("parses repeated outcome options and reports acceptance errors and success", async () => {
  const run = await createRun(project, "acceptance", { evidence: true });
  await fs.promises.writeFile(path.join(run.dir, "screenshots/accepted.png"), "png");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const args = ["node", "pickforge-lab", "artifacts", "outcome", run.runId,
    "--scenario", "Checkout", "--status", "pass", "--inspected", "screenshots/accepted.png",
    "--step", "Click submit", "--step", "Inspect result", "--limitation", "Desktop only",
    "--revision", "abc123", "--json", "--project-dir", project];
  await buildProgram().parseAsync(args);
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(output.mock.calls.at(-1)![0]).errors.join(" ")).toContain("Recording alone");
  await appendAction(run, { actionId: "click", source: "cli", tool: "desktop_click", status: "ok", startedAt: new Date().toISOString() });
  await buildProgram().parseAsync(args);
  expect(process.exitCode).toBe(0);
  expect(JSON.parse(output.mock.calls.at(-1)![0]).outcome).toMatchObject({
    status: "pass", steps: ["Click submit", "Inspect result"], limitations: ["Desktop only"], revision: "abc123",
  });
});

it.each([
  ["step", 33, "--step"],
  ["limitation", 33, "--limitation"],
  ["inspected", 65, "--inspected"],
])("rejects more than the allowed number of --%s options", async (_flag, count, option) => {
  const run = await createRun(project, "acceptance", { evidence: true });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const repeated = Array.from({ length: count }, () => [option, "screenshots/a.png"]).flat();
  await buildProgram().parseAsync(["node", "pickforge-lab", "artifacts", "outcome", run.runId,
    "--scenario", "Checkout", "--status", "blocked", ...repeated, "--json", "--project-dir", project]);
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(output.mock.calls.at(-1)![0]).errors.join(" ")).toMatch(new RegExp(`At most \\d+ ${option} options are allowed`));
});
