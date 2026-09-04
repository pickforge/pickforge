import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beginEvidenceRun } from "../src/evidence.js";
import { adoptRun, createRun, listRuns } from "../src/run.js";
import {
  ensureVerifiedRunsRoot,
  RunStorageAccessError,
} from "../src/run-root.js";
import { projectId } from "../src/storage.js";

// Adversarial coverage for #54: run-storage writes must apply the same
// lstat/realpath trust boundary as the catalog's reads, fail closed, and never
// migrate or delete anything that is already on disk.

let root: string;
let project: string;
let outside: string;

async function tree(dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { recursive: true });
  return entries.map(String).sort();
}

async function isSymlinkTo(link: string, target: string): Promise<boolean> {
  const stat = await fs.promises.lstat(link);
  return stat.isSymbolicLink() && (await fs.promises.readlink(link)) === target;
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-run-root-"));
  project = path.join(root, "project");
  outside = path.join(root, "outside");
  await fs.promises.mkdir(project);
  await fs.promises.mkdir(outside);
  vi.stubEnv("PICKFORGE_HOME", path.join(root, "home"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe("project-local write root", () => {
  it("refuses a committed .picklab symlink pointing outside the project", async () => {
    const link = path.join(project, ".picklab");
    await fs.promises.symlink(outside, link);

    await expect(createRun(project, "smoke")).rejects.toBeInstanceOf(
      RunStorageAccessError,
    );
    await expect(createRun(project, "smoke")).rejects.toThrow(/symlink/);

    expect(await tree(outside)).toEqual([]);
    expect(await isSymlinkTo(link, outside)).toBe(true);
    expect(await listRuns(project)).toEqual([]);
  });

  it("refuses a symlinked .picklab/runs even when it points inside the project", async () => {
    const elsewhere = path.join(project, "elsewhere");
    await fs.promises.mkdir(path.join(project, ".picklab"));
    await fs.promises.mkdir(elsewhere);
    const link = path.join(project, ".picklab", "runs");
    await fs.promises.symlink(elsewhere, link);

    await expect(createRun(project, "smoke")).rejects.toBeInstanceOf(
      RunStorageAccessError,
    );
    expect(await tree(elsewhere)).toEqual([]);
    expect(await isSymlinkTo(link, elsewhere)).toBe(true);
  });

  it("refuses a dangling .picklab symlink instead of creating its target", async () => {
    const nowhere = path.join(root, "nowhere");
    const link = path.join(project, ".picklab");
    await fs.promises.symlink(nowhere, link);

    await expect(createRun(project, "smoke")).rejects.toBeInstanceOf(
      RunStorageAccessError,
    );
    expect(fs.existsSync(nowhere)).toBe(false);
    expect(await isSymlinkTo(link, nowhere)).toBe(true);
  });

  it("refuses a .picklab that is a regular file and leaves it alone", async () => {
    const file = path.join(project, ".picklab");
    await fs.promises.writeFile(file, "not a directory\n");

    await expect(createRun(project, "smoke")).rejects.toThrow(/not a directory/);
    expect(await fs.promises.readFile(file, "utf8")).toBe("not a directory\n");
  });

  it("refuses a missing project directory instead of creating it", async () => {
    const missing = path.join(root, "missing-project");
    await expect(createRun(missing, "smoke")).rejects.toBeInstanceOf(
      RunStorageAccessError,
    );
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("accepts a project reached through a symlink and agrees with the catalog", async () => {
    const link = path.join(root, "project-link");
    await fs.promises.symlink(project, link);

    const run = await createRun(link, "ok");
    const realRun = await fs.promises.realpath(run.dir);
    expect(realRun.startsWith(await fs.promises.realpath(project))).toBe(true);
    expect((await listRuns(link)).map((r) => r.slug)).toEqual(["ok"]);
    expect((await listRuns(project)).map((r) => r.slug)).toEqual(["ok"]);
  });

  it("creates a plain layout in the real .picklab/runs and is idempotent", async () => {
    const first = await ensureVerifiedRunsRoot(project);
    const second = await ensureVerifiedRunsRoot(project);
    expect(first.dir).toBe(path.join(project, ".picklab", "runs"));
    expect(second.realDir).toBe(first.realDir);
    expect(second.stat.ino).toBe(first.stat.ino);
    const run = await createRun(project, "layout");
    expect(await tree(run.dir)).toEqual(["logs", "manifest.json", "screenshots"]);
  });

  it("creates the run in the verified root even when the root is swapped mid-creation", async () => {
    const runsRoot = path.join(project, ".picklab", "runs");
    await fs.promises.mkdir(runsRoot, { recursive: true });
    const moved = path.join(project, ".picklab", "runs-real");
    const original = fs.promises.mkdir;
    let swapped = false;
    vi.spyOn(fs.promises, "mkdir").mockImplementation(
      async (target, options) => {
        if (
          !swapped &&
          typeof target === "string" &&
          target.startsWith("/proc/self/fd/") &&
          path.basename(target).endsWith("-race")
        ) {
          // The root was verified a moment ago and the run directory is being
          // created inside it right now: redirect the pathname underneath.
          swapped = true;
          await fs.promises.rename(runsRoot, moved);
          await fs.promises.symlink(outside, runsRoot);
        }
        return original.call(fs.promises, target, options as never);
      },
    );

    const run = await createRun(project, "race");
    expect(swapped).toBe(true);
    expect(await isSymlinkTo(runsRoot, outside)).toBe(true);
    // Every write followed the descriptor of the directory that was verified,
    // so nothing landed through the planted symlink.
    expect(await tree(outside)).toEqual([]);
    const realRunDir = path.join(moved, path.basename(run.dir));
    expect(await tree(realRunDir)).toEqual([
      "logs",
      "manifest.json",
      "screenshots",
    ]);
  });

  it("refuses manifest writes after the run directory is swapped for a symlink", async () => {
    const run = await createRun(project, "swap");
    const stolen = path.join(root, "stolen");
    await fs.promises.rename(run.dir, stolen);
    await fs.promises.symlink(outside, run.dir);

    await expect(run.setStatus("completed")).rejects.toBeInstanceOf(
      RunStorageAccessError,
    );
    expect(await tree(outside)).toEqual([]);
    await expect(
      run.addArtifact("log", "app", path.join("logs", "app.log")),
    ).rejects.toBeInstanceOf(RunStorageAccessError);
    expect(await tree(outside)).toEqual([]);
    expect(await isSymlinkTo(run.dir, outside)).toBe(true);
  });

  it("refuses manifest writes after the run directory is replaced by another directory", async () => {
    const run = await createRun(project, "replace");
    const stolen = path.join(root, "stolen");
    await fs.promises.rename(run.dir, stolen);
    await fs.promises.mkdir(run.dir);

    await expect(run.finish("completed")).rejects.toThrow(/replaced/);
    expect(await tree(run.dir)).toEqual([]);
    const original = JSON.parse(
      await fs.promises.readFile(path.join(stolen, "manifest.json"), "utf8"),
    );
    expect(original.status).toBe("running");
  });

  it("binds adopted handles to the verified root", async () => {
    const run = await createRun(project, "adopt");
    const adopted = await adoptRun(project, run.runId, run.manifest);
    await adopted.finish("completed");
    expect(
      JSON.parse(
        await fs.promises.readFile(path.join(run.dir, "manifest.json"), "utf8"),
      ).status,
    ).toBe("completed");

    const stolen = path.join(root, "stolen");
    await fs.promises.rename(run.dir, stolen);
    await fs.promises.symlink(stolen, run.dir);
    await expect(
      adoptRun(project, run.runId, run.manifest),
    ).rejects.toBeInstanceOf(RunStorageAccessError);
  });

  it("routes evidence runs through the verified root", async () => {
    const link = path.join(project, ".picklab");
    await fs.promises.symlink(outside, link);

    await expect(beginEvidenceRun(project, "session-1")).rejects.toBeInstanceOf(
      RunStorageAccessError,
    );
    expect(await tree(outside)).toEqual([]);
    expect(await isSymlinkTo(link, outside)).toBe(true);
  });
});

describe("home and custom write roots", () => {
  it("home: refuses a symlinked project-id component", async () => {
    vi.stubEnv("PICKFORGE_STORAGE_MODE", "home");
    const home = path.join(root, "home");
    const id = await projectId(project);
    await fs.promises.mkdir(path.join(home, "projects"), { recursive: true });
    const link = path.join(home, "projects", id);
    await fs.promises.symlink(outside, link);

    await expect(createRun(project, "smoke")).rejects.toBeInstanceOf(
      RunStorageAccessError,
    );
    expect(await tree(outside)).toEqual([]);
    expect(await isSymlinkTo(link, outside)).toBe(true);
    expect(await listRuns(project)).toEqual([]);
  });

  it("home: accepts a symlinked home root exactly as the catalog does", async () => {
    vi.stubEnv("PICKFORGE_STORAGE_MODE", "home");
    const realHome = path.join(root, "home-real");
    await fs.promises.mkdir(realHome);
    await fs.promises.symlink(realHome, path.join(root, "home"));

    const run = await createRun(project, "ok");
    expect(run.dir.startsWith(path.join(root, "home", "projects"))).toBe(true);
    expect((await listRuns(project)).map((r) => r.slug)).toEqual(["ok"]);
  });

  it("custom: refuses a symlinked runs directory", async () => {
    const custom = path.join(root, "custom");
    await fs.promises.mkdir(custom);
    vi.stubEnv("PICKFORGE_STORAGE_MODE", "custom");
    vi.stubEnv("PICKFORGE_STORAGE_PATH", custom);
    const link = path.join(custom, "runs");
    await fs.promises.symlink(outside, link);

    await expect(createRun(project, "smoke")).rejects.toBeInstanceOf(
      RunStorageAccessError,
    );
    expect(await tree(outside)).toEqual([]);
    expect(await isSymlinkTo(link, outside)).toBe(true);
  });

  it("custom: creates a missing base and runs directory", async () => {
    const custom = path.join(root, "custom-new");
    vi.stubEnv("PICKFORGE_STORAGE_MODE", "custom");
    vi.stubEnv("PICKFORGE_STORAGE_PATH", custom);

    const run = await createRun(project, "ok");
    expect(run.dir.startsWith(path.join(custom, "runs"))).toBe(true);
    expect(fs.existsSync(path.join(run.dir, "manifest.json"))).toBe(true);
    expect((await listRuns(project)).map((r) => r.slug)).toEqual(["ok"]);
  });
});
