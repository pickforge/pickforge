import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createRun, type RunHandle } from "../src/run.js";
import { openRunCatalog, type RunCatalog, type RunCatalogEntry } from "../src/run-catalog.js";
import {
  exportEvidenceRun,
  exportFrameMilliseconds,
  slideshowSize,
  type EvidenceExportManifest,
} from "../src/evidence-export.js";
import { encodePng, MAX_RASTER_PIXELS } from "../src/png-raster.js";
import { DirHandle } from "../src/dir-handle.js";
import { PNG_SIGNATURE, completePngSize } from "../src/evidence-png.js";
import type { EvidenceAction } from "../src/evidence.js";
import type { PointerGlyph } from "../src/evidence-glyphs.js";

let project: string;
let run: RunHandle;
let catalog: RunCatalog;
let entry: RunCatalogEntry;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const image = (width = 48, height = 32) =>
  encodePng({ width, height, pixels: Buffer.alloc(width * height * 4, 255) });
const action = (
  id: string,
  files: string[],
  overrides: Partial<EvidenceAction> = {},
): EvidenceAction => ({
  actionId: id,
  source: "mcp",
  tool: "desktop_click",
  status: "ok",
  startedAt: "2026-10-03T12:00:00.000Z",
  artifacts: files,
  inputState: "completed",
  target: { x: 10, y: 10, coordinateSpace: "xvfb-root", text: "PRIVATE-TEXT" },
  ...overrides,
});
beforeEach(async () => {
  const base = path.join(process.cwd(), "node_modules/.cache");
  await fs.promises.mkdir(base, { recursive: true });
  project = await fs.promises.mkdtemp(path.join(base, "evidence-export-"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
  run = await createRun(project, "exports", { evidence: true });
  catalog = await openRunCatalog(project);
  entry = (await catalog.find(run.runId))!;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.promises.rm(project, { recursive: true, force: true });
});
async function journal(records: EvidenceAction[]) {
  await fs.promises.writeFile(
    path.join(run.dir, "actions.jsonl"),
    records.map((r) => JSON.stringify(r) + "\n").join(""),
  );
}
async function manifest(dir: string): Promise<EvidenceExportManifest> {
  return JSON.parse(await fs.promises.readFile(path.join(dir, "export.json"), "utf8"));
}
async function screenshot(name: string, bytes = image()) {
  await fs.promises.writeFile(path.join(run.dir, "screenshots", name), bytes);
}
const glyph = (): PointerGlyph => ({
  version: 1,
  kind: "click",
  width: 48,
  height: 32,
  phase: "after",
  state: "completed",
  parts: [{ shape: "dot", at: { x: 10.5, y: 10.5 }, radius: 3 }],
  label: "PRIVATE-LABEL",
});

it("exports sorted frames, hashes, glyphs and byte copies without changing original files or identities", async () => {
  const original = image();
  await screenshot("a.png", original);
  await screenshot("b.png", original);
  const records = [
    action("later", ["screenshots/b.png"], { startedAt: "2026-10-03T12:00:01.000Z" }),
    action("earlier", ["screenshots/a.png"], {
      captures: [{ path: "screenshots/a.png", phase: "after", width: 48, height: 32 }],
    }),
  ];
  await journal(records);
  await fs.promises.writeFile(path.join(run.dir, "report.html"), "report original");
  await fs.promises.writeFile(path.join(run.dir, "report-share.html"), "share original");
  const paths = [
    "screenshots/a.png",
    "screenshots/b.png",
    "actions.jsonl",
    "manifest.json",
    "report.html",
    "report-share.html",
  ];
  const before = await Promise.all(
    paths.map(async (name) => ({
      name,
      bytes: await fs.promises.readFile(path.join(run.dir, name)),
      stat: await fs.promises.stat(path.join(run.dir, name)),
    })),
  );
  const opened: string[] = [];
  const originalOpen = DirHandle.prototype.openFile;
  vi.spyOn(DirHandle.prototype, "openFile").mockImplementation(function (
    this: DirHandle,
    name,
    flags,
    mode,
  ) {
    if (flags === "wx") {
      opened.push(name);
    }
    return originalOpen.call(this, name, flags, mode);
  });
  const source = vi.fn((_records, sizes) => {
    expect(sizes.get("screenshots/a.png")).toEqual({ width: 48, height: 32 });
    return new Map([["screenshots/a.png", glyph()]]);
  });
  const result = await exportEvidenceRun(catalog, entry, { glyphSource: source });
  expect(result).toMatchObject({
    complete: true,
    frameCount: 2,
    annotatedCount: 1,
    videoPath: null,
  });
  expect(opened.at(-1)).toBe("export.json");
  expect(source).toHaveBeenCalledWith(records, expect.any(Map));
  const doc = await manifest(result.exportDir);
  expect(doc).toMatchObject({
    schema: "pickforge.evidence-export",
    version: 1,
    runId: run.runId,
    runStatus: "running",
    pointerGlyphVersion: 1,
    journal: { bytes: before[2]!.bytes.length, sha256: hash(before[2]!.bytes) },
    video: null,
    skipped: [],
  });
  expect(doc.frames[0]).toMatchObject({
    file: "frame-0001.png",
    source: "screenshots/a.png",
    actionId: "earlier",
    phase: "after",
    glyphKind: "click",
    annotated: true,
    sourceSha256: hash(original),
  });
  const frame = await fs.promises.readFile(path.join(result.exportDir, "frame-0001.png"));
  expect(doc.frames[0]!.outputSha256).toBe(hash(frame));
  expect(frame).not.toEqual(original);
  expect(await fs.promises.readFile(path.join(result.exportDir, "frame-0002.png"))).toEqual(
    original,
  );
  expect(doc.frames[1]).toMatchObject({
    annotated: false,
    glyphKind: null,
    reason: "No eligible pointer glyph",
  });
  expect(JSON.stringify(doc)).not.toMatch(/PRIVATE|label|target|text/);
  expect((await fs.promises.stat(result.exportDir)).mode & 0o777).toBe(0o700);
  expect((await fs.promises.stat(path.join(result.exportDir, "export.json"))).mode & 0o777).toBe(
    0o600,
  );
  for (const saved of before) {
    expect(await fs.promises.readFile(path.join(run.dir, saved.name))).toEqual(saved.bytes);
    const after = await fs.promises.stat(path.join(run.dir, saved.name));
    expect([after.dev, after.ino, after.mtimeMs]).toEqual([
      saved.stat.dev,
      saved.stat.ino,
      saved.stat.mtimeMs,
    ]);
  }
  const second = await exportEvidenceRun(catalog, entry, { glyphSource: source });
  expect(second.exportId).not.toBe(result.exportId);
  expect(await fs.promises.readFile(path.join(second.exportDir, "frame-0001.png"))).toEqual(frame);
  expect(await fs.promises.readFile(second.pointerTrackPath)).toEqual(
    await fs.promises.readFile(result.pointerTrackPath),
  );
  expect((await catalog.find(run.runId))!.manifest).toEqual(entry.manifest);
});
it.each(["symlink", "file"])("refuses an exports entry that is a %s", async (kind) => {
  const outside = path.join(project, "outside");
  await fs.promises.mkdir(outside);
  const exports = path.join(run.dir, "exports");
  if (kind === "symlink") {
    await fs.promises.symlink(outside, exports);
  } else {
    await fs.promises.writeFile(exports, "original");
  }
  await expect(exportEvidenceRun(catalog, entry)).rejects.toThrow(/symlink|not a directory/);
  expect(await fs.promises.readdir(outside)).toEqual([]);
});
it("lists unsafe, missing, corrupt, over-byte-cap and over-pixel-cap sources with reasons", async () => {
  await screenshot("good.png");
  await fs.promises.symlink(
    path.join(run.dir, "screenshots/good.png"),
    path.join(run.dir, "screenshots/link.png"),
  );
  await screenshot("hard-source.png");
  await fs.promises.link(
    path.join(run.dir, "screenshots/hard-source.png"),
    path.join(run.dir, "screenshots/hard.png"),
  );
  await screenshot("corrupt.png", Buffer.concat([image(), Buffer.from("bad")]));
  const cap = await fs.promises.open(path.join(run.dir, "screenshots/cap.png"), "w");
  await cap.truncate(32 * 1024 * 1024 + 1);
  await cap.close();
  const oversized = customPng(MAX_RASTER_PIXELS + 1, 1, 0, Buffer.alloc(MAX_RASTER_PIXELS + 2));
  expect(completePngSize(oversized)).toEqual({ width: MAX_RASTER_PIXELS + 1, height: 1 });
  await screenshot("pixels.png", oversized);
  const files = [
    "screenshots/good.png",
    "screenshots/link.png",
    "screenshots/hard.png",
    "screenshots/corrupt.png",
    "screenshots/missing.png",
    "screenshots/cap.png",
    "screenshots/pixels.png",
    "screenshots/../escape.png",
    "/absolute.png",
    "other.png",
    "screenshots/nested/name.png",
  ];
  await journal([action("all", files)]);
  const result = await exportEvidenceRun(catalog, entry);
  const doc = await manifest(result.exportDir);
  expect(result.frameCount).toBe(1);
  expect(doc.skipped).toHaveLength(files.length - 1);
  const reasons = new Map(doc.skipped.map((s) => [s.source, s.reason]));
  expect(reasons.get(files[1]!)).toMatch(/Unsafe file/);
  expect(reasons.get(files[2]!)).toMatch(/hardlinks/);
  expect(reasons.get(files[3]!)).toBe("Corrupt PNG");
  expect(reasons.get(files[4]!)).toBe("Missing file");
  expect(reasons.get(files[5]!)).toMatch(/per-image cap/);
  expect(reasons.get(files[6]!)).toMatch(/pixel cap/);
  expect(reasons.get(files[7]!)).toMatch(/Unsafe/);
  expect(reasons.get(files[8]!)).toMatch(/Unsafe/);
});
function customPng(width: number, height: number, color: number, raw: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    out.write(type, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, -4)) >>> 0, out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = color;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
it("copies unsupported valid layouts with an explicit annotation reason", async () => {
  const bytes = customPng(48, 32, 0, Buffer.alloc(32 * 49));
  await screenshot("gray.png", bytes);
  await journal([action("gray", ["screenshots/gray.png"])]);
  const result = await exportEvidenceRun(catalog, entry, {
    glyphSource: () => new Map([["screenshots/gray.png", glyph()]]),
  });
  expect((await manifest(result.exportDir)).frames[0]).toMatchObject({
    annotated: false,
    reason: expect.stringContaining("Unsupported PNG raster layout"),
  });
  expect(await fs.promises.readFile(path.join(result.exportDir, "frame-0001.png"))).toEqual(bytes);
});
it("skips screenshots when the screenshot directory is a symlink", async () => {
  await fs.promises.rename(path.join(run.dir, "screenshots"), path.join(project, "captures"));
  await fs.promises.symlink(path.join(project, "captures"), path.join(run.dir, "screenshots"));
  await journal([action("a", ["screenshots/a.png"])]);
  const result = await exportEvidenceRun(catalog, entry);
  expect((await manifest(result.exportDir)).skipped[0]!.reason).toMatch(
    /directory missing or unsafe/,
  );
});
it("includes capture-only references, deduplicates shared sources and omits ambiguous ownership", async () => {
  await screenshot("a.png");
  await journal([
    action("a", [], {
      captures: [{ path: "screenshots/a.png", phase: "before", width: 48, height: 32 }],
    }),
    action("b", ["screenshots/a.png"]),
  ]);
  const result = await exportEvidenceRun(catalog, entry);
  expect(result.frameCount).toBe(1);
  expect((await manifest(result.exportDir)).frames[0]).toMatchObject({
    actionId: null,
    phase: null,
  });
});
it("skips sources that change after validation", async () => {
  await screenshot("a.png");
  await journal([action("a", ["screenshots/a.png"])]);
  const result = await exportEvidenceRun(catalog, entry, {
    glyphSource: () => {
      fs.writeFileSync(path.join(run.dir, "screenshots/a.png"), image(2, 2));
      return new Map();
    },
  });
  expect(result.frameCount).toBe(0);
  expect((await manifest(result.exportDir)).skipped[0]!.reason).toBe(
    "Screenshot changed during export",
  );
});
it("leaves a failed frame export incomplete without modifying prior exports", async () => {
  await screenshot("a.png");
  await journal([action("a", ["screenshots/a.png"])]);
  const earlier = await exportEvidenceRun(catalog, entry);
  const original = await fs.promises.readFile(path.join(earlier.exportDir, "export.json"));
  await expect(
    exportEvidenceRun(catalog, entry, {
      glyphSource: () => new Map([["screenshots/a.png", { ...glyph(), width: 1 }]]),
    }),
  ).rejects.toThrow("Export incomplete");
  const names = await fs.promises.readdir(path.join(run.dir, "exports"));
  expect(names).toHaveLength(2);
  const failed = names.find((name) => name !== earlier.exportId)!;
  expect(fs.existsSync(path.join(run.dir, "exports", failed, "export.json"))).toBe(false);
  expect(await fs.promises.readFile(path.join(earlier.exportDir, "export.json"))).toEqual(original);
});
it("removes only its partial final manifest on a manifest write failure", async () => {
  const open = DirHandle.prototype.openFile;
  vi.spyOn(DirHandle.prototype, "openFile").mockImplementation(async function (
    this: DirHandle,
    name,
    flags,
    mode,
  ) {
    const file = await open.call(this, name, flags, mode);
    if (name === "export.json") {
      vi.spyOn(file, "writeFile").mockImplementation(async () => {
        await file.write(Buffer.from("{"));
        throw new Error("synthetic write failure");
      });
    }
    return file;
  });
  await expect(exportEvidenceRun(catalog, entry)).rejects.toThrow("synthetic write failure");
  const dirs = await fs.promises.readdir(path.join(run.dir, "exports"));
  expect(await fs.promises.readdir(path.join(run.dir, "exports", dirs[0]!))).toEqual([
    "pointer-track.json",
  ]);
});
it("rejects non-evidence, corrupt journals and invalid durations", async () => {
  const plain = await createRun(project, "plain");
  const plainEntry = (await catalog.find(plain.runId))!;
  await expect(exportEvidenceRun(catalog, plainEntry)).rejects.toThrow("lab evidence run");
  await fs.promises.writeFile(path.join(run.dir, "actions.jsonl"), "bad\n");
  await expect(exportEvidenceRun(catalog, entry)).rejects.toThrow("Corrupt evidence journal");
  expect(exportFrameMilliseconds()).toBe(1000);
  for (const n of [0, 39, 60001, 50.5, Infinity, NaN]) {
    expect(() => exportFrameMilliseconds(n)).toThrow("--frame-ms");
  }
});
it("only requires ffmpeg when video is requested", async () => {
  vi.stubEnv("PATH", project);
  expect((await exportEvidenceRun(catalog, entry)).complete).toBe(true);
  await expect(exportEvidenceRun(catalog, entry, { video: true })).rejects.toThrow(
    "requires ffmpeg on PATH",
  );
});
it("preserves frames and track but no manifest when ffmpeg fails", async () => {
  const bin = path.join(project, "ffmpeg");
  await fs.promises.writeFile(bin, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  vi.stubEnv("PATH", project);
  await screenshot("a.png");
  await journal([action("a", ["screenshots/a.png"])]);
  const result = await exportEvidenceRun(catalog, entry, { video: true });
  expect(result).toMatchObject({
    complete: false,
    frameCount: 1,
    videoPath: null,
    videoError: expect.stringContaining("preserved"),
  });
  expect(fs.existsSync(result.pointerTrackPath)).toBe(true);
  expect(fs.existsSync(path.join(result.exportDir, "frame-0001.png"))).toBe(true);
  expect(fs.existsSync(path.join(result.exportDir, "export.json"))).toBe(false);
});
const ffmpegInstalled = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
it.skipIf(!ffmpegInstalled)(
  "creates a real even-sized slideshow from different frame sizes",
  async () => {
    await screenshot("a.png");
    await screenshot("b.png", image(31, 53));
    await journal([action("a", ["screenshots/a.png"]), action("b", ["screenshots/b.png"])]);
    const result = await exportEvidenceRun(catalog, entry, { video: true, frameMs: 200 });
    expect(result).toMatchObject({
      complete: true,
      frameCount: 2,
      videoPath: expect.stringContaining("slideshow.mp4"),
    });
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", result.videoPath!],
      { encoding: "utf8" },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const video = JSON.parse(probe.stdout);
    expect(video.streams[0]).toMatchObject({
      width: 48,
      height: 54,
      pix_fmt: "yuv420p",
      codec_name: "h264",
    });
    expect(Number(video.format.duration)).toBeCloseTo(0.4, 1);
    expect(fs.existsSync(path.join(result.exportDir, "slideshow.ffconcat"))).toBe(true);
    expect((await manifest(result.exportDir)).video).toEqual({
      file: "slideshow.mp4",
      kind: "slideshow-of-stills",
      frameMs: 200,
      width: 48,
      height: 54,
      concatFile: "slideshow.ffconcat",
    });
  },
  20_000,
);

it.each([
  [[{ width: 1280, height: 800 }], { width: 1280, height: 800 }],
  [
    [
      { width: 1281, height: 801 },
      { width: 31, height: 1001 },
    ],
    { width: 1282, height: 1002 },
  ],
  [[{ width: 4000, height: 1000 }], { width: 3840, height: 960 }],
  [[{ width: 1000, height: 4000 }], { width: 540, height: 2160 }],
  [[{ width: 3840, height: 2160 }], { width: 3840, height: 2160 }],
])("chooses an even canvas within 3840 by 2160 for %j", (sizes, expected) => {
  expect(slideshowSize(sizes.map((size) => ({ size })))).toEqual(expected);
});
it.skipIf(!ffmpegInstalled).each([
  [1280, 800, 1280, 800],
  [4000, 1000, 3840, 960],
])(
  "encodes %ix%i captures at %ix%i and records the concat file",
  async (width, height, expectedWidth, expectedHeight) => {
    await screenshot("large.png", image(width, height));
    await journal([action("large", ["screenshots/large.png"])]);
    const result = await exportEvidenceRun(catalog, entry, { video: true, frameMs: 80 });
    expect(result.complete, result.videoError).toBe(true);
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", result.videoPath!],
      { encoding: "utf8" },
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout).streams[0]).toMatchObject({
      width: expectedWidth,
      height: expectedHeight,
      pix_fmt: "yuv420p",
    });
    expect((await manifest(result.exportDir)).video).toMatchObject({
      width: expectedWidth,
      height: expectedHeight,
      concatFile: "slideshow.ffconcat",
    });
  },
  20_000,
);
