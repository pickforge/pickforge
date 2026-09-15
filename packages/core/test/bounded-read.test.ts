import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DirHandle } from "../src/dir-handle.js";
import { MAX_BASELINE_BYTES, ObservationTimeoutError, readBaselineFile, readBoundedFileIn, readProjectFileBounded } from "../src/bounded-read.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-baseline-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it("reads ordinary project files and unrestricted CLI paths with finite bounds", async () => {
  fs.mkdirSync(path.join(root, "images"));
  const file = path.join(root, "images", "shot.png");
  fs.writeFileSync(file, "pixels");
  expect(await readProjectFileBounded(root, "images/shot.png", Date.now() + 1000)).toEqual(Buffer.from("pixels"));
  expect(await readBaselineFile(file, Date.now() + 1000)).toEqual(Buffer.from("pixels"));
  await expect(readBaselineFile(file, Date.now())).rejects.toBeInstanceOf(ObservationTimeoutError);
  fs.truncateSync(file, MAX_BASELINE_BYTES + 1);
  await expect(readBaselineFile(file, Date.now() + 1000)).rejects.toThrow(/exceeds/);
});

it("pins ancestors and refuses symlink traversal", async () => {
  fs.mkdirSync(path.join(root, "images"));
  fs.writeFileSync(path.join(root, "images", "shot.png"), "owned");
  const original = DirHandle.prototype.openChild;
  vi.spyOn(DirHandle.prototype, "openChild").mockImplementation(async function (this: DirHandle, name) {
    const held = await original.call(this, name);
    fs.renameSync(path.join(root, "images"), path.join(root, "held"));
    fs.mkdirSync(path.join(root, "images"));
    fs.writeFileSync(path.join(root, "images", "shot.png"), "substitute");
    return held;
  });
  expect(await readProjectFileBounded(root, "images/shot.png", Date.now() + 1000)).toEqual(Buffer.from("owned"));
  vi.restoreAllMocks();
  fs.symlinkSync(path.join(root, "held"), path.join(root, "link"));
  await expect(readProjectFileBounded(root, "link/shot.png", Date.now() + 1000)).rejects.toThrow(/symlink/);
});

it("refuses an opened replacement and does not block when a regular file becomes a FIFO", async () => {
  const file = path.join(root, "shot.png");
  fs.writeFileSync(file, "owned");
  const original = DirHandle.prototype.openFile;
  vi.spyOn(DirHandle.prototype, "openFile").mockImplementation(async function (this: DirHandle, name, flags, mode) {
    fs.renameSync(file, path.join(root, "old.png"));
    expect(spawnSync("mkfifo", [file]).status).toBe(0);
    return original.call(this, name, flags, mode);
  });
  const dir = await DirHandle.open(root);
  try {
    await expect(readBoundedFileIn(dir, "shot.png", Date.now() + 1000)).rejects.toThrow(/replaced/);
  } finally { await dir.close(); }
});
