import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptRun, createRun, listRuns, readOwnedRunFile } from "../src/run.js";
import { setRunCaptureGeometry, setRunDevice } from "../src/evidence.js";

let project: string;

// These tests assert against the literal `.picklab/runs` layout, so they pin
// storage to `project-local` explicitly rather than the new `home` default
// (covered by storage.test.ts).
beforeEach(async () => {
  project = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-run-"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.promises.rm(project, { recursive: true, force: true });
});

describe("createRun", () => {
  it("creates run dir with subdirs and initial manifest", async () => {
    const run = await createRun(project, "smoke");
    expect(path.basename(run.dir)).toMatch(/^\d{8}-\d{6}-smoke$/);
    expect(fs.existsSync(path.join(run.dir, "screenshots"))).toBe(true);
    expect(fs.existsSync(path.join(run.dir, "logs"))).toBe(true);

    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(run.dir, "manifest.json"), "utf8"),
    );
    expect(manifest.runId).toBe(path.basename(run.dir));
    expect(manifest.slug).toBe("smoke");
    expect(manifest.status).toBe("running");
    expect(manifest.artifacts).toEqual([]);
    expect(new Date(manifest.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("rejects slugs containing path traversal or separators", async () => {
    for (const slug of [
      "../escape",
      "..",
      "a/b",
      "a\\b",
      ".hidden",
      "",
      "x/../../etc",
    ]) {
      await expect(createRun(project, slug)).rejects.toThrow(/slug/i);
    }
    expect(fs.existsSync(path.join(project, ".picklab", "escape"))).toBe(false);
  });

  it("derives the run directory timestamp from UTC", async () => {
    const now = new Date("2026-06-09T23:59:58Z");
    const run = await createRun(project, "utc", { now });
    expect(path.basename(run.dir)).toBe("20260609-235958-utc");
  });

  it("appends collision suffixes for the same timestamp", async () => {
    const now = new Date("2026-06-09T10:20:30Z");
    const a = await createRun(project, "dup", { now });
    const b = await createRun(project, "dup", { now });
    const c = await createRun(project, "dup", { now });
    expect(path.basename(b.dir)).toBe(`${path.basename(a.dir)}-2`);
    expect(path.basename(c.dir)).toBe(`${path.basename(a.dir)}-3`);
  });

  it("persists artifacts and status transitions", async () => {
    const run = await createRun(project, "art");
    const shot = path.join(run.dir, "screenshots", "home.png");
    await fs.promises.writeFile(shot, "png");
    await run.addArtifact("screenshot", "home", shot);
    await run.setStatus("running");
    await run.finish("completed");

    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(run.dir, "manifest.json"), "utf8"),
    );
    expect(manifest.status).toBe("completed");
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0].type).toBe("screenshot");
    expect(manifest.artifacts[0].name).toBe("home");
    expect(manifest.artifacts[0].path).toBe(path.join("screenshots", "home.png"));
  });

  it("updates device metadata through the run handle", async () => {
    const run = await createRun(project, "device");
    await run.setDevice({
      kind: "desktop",
      viewport: { width: 320, height: 240 },
      image: { width: 320, height: 240 },
      scale: 1,
      coordinateSpace: "image-pixels",
    });
    expect((await run.readManifest()).device).toEqual({
      kind: "desktop",
      viewport: { width: 320, height: 240 },
      image: { width: 320, height: 240 },
      scale: 1,
      coordinateSpace: "image-pixels",
    });
  });

  it("keeps another writer's artifacts and status when device metadata is saved", async () => {
    const run = await createRun(project, "merge");
    const peer = await adoptRun(project, run.runId, await run.readManifest());
    const shot = path.join(peer.dir, "screenshots", "kept.png");
    await fs.promises.writeFile(shot, "png");
    await peer.addArtifact("screenshot", "kept", shot);
    await peer.setStatus("completed");
    await run.setDevice({
      kind: "desktop",
      image: { width: 8, height: 8 },
      scale: 1,
      coordinateSpace: "image-pixels",
    });
    const manifest = await run.readManifest();
    expect(manifest.status).toBe("completed");
    expect(manifest.artifacts).toEqual([
      expect.objectContaining({ name: "kept", path: path.join("screenshots", "kept.png") }),
    ]);
    expect(manifest.device).toEqual({
      kind: "desktop",
      image: { width: 8, height: 8 },
      scale: 1,
      coordinateSpace: "image-pixels",
    });
  });

  it("merges only geometry with intervening device, artifact and status updates", async () => {
    const run = await createRun(project, "geometry", { device: { kind: "desktop", browser: "old" } });
    const peer = await adoptRun(project, run.runId, await run.readManifest());
    await setRunDevice(peer, { kind: "desktop", browser: "new", platform: "preserved", touch: true });
    await peer.addArtifact("log", "kept", "logs/kept.log");
    await peer.setStatus("completed");
    await setRunCaptureGeometry(run, { viewport: { width: 8, height: 8 }, image: { width: 8, height: 8 }, scale: 1, coordinateSpace: "image-pixels" });
    const fresh = await run.readManifest();
    expect(fresh.device).toMatchObject({ kind: "desktop", browser: "new", platform: "preserved", touch: true, scale: 1 });
    expect(fresh.artifacts).toHaveLength(1);
    expect(fresh.status).toBe("completed");
    await setRunDevice(peer, { kind: "emulator", platform: "Android" });
    await setRunCaptureGeometry(run, { viewport: { width: 8, height: 8 }, image: { width: 8, height: 8 }, scale: 1, coordinateSpace: "image-pixels" });
    expect((await run.readManifest()).device).toEqual({ kind: "emulator", platform: "Android" });
  });

  it("reads owned screenshots and refuses a substituted screenshots directory", async () => {
    const run = await createRun(project, "owned");
    const name = "shot.png";
    await fs.promises.writeFile(path.join(run.dir, "screenshots", name), "owned-bytes");
    expect(await readOwnedRunFile(project, run.runId, "screenshots", name)).toEqual(
      Buffer.from("owned-bytes"),
    );
    const outside = path.join(project, "outside.png");
    await fs.promises.writeFile(outside, "leaked");
    await fs.promises.rm(path.join(run.dir, "screenshots"), { recursive: true });
    await fs.promises.symlink(path.dirname(outside), path.join(run.dir, "screenshots"));
    await expect(
      readOwnedRunFile(project, run.runId, "screenshots", "outside.png"),
    ).rejects.toThrow(/verified directory|regular owned file|symlink/i);
  });

  it("accepts relative artifact paths", async () => {
    const run = await createRun(project, "rel");
    await run.addArtifact("log", "app", path.join("logs", "app.log"));
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(run.dir, "manifest.json"), "utf8"),
    );
    expect(manifest.artifacts[0].path).toBe(path.join("logs", "app.log"));
  });
});

describe("listRuns", () => {
  it("returns runs newest-first and skips corrupt manifests", async () => {
    const first = await createRun(project, "one", {
      now: new Date("2026-06-09T08:00:00Z"),
    });
    const second = await createRun(project, "two", {
      now: new Date("2026-06-09T09:00:00Z"),
    });
    const corrupt = await createRun(project, "bad", {
      now: new Date("2026-06-09T10:00:00Z"),
    });
    await fs.promises.writeFile(
      path.join(corrupt.dir, "manifest.json"),
      "not json",
    );

    const runs = await listRuns(project);
    expect(runs.map((r) => r.slug)).toEqual(["two", "one"]);
    expect(runs[0]?.runId).toBe(path.basename(second.dir));
    expect(runs[1]?.runId).toBe(path.basename(first.dir));
  });

  it("skips manifests without an artifacts array", async () => {
    await createRun(project, "good", {
      now: new Date("2026-06-09T08:00:00Z"),
    });
    const bad = await createRun(project, "bad", {
      now: new Date("2026-06-09T09:00:00Z"),
    });
    const manifestPath = path.join(bad.dir, "manifest.json");
    const manifest = JSON.parse(
      await fs.promises.readFile(manifestPath, "utf8"),
    );
    delete manifest.artifacts;
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest));

    const runs = await listRuns(project);
    expect(runs.map((r) => r.slug)).toEqual(["good"]);
  });

  it("returns empty list when no runs exist", async () => {
    expect(await listRuns(project)).toEqual([]);
  });

  it("skips runs whose manifest.json is a symlink", async () => {
    const good = await createRun(project, "good", {
      now: new Date("2026-06-09T08:00:00Z"),
    });
    const evil = await createRun(project, "evil", {
      now: new Date("2026-06-09T09:00:00Z"),
    });
    const target = path.join(good.dir, "manifest.json");
    const manifestPath = path.join(evil.dir, "manifest.json");
    await fs.promises.rm(manifestPath);
    await fs.promises.symlink(target, manifestPath);

    const runs = await listRuns(project);
    expect(runs.map((r) => r.slug)).toEqual(["good"]);
  });

  it("skips run entries that are symlinks", async () => {
    const good = await createRun(project, "good", {
      now: new Date("2026-06-09T08:00:00Z"),
    });
    const runsRoot = path.join(project, ".picklab", "runs");
    await fs.promises.symlink(good.dir, path.join(runsRoot, "linked-run"));

    const runs = await listRuns(project);
    expect(runs.map((r) => r.slug)).toEqual(["good"]);
  });

  it("returns empty list when the runs root is a symlink", async () => {
    await createRun(project, "good");
    const runsRoot = path.join(project, ".picklab", "runs");
    const moved = path.join(project, ".picklab", "runs-real");
    await fs.promises.rename(runsRoot, moved);
    await fs.promises.symlink(moved, runsRoot);

    expect(await listRuns(project)).toEqual([]);
  });

  it("returns empty list when .picklab is a symlink pointing outside", async () => {
    const outside = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pickforge-lab-outside-"),
    );
    try {
      // Build a real runs tree (with a run) outside the project, then point
      // the project's `.picklab` at it via a symlink.
      await createRun(outside, "leak");
      await fs.promises.symlink(
        path.join(outside, ".picklab"),
        path.join(project, ".picklab"),
      );
      expect(await listRuns(project)).toEqual([]);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});
