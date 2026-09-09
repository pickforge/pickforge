import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runArtifactsList, runArtifactsReport } from "../src/commands/artifacts.js";
import { hashDir, mixedRuns, plantedSecret, rustDocument, rustId } from "../../core/test/rust-evidence-fixture.js";

let projectDir: string;
beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rust-artifacts-cli-"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(projectDir, { recursive: true, force: true });
});

it.each([false, true])("lists and reports mixed evidence (json=%s) without changing Rust runs", async json => {
  const fixture = await mixedRuns(projectDir);
  const dirs = [fixture.rustDir, fixture.corruptDir, fixture.linkedDir];
  const before = dirs.map(hashDir);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const printed = () => output.mock.calls.map(call => call[0]).join("\n");
  expect(await runArtifactsList({ projectDir, json })).toBe(0);
  expect(printed()).toContain(rustId);
  expect(printed()).toContain("rust");
  expect(printed()).toContain("lab");
  expect(printed()).not.toContain(plantedSecret);
  if (json) expect(JSON.parse(printed()).runs[0]).toMatchObject({ source: "rust", runId: rustId });
  output.mockClear();
  expect(await runArtifactsReport(rustId, { projectDir, json, finalizeOrphans: true })).toBe(0);
  expect(printed()).toContain("artifacts/before-home-abcd.png");
  expect(printed()).toContain("report.md");
  expect(printed()).not.toContain(plantedSecret);
  if (json) expect(JSON.parse(printed())).toMatchObject({ source: "rust", stepCount: 1, outcome: "passed" });
  output.mockClear();
  expect(await runArtifactsReport(undefined, { projectDir, json })).toBe(0);
  expect(printed()).toContain(fixture.lab.runId);
  expect(printed()).toContain(rustId);
  if (json) expect(JSON.parse(printed()).source).toBe("lab");
  expect(dirs.map(hashDir)).toEqual(before);
});

it("reports a corrupt Rust entry", async () => {
  await mixedRuns(projectDir);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await runArtifactsReport("corrupt-rust", { projectDir, json: true })).toBe(0);
  expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ source: "rust", state: "corrupt" });
});

it("lists Rust runs when no lab report exists", async () => {
  const dir = path.join(projectDir, ".picklab/runs", rustId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(rustDocument()));
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await runArtifactsReport(undefined, { projectDir, json: true })).toBe(0);
  expect(JSON.parse(String(output.mock.calls[0]![0])).rustRuns[0].runId).toBe(rustId);
});
