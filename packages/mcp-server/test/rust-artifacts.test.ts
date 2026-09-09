import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { connectLab, makeLabDirs, removeLabDirs, parseToolJson, type ConnectedLab, type LabDirs } from "./helpers.js";
import { hashDir, mixedRuns, plantedSecret, rustDocument, rustId } from "../../core/test/rust-evidence-fixture.js";

let dirs: LabDirs;
let lab: ConnectedLab;
beforeEach(async () => {
  dirs = makeLabDirs();
  lab = await connectLab({ projectDir: dirs.projectDir, env: { PICKFORGE_HOME: dirs.home } });
});
afterEach(async () => { await lab.close(); removeLabDirs(dirs); });

it("lists both sources in tools and resources, with Rust summaries and no per-file resources", async () => {
  const fixture = await mixedRuns(dirs.projectDir);
  const rustDirs = [fixture.rustDir, fixture.corruptDir, fixture.linkedDir];
  const before = rustDirs.map(hashDir);
  const listing = parseToolJson(await lab.client.callTool({ name: "artifact_list", arguments: {} }));
  expect(listing.runs.map((run: { source: string }) => run.source)).toEqual(["rust", "lab", "rust", "rust"]);
  expect(JSON.stringify(listing)).not.toContain(plantedSecret);
  const resource = await lab.client.readResource({ uri: "pickforge://runs" });
  const content = resource.contents[0]!;
  expect("text" in content && JSON.parse(content.text)).toEqual(listing.runs);
  const files = await lab.client.listResources();
  expect(JSON.stringify(files)).not.toContain(`${rustId}/`);
  const report = parseToolJson(await lab.client.callTool({ name: "artifact_report", arguments: { runId: rustId, finalizeOrphans: true } }));
  expect(report).toMatchObject({ source: "rust", outcome: "passed", stepCount: 1 });
  expect(report.report).toContain("report.md");
  expect(report.report).toContain("artifacts/before-home-abcd.png");
  expect(JSON.stringify(report)).not.toContain(plantedSecret);
  const defaultReport = parseToolJson(await lab.client.callTool({ name: "artifact_report", arguments: {} }));
  expect(defaultReport).toMatchObject({ source: "lab", runId: fixture.lab.runId });
  expect(defaultReport.report).toContain(rustId);
  const corrupt = parseToolJson(await lab.client.callTool({ name: "artifact_report", arguments: { runId: "linked-rust" } }));
  expect(corrupt).toMatchObject({ source: "rust", state: "corrupt" });
  expect(rustDirs.map(hashDir)).toEqual(before);
});

it("lists Rust runs when no lab report exists", async () => {
  const dir = path.join(dirs.projectDir, ".picklab/runs", rustId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(rustDocument()));
  const report = parseToolJson(await lab.client.callTool({ name: "artifact_report", arguments: {} }));
  expect(report.rustRuns[0].runId).toBe(rustId);
  expect(report.report).toContain(rustId);
  await expect(lab.client.readResource({ uri: `pickforge://runs/${rustId}/manifest` })).rejects.toThrow();
});
