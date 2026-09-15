import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DirHandle } from "../src/dir-handle.js";
import { adoptRun } from "../src/run.js";
import { beginEvidenceRun, finalizeActiveEvidenceRun, setRunCaptureGeometry } from "../src/evidence.js";

let project: string;
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-coordination-"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(project, { recursive: true, force: true });
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Pause the first manifest publish while a real peer attempts the same lock. */
function pausePublish() {
  const entered = signal();
  const release = signal();
  const blocked = signal();
  let paused = false;
  const write = DirHandle.prototype.writeFileAtomic;
  vi.spyOn(DirHandle.prototype, "writeFileAtomic").mockImplementation(async function (this: DirHandle, name, content) {
    if (name === "manifest.json" && !paused) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return write.call(this, name, content);
  });
  const open = DirHandle.prototype.openFile;
  vi.spyOn(DirHandle.prototype, "openFile").mockImplementation(async function (this: DirHandle, name, flags, mode) {
    try { return await open.call(this, name, flags, mode); }
    catch (error) {
      if (name === ".evidence-journal.lock" && (error as NodeJS.ErrnoException).code === "EEXIST") blocked.resolve();
      throw error;
    }
  });
  return { entered, release, blocked };
}

const geometry = { image: { width: 320, height: 240 }, viewport: { width: 320, height: 240 }, scale: 1, coordinateSpace: "image-pixels" as const };

it.each(["geometry-first", "finalization-first"])("serializes %s without restoring running or losing geometry", async (order) => {
  const { run } = await beginEvidenceRun(project, "session", { device: { kind: "desktop", browser: "kept", platform: "Linux", touch: true }, meta: { reserved: "keep" } });
  const initial = await run.readManifest();
  const geometryUpdate = () => setRunCaptureGeometry(run, geometry);
  const finalize = () => finalizeActiveEvidenceRun(project, "session");
  const first = order === "geometry-first" ? geometryUpdate : finalize;
  const second = order === "geometry-first" ? finalize : geometryUpdate;
  const gate = pausePublish();
  const pending: Promise<unknown>[] = [];
  try {
    pending.push(first());
    await gate.entered.promise;
    pending.push(second());
    await gate.blocked.promise;
  } finally {
    gate.release.resolve();
    await Promise.all(pending);
  }
  const fresh = await run.readManifest();
  expect(fresh.status).toBe("completed");
  expect(fresh.device).toEqual({ ...initial.device, ...geometry });
  expect(fresh.meta).toEqual(initial.meta);
  expect(fresh.evidenceVersion).toBe(initial.evidenceVersion);
  expect(fresh.evidenceTruncated).toBe(false);
});

it("serializes peer artifact/status updates behind a pending geometry publish", async () => {
  const { run } = await beginEvidenceRun(project, "session", { device: { kind: "desktop", browser: "kept" } });
  const peer = await adoptRun(project, run.runId, await run.readManifest());
  const gate = pausePublish();
  const pending: Promise<unknown>[] = [];
  try {
    pending.push(setRunCaptureGeometry(run, geometry));
    await gate.entered.promise;
    pending.push(peer.addArtifact("log", "peer", "logs/peer.log"));
    pending.push(peer.setStatus("failed"));
    await gate.blocked.promise;
  } finally {
    gate.release.resolve();
    await Promise.all(pending);
  }
  const fresh = await run.readManifest();
  expect(fresh.status).toBe("failed");
  expect(fresh.artifacts).toEqual([expect.objectContaining({ name: "peer" })]);
  expect(fresh.device).toEqual({ kind: "desktop", browser: "kept", ...geometry });
});
