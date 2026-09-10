import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendAction, beginEvidenceRun, activePointerPath } from "../src/evidence.js";
import { finalizeOrphanedEvidenceRuns, type EvidenceRecoveryResult } from "../src/evidence-recovery.js";
import { createRun, type RunManifest } from "../src/run.js";
import { DirHandle, RunStorageAccessError } from "../src/dir-handle.js";
import { openExistingRunsRootDir } from "../src/run-root.js";
import { layoutMarkerContent } from "../src/state-layout.js";

const worker = fileURLToPath(new URL("./workers/evidence-recovery-worker.ts", import.meta.url));
let root: string;
let project: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-recovery-"));
  project = path.join(root, "project");
  await fs.promises.mkdir(project);
  vi.stubEnv("PICKFORGE_HOME", path.join(root, "home"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function subprocess(mode: string, source = "cli") {
  const child = spawn("bun", [worker, project, mode, source], { stdio: ["ignore", "pipe", "pipe"], timeout: 8_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, "close");
  expect(stderr).toBe("");
  return { code, signal, stdout };
}

async function manifest(dir: string): Promise<RunManifest> {
  return JSON.parse(await fs.promises.readFile(path.join(dir, "manifest.json"), "utf8")) as RunManifest;
}

async function seed(mode = "write", source = "cli"): Promise<{ runId: string; dir: string }> {
  const result = await subprocess(mode, source);
  expect(mode === "torn" ? result.signal : result.code).toBe(mode === "torn" ? "SIGKILL" : 0);
  return JSON.parse(result.stdout) as { runId: string; dir: string };
}

const action = {
  actionId: "after-recovery", source: "test", tool: "synthetic", status: "ok" as const,
  startedAt: "2026-09-05T05:30:00.000Z",
};

function skipped(
  runId: string,
  reason = "owner or session identity unavailable",
): { runId: string; reason: string }[] {
  return [{ runId, reason }];
}

describe("explicit evidence recovery", () => {
  it.each(["unsupported", "malformed", "foreign", "symlink", "hardlink", "fifo"])("refuses %s shared layouts before recovery writes", async (kind) => {
    vi.stubEnv("PICKFORGE_STORAGE_MODE", "home");
    const run = await seed();
    const state = path.dirname(path.dirname(run.dir));
    const marker = path.join(state, "layout.json");
    await fs.promises.rename(marker, path.join(root, "saved-layout"));
    if (kind === "unsupported") await fs.promises.writeFile(marker, JSON.stringify({ layout: "pickforge-project-state", layoutVersion: 99 }));
    if (kind === "malformed") await fs.promises.writeFile(marker, "not-json");
    if (kind === "foreign") await fs.promises.writeFile(path.join(state, "foreign"), "untouched");
    if (kind === "symlink") await fs.promises.symlink(path.join(root, "saved-layout"), marker);
    if (kind === "hardlink") await fs.promises.link(path.join(root, "saved-layout"), marker);
    if (kind === "fifo") expect(spawnSync("mkfifo", [marker]).status).toBe(0);
    const before = await fs.promises.readFile(path.join(run.dir, "manifest.json"));
    const entries = await fs.promises.readdir(run.dir);
    await expect(finalizeOrphanedEvidenceRuns(project)).rejects.toThrow();
    expect(await fs.promises.readFile(path.join(run.dir, "manifest.json"))).toEqual(before);
    expect(await fs.promises.readdir(run.dir)).toEqual(entries);
    expect(await fs.promises.readFile(path.join(root, "saved-layout"), "utf8")).toBe(layoutMarkerContent());
    expect(await fs.promises.readdir(state)).not.toContain("session-brow-synthetic.html");
  });

  it("adopts an unmarked valid layout only for recovery, not readers", async () => {
    vi.stubEnv("PICKFORGE_STORAGE_MODE", "home");
    const run = await seed();
    const marker = path.join(path.dirname(path.dirname(run.dir)), "layout.json");
    await fs.promises.rename(marker, path.join(root, "saved-layout"));
    const reader = await openExistingRunsRootDir(project);
    await reader?.close();
    expect(fs.existsSync(marker)).toBe(false);
    expect((await finalizeOrphanedEvidenceRuns(project)).sessions).toHaveLength(1);
    expect(await fs.promises.readFile(marker, "utf8")).toBe(layoutMarkerContent());
  });

  it("propagates layout claim refusal before touching runs", async () => {
    vi.stubEnv("PICKFORGE_STORAGE_MODE", "home");
    const run = await seed();
    const marker = path.join(path.dirname(path.dirname(run.dir)), "layout.json");
    await fs.promises.rename(marker, path.join(root, "saved-layout"));
    const before = await fs.promises.readFile(path.join(run.dir, "manifest.json"));
    vi.spyOn(DirHandle.prototype, "linkChild").mockRejectedValue(Object.assign(new Error("claim denied"), { code: "EACCES" }));
    await expect(finalizeOrphanedEvidenceRuns(project)).rejects.toThrow(/claim denied/);
    expect(await fs.promises.readFile(path.join(run.dir, "manifest.json"))).toEqual(before);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("binds layout adoption and recovery to the same descriptors across an ancestor swap", async () => {
    vi.stubEnv("PICKFORGE_STORAGE_MODE", "home");
    const run = await seed();
    const state = path.dirname(path.dirname(run.dir));
    await fs.promises.rename(path.join(state, "layout.json"), path.join(root, "saved-layout"));
    const outside = path.join(root, "outside");
    await fs.promises.mkdir(outside);
    const original = DirHandle.prototype.linkChild;
    vi.spyOn(DirHandle.prototype, "linkChild").mockImplementation(async function (this: DirHandle, source, target) {
      await fs.promises.rename(state, `${state}-saved`);
      await fs.promises.symlink(outside, state);
      return original.call(this, source, target);
    });
    expect((await finalizeOrphanedEvidenceRuns(project)).sessions).toHaveLength(1);
    expect(await fs.promises.readdir(outside)).toEqual([]);
    expect(await fs.promises.readFile(path.join(`${state}-saved`, "layout.json"), "utf8")).toBe(layoutMarkerContent());
    expect((await manifest(path.join(`${state}-saved`, "runs", run.runId))).status).toBe("orphaned");
  });

  it("propagates manifest I/O failures rather than silently skipping runs", async () => {
    await seed();
    const original = DirHandle.prototype.openFile;
    vi.spyOn(DirHandle.prototype, "openFile").mockImplementation(function (this: DirHandle, name, flags, mode) {
      if (name === "manifest.json") return Promise.reject(Object.assign(new Error("read failed"), { code: "EIO" }));
      return original.call(this, name, flags, mode);
    });
    await expect(finalizeOrphanedEvidenceRuns(project)).rejects.toThrow("read failed");
  });

  it("does not claim an unmarked shared state when the runs root is absent", async () => {
    vi.stubEnv("PICKFORGE_STORAGE_MODE", "home");
    expect(await finalizeOrphanedEvidenceRuns(project)).toEqual({ sessions: [], skipped: [] });
    expect(fs.existsSync(path.join(root, "home"))).toBe(false);
    const run = await seed();
    const state = path.dirname(path.dirname(run.dir));
    await fs.promises.rename(path.join(state, "layout.json"), path.join(root, "saved-layout"));
    await fs.promises.rename(path.dirname(run.dir), path.join(root, "saved-runs"));
    expect(await finalizeOrphanedEvidenceRuns(project)).toEqual({ sessions: [], skipped: [] });
    expect(await fs.promises.readdir(state)).toEqual([]);
  });

  it.each(["fifo", "symlink", "hardlink", "directory"])("skips unsafe %s pointer targets without blocking or rewriting", async (kind) => {
    const older = await seed();
    const latest = await seed();
    const target = path.join(latest.dir, "manifest.json");
    const saved = path.join(root, "saved-manifest");
    await fs.promises.rename(target, saved);
    if (kind === "fifo") expect(spawnSync("mkfifo", [target]).status).toBe(0);
    if (kind === "symlink") await fs.promises.symlink(saved, target);
    if (kind === "hardlink") await fs.promises.link(saved, target);
    if (kind === "directory") await fs.promises.mkdir(target);
    const before = await fs.promises.readFile(saved);
    const pointer = await activePointerPath(project, "brow-synthetic");
    const pointerBefore = await fs.promises.readFile(pointer);
    const result = await subprocess("recover");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).sessions).toEqual([]);
    expect(JSON.parse(result.stdout).skipped).toEqual([
      ...skipped(older.runId),
      ...skipped(latest.runId, "invalid evidence manifest"),
    ]);
    expect((await manifest(older.dir)).status).toBe("running");
    expect(await fs.promises.readFile(saved)).toEqual(before);
    expect(await fs.promises.readFile(pointer)).toEqual(pointerBefore);
  });

  it.each(["fifo", "symlink", "hardlink", "directory"])("skips unsafe %s pointers without reading outside the root", async (kind) => {
    const run = await seed();
    const pointer = await activePointerPath(project, "brow-synthetic");
    const saved = path.join(root, "saved-pointer");
    await fs.promises.rename(pointer, saved);
    if (kind === "fifo") expect(spawnSync("mkfifo", [pointer]).status).toBe(0);
    if (kind === "symlink") await fs.promises.symlink(saved, pointer);
    if (kind === "hardlink") await fs.promises.link(saved, pointer);
    if (kind === "directory") await fs.promises.mkdir(pointer);
    const before = await fs.promises.readFile(saved);
    const result = await subprocess("recover");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ sessions: [], skipped: skipped(run.runId) });
    expect(await fs.promises.readFile(saved)).toEqual(before);
    expect((await manifest(run.dir)).status).toBe("running");
  });

  it.each([
    { actionId: "bad", artifacts: [1] },
    { ...action, artifacts: [null] },
    { ...action, startedAt: 1 },
    { actionId: "bad", evidenceTruncated: true },
  ])("publishes an unavailable timeline for malformed records %j", async (record) => {
    const run = await seed();
    const journal = path.join(run.dir, "actions.jsonl");
    const bytes = `${JSON.stringify(record)}\n`;
    await fs.promises.writeFile(journal, bytes);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await finalizeOrphanedEvidenceRuns(project);
      expect(result.sessions[0]!.runs[0]).toMatchObject({ journal: "corrupt", actions: 0 });
      expect(await fs.promises.readFile(result.sessions[0]!.index, "utf8")).toContain("journal corrupt");
      expect((await manifest(run.dir)).evidenceRecovery).toBe("corrupt");
      expect(await fs.promises.readFile(path.join(run.dir, "report.html"), "utf8")).toContain("Timeline unavailable");
      expect(await fs.promises.readFile(journal, "utf8")).toBe(bytes);
    }
  });

  it.each([null, 1, {}, { path: 1 }, { type: "unknown", name: "x", path: "x", createdAt: "now" }])("skips an unidentifiable manifest inventory %j with a reason", async (artifact) => {
    const run = await seed();
    const file = path.join(run.dir, "manifest.json");
    const bytes = JSON.stringify({ ...await manifest(run.dir), artifacts: [artifact] });
    await fs.promises.writeFile(file, bytes);
    expect(await finalizeOrphanedEvidenceRuns(project)).toEqual({
      sessions: [], skipped: skipped(run.runId, "invalid evidence manifest"),
    });
    expect(await fs.promises.readFile(file, "utf8")).toBe(bytes);
    expect(fs.existsSync(path.join(run.dir, "report.html"))).toBe(false);
  });

  it("skips a manifest that turns invalid between inspection and finalization", async () => {
    const run = await seed();
    const file = path.join(run.dir, "manifest.json");
    const bytes = await fs.promises.readFile(file, "utf8");
    const twin = path.join(root, "manifest-twin.json");
    const openFile = DirHandle.prototype.openFile;
    let swapped = false;
    vi.spyOn(DirHandle.prototype, "openFile").mockImplementation(async function (
      this: DirHandle,
      name: string,
      flags: number | string,
      mode?: number,
    ) {
      // The journal lock is taken after inspection and before the manifest is
      // re-read, so swap in a hard-linked manifest exactly in that window.
      if (!swapped && name === ".evidence-journal.lock") {
        swapped = true;
        await fs.promises.writeFile(twin, bytes);
        await fs.promises.rm(file);
        await fs.promises.link(twin, file);
      }
      return openFile.call(this, name, flags, mode);
    });
    expect(await finalizeOrphanedEvidenceRuns(project)).toEqual({
      sessions: [], skipped: skipped(run.runId, "invalid evidence manifest"),
    });
    expect(swapped).toBe(true);
    expect(fs.existsSync(path.join(run.dir, "report.html"))).toBe(false);
  });

  it("indexes short-lived CLI/MCP owners together without changing any journal or run directory", async () => {
    const runs = [await seed("write", "cli"), await seed("write", "mcp"), await seed("write", "relay")];
    const journals = await Promise.all(runs.map((run) => fs.promises.readFile(path.join(run.dir, "actions.jsonl"))));
    const identities = await Promise.all(runs.map((run) => fs.promises.stat(run.dir)));
    const first = await finalizeOrphanedEvidenceRuns(project);
    expect(first.skipped).toEqual([]);
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]!.runs.map((run) => run.runId).sort()).toEqual(runs.map((run) => run.runId).sort());
    const index = await fs.promises.readFile(first.sessions[0]!.index, "utf8");
    for (const [i, run] of runs.entries()) {
      expect(index).toContain(`${run.runId}/report.html`);
      expect((await fs.promises.stat(run.dir)).ino).toBe(identities[i]!.ino);
      expect(await fs.promises.readFile(path.join(run.dir, "actions.jsonl"))).toEqual(journals[i]);
      const summary = await manifest(run.dir);
      expect(summary.status).toBe("orphaned");
      expect(summary.artifacts.map((artifact) => artifact.type).sort()).toEqual(["log", "report", "screenshot"]);
      const html = await fs.promises.readFile(path.join(run.dir, "report.html"), "utf8");
      expect(html).toContain("orphaned");
      expect(html).toContain("synthetic_action");
    }
    expect(await finalizeOrphanedEvidenceRuns(project)).toEqual(first);
    expect(await fs.promises.readFile(first.sessions[0]!.index, "utf8")).toBe(index);
  });

  it("preserves a SIGKILL-torn tail and reports only committed records", async () => {
    const run = await seed("torn");
    const before = await fs.promises.readFile(path.join(run.dir, "actions.jsonl"));
    const result = await finalizeOrphanedEvidenceRuns(project);
    expect(result.sessions[0]!.runs[0]).toMatchObject({ journal: "torn-tail", actions: 1, status: "orphaned" });
    expect(await fs.promises.readFile(path.join(run.dir, "actions.jsonl"))).toEqual(before);
    expect(await fs.promises.readFile(path.join(run.dir, "report.html"), "utf8")).toContain("Interrupted final journal line");
  });

  it("recovers a finalizer killed after report publication, including its dead journal lock", async () => {
    const run = await seed();
    const before = await fs.promises.readFile(path.join(run.dir, "actions.jsonl"));
    expect((await subprocess("crash-report")).signal).toBe("SIGKILL");
    expect((await manifest(run.dir)).status).toBe("orphaned");
    const result = await subprocess("recover");
    expect(result.code).toBe(0);
    expect((await manifest(run.dir)).artifacts.map((artifact) => artifact.path)).toContain("report.html");
    expect(await fs.promises.readFile(path.join(run.dir, "actions.jsonl"))).toEqual(before);
  });

  // A recovery process classifies a run's manifest before it takes that run's
  // journal lock. A peer that wins the lock replaces manifest.json by rename,
  // so the loser's already-open descriptor points at an unlinked inode and the
  // run is reported as "invalid evidence manifest". That is a legal
  // serialization of two concurrent recoveries, not disagreement, so the fixed
  // outcome is the recovered state rather than each process's own view of it:
  // whoever recovered the run recovered exactly the same run, and the run ends
  // up recovered once, with one index and no duplicated artifacts.
  it("serializes concurrent recovery processes to the same reports and index", async () => {
    const run = await seed();
    const runsRoot = path.dirname(run.dir);
    const results = await Promise.all(Array.from({ length: 4 }, () => subprocess("recover")));
    const outcomes = results.map((result) => {
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout) as EvidenceRecoveryResult;
    });
    const recovered = outcomes.filter((outcome) => outcome.sessions.length > 0);
    expect(recovered.length).toBeGreaterThan(0);
    for (const outcome of recovered) {
      expect(outcome).toEqual({
        sessions: [{
          sessionId: "brow-synthetic",
          index: path.join(runsRoot, "session-brow-synthetic.html"),
          runs: [{ runId: run.runId, status: "orphaned", actions: 1, journal: "complete" }],
        }],
        skipped: [],
      });
    }
    for (const outcome of outcomes.filter((candidate) => candidate.sessions.length === 0)) {
      expect(outcome.skipped).toEqual(skipped(run.runId, "invalid evidence manifest"));
    }
    expect((await manifest(run.dir)).artifacts).toHaveLength(3);
    expect((await fs.promises.readdir(runsRoot)).filter((name) => name.startsWith("session-")))
      .toEqual(["session-brow-synthetic.html"]);
  });

  it("skips a live owner process, then recovers after it is killed", async () => {
    const child = spawn("bun", [worker, project, "hold"], { stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close");
    try {
      const [chunk] = await once(child.stdout, "data");
      const run = JSON.parse(String(chunk)) as { runId: string; dir: string };
      expect(await finalizeOrphanedEvidenceRuns(project)).toEqual({ sessions: [], skipped: skipped(run.runId) });
      expect((await manifest(run.dir)).status).toBe("running");
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
    expect((await finalizeOrphanedEvidenceRuns(project)).sessions).toHaveLength(1);
  });

  it("skips recovery and still allows appends when a live owner's /proc/stat cannot be read", async () => {
    const { run } = await beginEvidenceRun(project, "brow-statfail");
    await appendAction(run, action);
    const original = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((target, ...rest) => {
      if (String(target) === `/proc/${process.pid}/stat`) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      return original.call(fs, target, ...rest);
    }) as typeof fs.readFileSync);
    expect(await finalizeOrphanedEvidenceRuns(project)).toEqual({
      sessions: [], skipped: skipped(run.runId),
    });
    expect((await manifest(run.dir)).status).toBe("running");
    await expect(appendAction(run, action)).resolves.toMatchObject({ outcome: "appended" });
  });

  it("skips a run that disappears between listing and open", async () => {
    const run = await seed();
    const original = DirHandle.prototype.openChild;
    vi.spyOn(DirHandle.prototype, "openChild").mockImplementation(async function (this: DirHandle, name) {
      if (name === run.runId) {
        throw new RunStorageAccessError(
          `Run storage path disappeared while being verified: ${path.join(this.dir, name)}`,
        );
      }
      return original.call(this, name);
    });
    expect(await finalizeOrphanedEvidenceRuns(project)).toEqual({
      sessions: [], skipped: skipped(run.runId, "run disappeared"),
    });
  });

  it("refuses stale adopter appends after recovery and allows a fresh run", async () => {
    const { run } = await beginEvidenceRun(project, "brow-stale");
    await appendAction(run, action);
    const pointer = await activePointerPath(project, "brow-stale");
    const raw = JSON.parse(await fs.promises.readFile(pointer, "utf8")) as Record<string, unknown>;
    await fs.promises.writeFile(pointer, JSON.stringify({ ...raw, ownerStartTicks: -1 }));
    await finalizeOrphanedEvidenceRuns(project);
    await expect(appendAction(run, action)).rejects.toThrow(/orphaned/);
    const next = await beginEvidenceRun(project, "brow-stale");
    expect(next.run.runId).not.toBe(run.runId);
    await expect(appendAction(next.run, action)).resolves.toMatchObject({ outcome: "appended" });
  });

  it("marks a missing journal honestly without fabricating a timeline", async () => {
    const run = await seed();
    const journal = path.join(run.dir, "actions.jsonl");
    await fs.promises.rename(journal, path.join(run.dir, "saved.jsonl"));
    const result = await finalizeOrphanedEvidenceRuns(project);
    expect(result.sessions[0]!.runs[0]).toMatchObject({ journal: "missing", actions: 0 });
    expect((await manifest(run.dir)).evidenceRecovery).toBe("missing");
    expect(await fs.promises.readFile(path.join(run.dir, "report.html"), "utf8")).toContain("Timeline unavailable");
  });

  it("finalizes the valid prefix when a later journal line is truncated", async () => {
    const run = await seed();
    const journal = path.join(run.dir, "actions.jsonl");
    const before = await fs.promises.readFile(journal, "utf8");
    const truncated = '{"actionId":"truncated\n';
    await fs.promises.appendFile(journal, truncated);
    const result = await finalizeOrphanedEvidenceRuns(project);
    expect(result.sessions[0]!.runs[0]).toMatchObject({
      journal: "corrupt", actions: 1, warning: "journal corrupt after record 1",
    });
    expect(await fs.promises.readFile(journal, "utf8")).toBe(before + truncated);
    expect((await manifest(run.dir)).evidenceRecovery).toBe("corrupt");
    const html = await fs.promises.readFile(path.join(run.dir, "report.html"), "utf8");
    expect(html).toContain("journal corrupt after record 1");
    expect(html).toContain("synthetic_action");
    expect(html).not.toContain("Timeline unavailable");
  });

  it("does not rewrite foreign runs or read-only legacy roots", async () => {
    const legacy = await seed();
    const foreign = await createRun(project, "foreign");
    const before = await fs.promises.readFile(path.join(foreign.dir, "manifest.json"));
    const foreignOnly = await finalizeOrphanedEvidenceRuns(project);
    expect(foreignOnly.sessions.flatMap((session) => session.runs).map((run) => run.runId)).not.toContain(foreign.runId);
    const legacyBefore = await fs.promises.readFile(path.join(legacy.dir, "manifest.json"));
    vi.stubEnv("PICKFORGE_STORAGE_MODE", "home");
    expect(await finalizeOrphanedEvidenceRuns(project)).toEqual({ sessions: [], skipped: [] });
    expect(await fs.promises.readFile(path.join(legacy.dir, "manifest.json"))).toEqual(legacyBefore);
    expect(await fs.promises.readFile(path.join(foreign.dir, "manifest.json"))).toEqual(before);
  });

  it("reconciles already completed reports without changing the outcome", async () => {
    const run = await seed();
    const summary = await manifest(run.dir);
    summary.status = "completed";
    await fs.promises.writeFile(path.join(run.dir, "manifest.json"), JSON.stringify(summary));
    await finalizeOrphanedEvidenceRuns(project);
    expect((await manifest(run.dir)).status).toBe("completed");
    expect((await manifest(run.dir)).artifacts).toHaveLength(3);
  });

  it("indexes completed runs with a report without rewriting or skipping them", async () => {
    const run = await seed();
    const summary = await manifest(run.dir);
    summary.status = "completed";
    const bytes = `${JSON.stringify(summary)}\n`;
    await fs.promises.writeFile(path.join(run.dir, "manifest.json"), bytes);
    await fs.promises.writeFile(path.join(run.dir, "report.html"), "<html>kept</html>");
    const result = await finalizeOrphanedEvidenceRuns(project);
    expect(result.skipped).toEqual([]);
    expect(result.sessions[0]!.runs[0]).toMatchObject({ runId: run.runId, status: "completed" });
    expect(await fs.promises.readFile(path.join(run.dir, "manifest.json"), "utf8")).toBe(bytes);
    expect(await fs.promises.readFile(path.join(run.dir, "report.html"), "utf8")).toBe("<html>kept</html>");
    expect(summary.evidenceRecovery).toBeUndefined();
  });

  it.each(["corrupt", "empty", "live-claim"])("skips an ambiguous %s session pointer", async (kind) => {
    const run = await seed();
    const pointer = await activePointerPath(project, "brow-synthetic");
    const content = kind === "live-claim"
      ? JSON.stringify({ evidenceVersion: 1, claim: true, sessionId: "brow-synthetic", ownerPid: process.pid, claimedAt: "2026-09-05" })
      : kind === "empty" ? "" : "not-json";
    await fs.promises.writeFile(pointer, content);
    expect(await finalizeOrphanedEvidenceRuns(project)).toEqual({ sessions: [], skipped: skipped(run.runId) });
    expect((await manifest(run.dir)).status).toBe("running");
  });

  it("recovers a dead creation claim without clearing or rewriting it", async () => {
    const run = await seed();
    const pointer = await activePointerPath(project, "brow-synthetic");
    const content = JSON.stringify({ evidenceVersion: 1, claim: true, sessionId: "brow-synthetic", ownerPid: process.pid, ownerStartTicks: -1, claimedAt: "2026-09-05" });
    await fs.promises.writeFile(pointer, content);
    expect((await finalizeOrphanedEvidenceRuns(project)).sessions).toHaveLength(1);
    expect((await manifest(run.dir)).status).toBe("orphaned");
    expect(await fs.promises.readFile(pointer, "utf8")).toBe(content);
  });

  it("does not follow journal, artifact, report or index symlinks", async () => {
    const run = await seed();
    const outside = path.join(root, "outside");
    await fs.promises.writeFile(outside, "private-outside");
    await fs.promises.rename(path.join(run.dir, "actions.jsonl"), path.join(run.dir, "saved.jsonl"));
    await fs.promises.symlink(outside, path.join(run.dir, "actions.jsonl"));
    await fs.promises.symlink(outside, path.join(run.dir, "report.html"));
    await fs.promises.symlink(outside, path.join(path.dirname(run.dir), "session-brow-synthetic.html"));
    const result = await finalizeOrphanedEvidenceRuns(project);
    expect(result.sessions[0]!.runs[0]!.journal).toBe("corrupt");
    expect((await manifest(run.dir)).artifacts.map((artifact) => artifact.path)).toEqual(["report.html"]);
    expect(await fs.promises.readFile(outside, "utf8")).toBe("private-outside");
    expect(await fs.promises.readFile(path.join(run.dir, "report.html"), "utf8")).not.toContain("private-outside");
  });

  it("refuses an unsafe primary root without writing through it", async () => {
    await seed();
    const picklab = path.join(project, ".picklab");
    await fs.promises.rename(picklab, `${picklab}-saved`);
    await fs.promises.symlink(`${picklab}-saved`, picklab);
    await expect(finalizeOrphanedEvidenceRuns(project)).rejects.toThrow(/symlink/);
    expect(await fs.promises.readdir(path.join(`${picklab}-saved`, "runs"))).not.toContain("session-brow-synthetic.html");
  });

  it("never redirects recovery writes when an ancestor is swapped during publication", async () => {
    const run = await seed();
    const outside = path.join(root, "outside");
    await fs.promises.mkdir(outside);
    const original = DirHandle.prototype.writeFileAtomic;
    let moved = false;
    vi.spyOn(DirHandle.prototype, "writeFileAtomic").mockImplementation(async function (this: DirHandle, name, content) {
      if (!moved && name === "report.html") {
        moved = true;
        await fs.promises.rename(path.join(project, ".picklab"), path.join(project, ".picklab-saved"));
        await fs.promises.symlink(outside, path.join(project, ".picklab"));
      }
      return original.call(this, name, content);
    });
    await finalizeOrphanedEvidenceRuns(project);
    expect(moved).toBe(true);
    expect(await fs.promises.readdir(outside)).toEqual([]);
    const saved = path.join(project, ".picklab-saved", "runs");
    expect((await manifest(path.join(saved, run.runId))).status).toBe("orphaned");
    expect(await fs.promises.readFile(path.join(saved, "session-brow-synthetic.html"), "utf8")).toContain(run.runId);
  });
});
