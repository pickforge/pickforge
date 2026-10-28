import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  expect(runs[0]).toMatchObject({ runId: rustId, status: "passed", artifacts: 1, outcome: null });
  expect(runs.find(run => run.source === "lab")).toMatchObject({ outcome: null });
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

it.each([1, 2, 3, 4])("accepts schema %s, unknown fields and root screenshots", async schemaVersion => {
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

const fixtures = fileURLToPath(new URL("../../../crates/pickforge-cli/tests/fixtures/", import.meta.url));
function copyRustFixture(root: string, version: "v3" | "v4"): string {
  const source = path.join(fixtures, `evidence-${version}`);
  const runId = fs.readdirSync(source).find(name => /^\d{8}-\d{6}-flutter$/.test(name))!;
  fs.cpSync(path.join(source, runId), path.join(root, runId), { recursive: true });
  return path.join(root, runId);
}

it("reads a real schema v3 run recorded by the Rust CLI", async () => {
  const { rustDir } = await mixedRuns(project);
  const dir = copyRustFixture(path.dirname(rustDir), "v3");
  const run = await readRustEvidenceRun(dir);
  expect(run).toMatchObject({
    state: "valid", outcome: "passed", stepCount: 1, captures: [], artifacts: [],
    screenshots: ["artifacts/before-initial-frame-a874ead9968c.png", "artifacts/after-reloaded-frame-fdb14ef3ce60.png"],
  });
  const report = renderRustEvidenceReport(run!).join("\n");
  expect(report).not.toContain("Captures:");
  expect(report).not.toContain("Artifacts:");
});

it("shows captures and text artifacts from a real schema v4 run without reading their content", async () => {
  const { rustDir } = await mixedRuns(project);
  const dir = copyRustFixture(path.dirname(rustDir), "v4");
  const run = await readRustEvidenceRun(dir);
  expect(run?.state).toBe("valid");
  expect(run!.screenshots).toEqual(["artifacts/after-unfolded-fdb14ef3ce60.png"]);
  expect(run!.captures).toEqual([
    {
      phase: "before", capturedAt: "2026-10-28T15:59:00Z", appBuild: "1.4.0+42", emulatorVersion: "35.2.10",
      systemImage: "system-images;android-35;google_apis;x86_64",
      requested: { foldState: "folded", darkMode: true },
      observed: { displayMode: "unknown", foldState: "folded", posture: "unknown", rotation: 0, density: 420,
        fontScale: 1, darkMode: true, locale: "en-US" },
    },
    expect.objectContaining({ phase: "after", emulatorVersion: "unknown", requested: { foldState: "flat", posture: "open" } }),
  ]);
  expect(run!.artifacts.map(item => [item.phase, item.kind, item.origin, item.status, item.format])).toEqual([
    ["before", "tree", "android-ui-tree", "captured", "xml"],
    ["before", "log", "android-logcat", "captured", "text"],
    ["after", "report", "lighthouse", "captured", "html"],
    ["after", "tree", "atspi-tree", "unavailable", undefined],
  ]);
  expect(run!.artifacts[3]).toMatchObject({ reason: "AT-SPI capture lands with #359", capturedAt: "unknown" });
  const report = renderRustEvidenceReport(run!).join("\n");
  expect(report).toContain("- before: captured at 2026-10-28T15:59:00Z; app build 1.4.0+42; emulator 35.2.10;");
  expect(report).toContain("  requested: foldState folded, darkMode true");
  expect(report).toContain("- after: Lighthouse (report from lighthouse): artifacts/after-lighthouse-2dc745debb1a.txt, html, 124 bytes");
  expect(report).toContain("- after: Desktop tree (tree from atspi-tree): unavailable, AT-SPI capture lands with #359");
  // The imported HTML stays in its file; neither the summary nor the report carries it.
  expect(JSON.stringify(run)).not.toContain("<script");
  expect(report).not.toContain("<script");
  const listed = (await listArtifactRuns(await openRunCatalog(project, env))).find(item => item.runId === run!.runId);
  expect(listed?.artifacts).toBe(4);
});

it("marks listed text artifacts missing when a partial run lacks their files and redacts tampered fields", async () => {
  const { rustDir } = await mixedRuns(project);
  const dir = copyRustFixture(path.dirname(rustDir), "v4");
  fs.rmSync(path.join(dir, "artifacts/before-logcat-921da56f023f.txt"));
  const doc = JSON.parse(fs.readFileSync(path.join(dir, "evidence.json"), "utf8"));
  doc.before.artifacts[0].path = "../evidence.json";
  doc.after.artifacts[2].reason = `token=${plantedSecret}`;
  doc.after.capture.appBuild = `password=${plantedSecret}`;
  doc.after.capture.observed = { rotation: 90, nested: { a: 1 }, "bad key": 1, fontScale: Number.MAX_VALUE };
  fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(doc));
  const run = await readRustEvidenceRun(dir);
  expect(run?.state).toBe("valid");
  expect(run!.artifacts.slice(0, 2).map(item => item.status)).toEqual(["missing", "missing"]);
  expect(run!.captures[1]!.observed).toEqual({ rotation: 90, fontScale: Number.MAX_VALUE });
  expect(JSON.stringify(run)).not.toContain(plantedSecret);
  expect(renderRustEvidenceReport(run!).join("\n")).toContain("- before: UI tree (tree from android-ui-tree): missing ../evidence.json");
});
