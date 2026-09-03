import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunCatalog,
  createRun,
  openRunCatalog,
  projectId,
  type RunManifest,
} from "../src/index.js";

let root: string;

// These tests build `RunCatalog` roots directly, or exercise `createRun` +
// `openRunCatalog` against the literal `.picklab/runs` layout, so they pin
// storage to `project-local`. Home-mode default resolution and the
// home-primary + legacy-project-local layering are covered below in
// "openRunCatalog storage modes".
beforeEach(async () => {
  root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pickforge-lab-run-catalog-"),
  );
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function writeRun(
  runsRoot: string,
  runId: string,
  overrides: Partial<RunManifest> = {},
): Promise<string> {
  const runDir = path.join(runsRoot, runId);
  await fs.promises.mkdir(runDir, { recursive: true });
  const manifest: RunManifest = {
    runId,
    slug: runId,
    createdAt: "2026-06-09T12:00:00.000Z",
    status: "completed",
    artifacts: [],
    ...overrides,
  };
  await fs.promises.writeFile(
    path.join(runDir, "manifest.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  return runDir;
}

describe("RunCatalog", () => {
  it("uses root precedence for duplicate ids and deterministic tie ordering", async () => {
    const primary = path.join(root, "primary");
    const fallback = path.join(root, "fallback");
    await writeRun(primary, "same", { slug: "primary" });
    await writeRun(fallback, "same", { slug: "fallback" });
    await writeRun(fallback, "z-run");
    await writeRun(fallback, "a-run");
    await writeRun(fallback, "B-run");

    const catalog = new RunCatalog([
      { dir: primary, expectedRealDir: primary },
      { dir: fallback, expectedRealDir: fallback },
    ]);
    const entries = await catalog.list();

    expect(entries.map((entry) => entry.manifest.runId)).toEqual([
      "B-run",
      "a-run",
      "same",
      "z-run",
    ]);
    expect(entries.find((entry) => entry.dirName === "same")?.manifest.slug).toBe(
      "primary",
    );
  });

  it("fails closed when a manifest run id differs from its directory", async () => {
    const project = path.join(root, "project");
    await fs.promises.mkdir(project);
    const run = await createRun(project, "mismatch");
    const manifestPath = path.join(run.dir, "manifest.json");
    const manifest = JSON.parse(
      await fs.promises.readFile(manifestPath, "utf8"),
    ) as RunManifest;
    manifest.runId = "different-run";
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest));

    expect(await (await openRunCatalog(project)).list()).toEqual([]);
  });

  it("rejects a real directory replacement after discovery", async () => {
    const project = path.join(root, "project");
    await fs.promises.mkdir(project);
    const run = await createRun(project, "replace", { evidence: true });
    const catalog = await openRunCatalog(project);
    const entry = await catalog.find(run.runId);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("expected catalog entry");

    await fs.promises.rename(run.dir, `${run.dir}-original`);
    await writeRun(path.dirname(run.dir), path.basename(run.dir), {
      evidenceVersion: 1,
      actionLog: "actions.jsonl",
    });
    await fs.promises.writeFile(
      path.join(run.dir, "actions.jsonl"),
      '{"actionId":"replacement"}\n',
    );

    await expect(catalog.readRootText(entry, "actions.jsonl")).rejects.toThrow(
      /not found|changed/i,
    );
  });

  it("does not classify a replacement directory's missing file as absent", async () => {
    const project = path.join(root, "project");
    await fs.promises.mkdir(project);
    const run = await createRun(project, "replace-missing", { evidence: true });
    const catalog = await openRunCatalog(project);
    const entry = await catalog.find(run.runId);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("expected catalog entry");

    const replacement = path.join(root, "replacement-run");
    await writeRun(path.dirname(replacement), path.basename(replacement), {
      runId: run.runId,
      evidenceVersion: 1,
      actionLog: "actions.jsonl",
    });
    const target = path.join(run.dir, "actions.jsonl");
    const realLstat = fs.promises.lstat.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, "lstat").mockImplementation(async (...args) => {
      if (!swapped && path.resolve(String(args[0])) === target) {
        swapped = true;
        await fs.promises.rename(run.dir, `${run.dir}-original`);
        await fs.promises.rename(replacement, run.dir);
      }
      return realLstat(...args);
    });

    await expect(
      catalog.readRootTextIfPresent(entry, "actions.jsonl"),
    ).rejects.toThrow(/changed|open/i);
    expect(swapped).toBe(true);
  });

  it("distinguishes a missing root file from an unsafe symlink", async () => {
    const project = path.join(root, "project");
    await fs.promises.mkdir(project);
    const run = await createRun(project, "optional");
    const catalog = await openRunCatalog(project);
    const entry = await catalog.find(run.runId);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("expected catalog entry");

    expect(await catalog.readRootTextIfPresent(entry, "actions.jsonl")).toBeUndefined();
    await fs.promises.symlink(
      path.join(run.dir, "manifest.json"),
      path.join(run.dir, "actions.jsonl"),
    );
    await expect(
      catalog.readRootTextIfPresent(entry, "actions.jsonl"),
    ).rejects.toThrow(/unsafe/i);
  });

  it("rejects a run-directory swap while reading a verified root file", async () => {
    const project = path.join(root, "project");
    await fs.promises.mkdir(project);
    const run = await createRun(project, "swap", { evidence: true });
    await fs.promises.writeFile(
      path.join(run.dir, "actions.jsonl"),
      '{"actionId":"safe"}\n',
    );
    const catalog = await openRunCatalog(project);
    const entry = await catalog.find(run.runId);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("expected catalog entry");

    const backup = `${run.dir}-backup`;
    const outsideRun = path.join(root, "outside-run");
    await writeRun(path.dirname(outsideRun), path.basename(outsideRun), {
      runId: run.runId,
    });
    await fs.promises.writeFile(
      path.join(outsideRun, "actions.jsonl"),
      '{"actionId":"outside"}\n',
    );

    const target = path.join(run.dir, "actions.jsonl");
    const realOpen = fs.promises.open.bind(fs.promises);
    let swapped = false;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (!swapped && path.resolve(String(args[0])) === target) {
        swapped = true;
        await fs.promises.rename(run.dir, backup);
        await fs.promises.symlink(outsideRun, run.dir);
      }
      return realOpen(...args);
    });

    await expect(catalog.readRootText(entry, "actions.jsonl")).rejects.toThrow(
      /changed|not found/i,
    );
    expect(swapped).toBe(true);
  });

  it("never follows a symlinked catalog root", async () => {
    const realRoot = path.join(root, "real-runs");
    const linkedRoot = path.join(root, "linked-runs");
    await writeRun(realRoot, "hidden");
    await fs.promises.symlink(realRoot, linkedRoot);

    const catalog = new RunCatalog([
      { dir: linkedRoot, expectedRealDir: realRoot },
    ]);
    expect(await catalog.list()).toEqual([]);
  });
});

describe("openRunCatalog storage modes", () => {
  // These tests set env explicitly per call (not via the file-level
  // PICKFORGE_STORAGE_MODE stub) so they exercise the real "home" default.
  it("defaults new runs under the home root, isolated per project, with no files in the project dir", async () => {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });
    const env = { PICKFORGE_HOME: home };

    const run = await createRun(project, "smoke", {}, env);

    expect(run.dir.startsWith(path.join(home, "projects"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".picklab"))).toBe(false);

    const entries = await (await openRunCatalog(project, env)).list();
    expect(entries.map((entry) => entry.manifest.runId)).toEqual([run.runId]);
  });

  it("reads runs from ~/.pickforge/picklab while writing under ~/.pickforge/lab", async () => {
    const fakeHome = path.join(root, "user-home");
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    const id = await projectId(project);
    const legacyRoot = path.join(
      fakeHome,
      ".pickforge",
      "picklab",
      "projects",
      id,
      "runs",
    );
    await writeRun(legacyRoot, "legacy-home-run");

    const newRun = await createRun(project, "fresh", {}, {});
    const entries = await (await openRunCatalog(project, {})).list();

    expect(newRun.dir).toContain(path.join(".pickforge", "lab", "projects"));
    expect(entries.map((entry) => entry.manifest.runId).sort()).toEqual(
      ["legacy-home-run", newRun.runId].sort(),
    );
    expect(fs.existsSync(path.join(legacyRoot, "legacy-home-run"))).toBe(true);
  });

  it("keeps pre-existing project-local runs discoverable without migration", async () => {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });
    const env = { PICKFORGE_HOME: home };
    const legacyRoot = path.join(project, ".picklab", "runs");
    await writeRun(legacyRoot, "legacy-run");

    const newRun = await createRun(project, "fresh", {}, env);

    const entries = await (await openRunCatalog(project, env)).list();
    const ids = entries.map((entry) => entry.manifest.runId).sort();
    expect(ids).toEqual(["legacy-run", newRun.runId].sort());
    // Legacy data was only read, never written or moved.
    expect(fs.existsSync(path.join(legacyRoot, "legacy-run"))).toBe(true);
  });

  it("keeps two different project paths fully isolated under the same home", async () => {
    const home = path.join(root, "home");
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    await fs.promises.mkdir(projectA, { recursive: true });
    await fs.promises.mkdir(projectB, { recursive: true });
    const env = { PICKFORGE_HOME: home };

    const runA = await createRun(projectA, "a-run", {}, env);
    const runB = await createRun(projectB, "b-run", {}, env);

    expect(runA.dir).not.toBe(runB.dir);
    const entriesA = await (await openRunCatalog(projectA, env)).list();
    const entriesB = await (await openRunCatalog(projectB, env)).list();
    expect(entriesA.map((e) => e.manifest.runId)).toEqual([runA.runId]);
    expect(entriesB.map((e) => e.manifest.runId)).toEqual([runB.runId]);
  });

  it("restores the project-local layout when explicitly configured", async () => {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });
    const env = { PICKFORGE_HOME: home, PICKFORGE_STORAGE_MODE: "project-local" };

    const run = await createRun(project, "local", {}, env);

    expect(run.dir).toBe(
      path.join(project, ".picklab", "runs", run.runId),
    );
    expect(fs.existsSync(home)).toBe(false);
  });

  it("rejects custom mode without a path", async () => {
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });
    await expect(
      createRun(project, "x", {}, { PICKFORGE_STORAGE_MODE: "custom" }),
    ).rejects.toThrow(/storage path/i);
  });

  it("rejects custom mode with a relative path", async () => {
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });
    await expect(
      createRun(project, "x", {}, {
        PICKFORGE_STORAGE_MODE: "custom",
        PICKFORGE_STORAGE_PATH: "relative/artifacts",
      }),
    ).rejects.toThrow(/absolute/i);
  });

  it("writes under an explicit custom path", async () => {
    const project = path.join(root, "project");
    const custom = path.join(root, "custom-artifacts");
    await fs.promises.mkdir(project, { recursive: true });
    const env = {
      PICKFORGE_STORAGE_MODE: "custom",
      PICKFORGE_STORAGE_PATH: custom,
    };

    const run = await createRun(project, "x", {}, env);

    expect(run.dir).toBe(path.join(custom, "runs", run.runId));
    const entries = await (await openRunCatalog(project, env)).list();
    expect(entries.map((e) => e.manifest.runId)).toEqual([run.runId]);
  });
});
