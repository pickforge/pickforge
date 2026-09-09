import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DirHandle, withDirHandle } from "../src/dir-handle.js";
import { openRunCatalog, RunCatalog } from "../src/run-catalog.js";
import { listArtifactRuns, listRustEvidenceRuns, readRustEvidenceRun, renderRustEvidenceReport } from "../src/rust-evidence.js";
import { finalizeOrphanedEvidenceRuns } from "../src/evidence-recovery.js";
import { hashDir, mixedRuns, plantedSecret, rustDocument, rustId } from "./rust-evidence-fixture.js";

let project: string;
beforeEach(() => { project = fs.mkdtempSync(path.join(os.tmpdir(), "rust-evidence-")); });
afterEach(() => { fs.rmSync(project, { recursive: true, force: true }); });
const env = { PICKFORGE_STORAGE_MODE: "project-local" };

it("merges both sources, reports corruption and never recovers Rust evidence", async () => {
  const fixture = await mixedRuns(project);
  const catalog = await openRunCatalog(project, env);
  const runs = await listArtifactRuns(catalog);
  expect(runs.map(run => run.source)).toEqual(["rust", "lab", "rust", "rust"]);
  expect(runs[0]).toMatchObject({ runId: rustId, status: "passed", artifacts: 1 });
  const rust = await listRustEvidenceRuns(catalog);
  expect(rust.filter(run => run.state === "corrupt")).toHaveLength(2);
  expect(renderRustEvidenceReport(rust[0]!).join("\n")).toContain("artifacts/before-home-abcd.png");
  expect(JSON.stringify(rust)).not.toContain(plantedSecret);
  const dirs = [fixture.rustDir, fixture.corruptDir, fixture.linkedDir];
  const before = dirs.map(hashDir);
  await finalizeOrphanedEvidenceRuns(project, env);
  expect(dirs.map(hashDir)).toEqual(before);
  expect(fs.existsSync(path.join(fixture.rustDir, "manifest.json"))).toBe(false);
});

it.each([1, 2, 3])("accepts schema %s, unknown fields and root screenshots", async schemaVersion => {
  const { rustDir } = await mixedRuns(project);
  const doc = rustDocument();
  fs.writeFileSync(path.join(rustDir, "root.png"), "picture");
  doc.before.artifacts.push({ ...doc.before.artifacts[0]!, path: "root.png" });
  fs.writeFileSync(path.join(rustDir, "evidence.json"), JSON.stringify({ ...doc, schemaVersion, extra: true }));
  const run = await readRustEvidenceRun(rustDir);
  expect(run).toMatchObject({ state: "valid", stepCount: 1, screenshots: ["artifacts/before-home-abcd.png", "root.png"] });
});

it.each(["null", "[]", '{"schemaVersion":4}', "x".repeat(1024 * 1024 + 1)])("classifies invalid documents as corrupt", async raw => {
  const { rustDir } = await mixedRuns(project);
  fs.writeFileSync(path.join(rustDir, "evidence.json"), raw);
  expect(await withDirHandle(DirHandle.open(rustDir), readRustEvidenceRun)).toMatchObject({ state: "corrupt" });
});

it("confines screenshots and ignores absent evidence, unsafe roots and run links", async () => {
  const { rustDir } = await mixedRuns(project);
  const doc = rustDocument();
  fs.symlinkSync(path.join(rustDir, "report.md"), path.join(rustDir, "link.png"));
  for (const name of ["../outside.png", "artifacts/../report.md", "link.png", "missing.png", "screenshots/x.png", "artifacts/nested/x.png"]) {
    doc.before.artifacts.push({ ...doc.before.artifacts[0]!, path: name });
  }
  fs.writeFileSync(path.join(rustDir, "evidence.json"), JSON.stringify(doc));
  const root = path.dirname(rustDir);
  fs.symlinkSync(rustDir, path.join(root, "run-link"));
  fs.mkdirSync(path.join(root, "empty"));
  expect(await readRustEvidenceRun(path.join(root, "run-link"))).toBeUndefined();
  const catalog = await openRunCatalog(project, env);
  const rust = await listRustEvidenceRuns(catalog);
  expect(rust).toHaveLength(3);
  expect(rust[0]!.screenshots).toEqual(["artifacts/before-home-abcd.png"]);
  const badRoot = new RunCatalog([{ dir: root, expectedRealDir: project }]);
  expect(await listRustEvidenceRuns(badRoot)).toEqual([]);
  const duplicated = new RunCatalog([...catalog.roots, ...catalog.roots]);
  expect(await listRustEvidenceRuns(duplicated)).toHaveLength(3);
});

it("rejects linked artifact directories and invalid identity fields", async () => {
  const { rustDir } = await mixedRuns(project);
  const other = path.join(path.dirname(rustDir), "other-rust");
  fs.mkdirSync(other);
  fs.symlinkSync(path.join(rustDir, "artifacts"), path.join(other, "artifacts"));
  fs.writeFileSync(path.join(other, "evidence.json"), JSON.stringify(rustDocument("other-rust")));
  const read = () => withDirHandle(DirHandle.open(other), readRustEvidenceRun);
  expect(await read()).toMatchObject({ state: "valid", screenshots: [] });
  for (const patch of [{ runId: "wrong" }, { outcome: ["passed"] }, { createdAt: "bad" }, { projectId: 4 }]) {
    fs.writeFileSync(path.join(other, "evidence.json"), JSON.stringify({ ...rustDocument("other-rust"), ...patch }));
    expect(await read()).toMatchObject({ state: "corrupt" });
  }
});

it("skips dot-prefixed staging directories left by the Rust writer", async () => {
  const { rustDir } = await mixedRuns(project);
  const staging = path.join(path.dirname(rustDir), `.pickforge-evidence-${rustId}-4242`);
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, "evidence.json"), JSON.stringify(rustDocument()));
  const runs = await listRustEvidenceRuns(await openRunCatalog(project, env));
  expect(runs.map(run => run.runId)).not.toContain(path.basename(staging));
});

it("omits the report path when report.md is absent and keeps keyword-like check names intact", async () => {
  const { rustDir } = await mixedRuns(project);
  fs.rmSync(path.join(rustDir, "report.md"));
  const doc = rustDocument();
  doc.checks.push({ name: "Login session", status: "passed", summary: "Visible", step: "login" });
  fs.writeFileSync(path.join(rustDir, "evidence.json"), JSON.stringify(doc));
  const run = await readRustEvidenceRun(rustDir);
  expect(run?.reportPath).toBe("");
  const report = renderRustEvidenceReport(run!).join("\n");
  expect(report).not.toContain("Report:");
  expect(report).toContain("- Login session: passed Visible");
  expect(report).not.toContain(plantedSecret);
});
