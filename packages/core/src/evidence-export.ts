import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DirHandle } from "./dir-handle.js";
import { withDirHandle } from "./dir-handle.js";
import {
  isEvidenceRun,
  isTruncationRecord,
  parseActionsJournal,
  type EvidenceAction,
  type EvidenceRecord,
} from "./evidence.js";
import { isOutcomeRecord } from "./evidence-outcome.js";
import { sortEvidenceRecords } from "./evidence-render.js";
import {
  completePngSize,
  openScreenshotsDir,
  PNG_SIGNATURE,
  readShareScreenshot,
  type PngSize,
} from "./evidence-png.js";
import { sanitizeCaptureLinks, sanitizeErrorText } from "./evidence-sanitize.js";
import { POINTER_GLYPH_VERSION, runPointerGlyphs, type PointerGlyph } from "./evidence-glyphs.js";
import { assertRasterSize, decodePng, drawPointerGlyph, encodePng } from "./png-raster.js";
import { createPointerTrack } from "./pointer-track.js";
import { EVIDENCE_ACTION_LOG } from "./run.js";
import type { RunCatalog, RunCatalogEntry } from "./run-catalog.js";

export const DEFAULT_EXPORT_FRAME_MS = 1000;
export type GlyphSource = (
  records: readonly EvidenceRecord[],
  sizes: ReadonlyMap<string, Readonly<PngSize>>,
) => ReadonlyMap<string, PointerGlyph>;
export interface EvidenceExportOptions {
  video?: boolean;
  frameMs?: number;
  glyphSource?: GlyphSource;
}
export interface ExportFrame {
  file: string;
  source: string;
  sourceSha256: string;
  outputSha256: string;
  size: PngSize;
  actionId: string | null;
  phase: "before" | "after" | null;
  glyphKind: PointerGlyph["kind"] | null;
  annotated: boolean;
  reason?: string;
}
export interface ExportVideo {
  file: "slideshow.mp4";
  concatFile: "slideshow.ffconcat";
  kind: "slideshow-of-stills";
  frameMs: number;
  width: number;
  height: number;
}
export interface EvidenceExportManifest {
  schema: "pickforge.evidence-export";
  version: 1;
  runId: string;
  exportId: string;
  createdAt: string;
  runStatus: string;
  pointerGlyphVersion: number;
  journal: {
    bytes: number;
    sha256: string;
  };
  frames: ExportFrame[];
  skipped: {
    source: string;
    reason: string;
  }[];
  pointerTrack: "pointer-track.json";
  video: ExportVideo | null;
}
export interface EvidenceExportResult {
  runId: string;
  exportId: string;
  exportDir: string;
  frameCount: number;
  annotatedCount: number;
  pointerTrackPath: string;
  videoPath: string | null;
  complete: boolean;
  videoError?: string;
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function exportFrameMilliseconds(value: number = DEFAULT_EXPORT_FRAME_MS): number {
  if (!Number.isSafeInteger(value) || value < 40 || value > 60_000) {
    throw new Error("frame duration must be an integer from 40 to 60000");
  }
  return value;
}

function sourceRecords(records: readonly EvidenceRecord[]): Map<string, EvidenceAction[]> {
  const result = new Map<string, EvidenceAction[]>();
  for (const record of sortEvidenceRecords(records)) {
    if (isTruncationRecord(record) || isOutcomeRecord(record)) {
      continue;
    }
    const captures = Array.isArray(record.captures)
      ? record.captures.flatMap((link) => (typeof link?.path === "string" ? [link.path] : []))
      : [];
    for (const source of new Set([...(record.artifacts ?? []), ...captures])) {
      // Artifact lists also contain logs. Only screenshot candidates belong in a frame export.
      if (!source.startsWith("screenshots/") && !source.toLowerCase().endsWith(".png")) {
        continue;
      }
      const owners = result.get(source) ?? [];
      owners.push(record);
      result.set(source, owners);
    }
  }
  return result;
}

async function readSource(
  screenshots: DirHandle | undefined,
  source: string,
): Promise<Buffer | string> {
  try {
    return await readShareScreenshot(screenshots, source);
  } catch {
    return "Screenshot could not be read safely";
  }
}

function validatedSize(bytes: Buffer): PngSize | string {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "Corrupt PNG";
  }
  return completePngSize(bytes) ?? "Corrupt PNG";
}

async function writeExclusive(dir: DirHandle, name: string, bytes: Buffer | string): Promise<void> {
  const file = await dir.openFile(name, "wx", 0o600);
  const identity = await file.stat();
  try {
    await file.writeFile(bytes);
  } catch (error) {
    // A partial final manifest must never make an export look complete.
    await dir.unlinkOwnedFile(name, identity).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }
}

async function findFfmpeg(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.resolve(directory, "ffmpeg");
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      if ((await fs.promises.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error("--video requires ffmpeg on PATH");
}

/**
 * Preserve the largest capture canvas. Scale proportionally only above 3840 by 2160,
 * then round up to even pixels.
 */
export function slideshowSize(frames: readonly Pick<ExportFrame, "size">[]): PngSize {
  const width = Math.max(...frames.map((frame) => frame.size.width));
  const height = Math.max(...frames.map((frame) => frame.size.height));
  assertRasterSize(width, 1);
  assertRasterSize(1, height);
  const scale = Math.min(1, 3840 / width, 2160 / height);
  return { width: Math.ceil((width * scale) / 2) * 2, height: Math.ceil((height * scale) / 2) * 2 };
}

interface PinnedFrame {
  frame: ExportFrame;
  file: fs.promises.FileHandle;
  identity: fs.Stats;
}

async function hashDescriptor(file: fs.promises.FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      return hash.digest("hex");
    }
    position += bytesRead;
    if (position > 64 * 1024 * 1024) {
      throw new Error("Exported frame exceeds byte cap");
    }
    hash.update(buffer.subarray(0, bytesRead));
  }
}

async function verifyPinnedFrame(dir: DirHandle, pinned: PinnedFrame): Promise<void> {
  const current = await dir.lstatChild(pinned.frame.file);
  if (current?.dev !== pinned.identity.dev || current?.ino !== pinned.identity.ino) {
    throw new Error("Exported frame changed before video completed");
  }
  const stat = await pinned.file.stat();
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error("Unsafe exported frame");
  }
  if ((await hashDescriptor(pinned.file)) !== pinned.frame.outputSha256) {
    throw new Error("Exported frame hash changed");
  }
}

async function pinFrame(dir: DirHandle, frame: ExportFrame): Promise<PinnedFrame> {
  const file = await dir.openFile(
    frame.file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const pinned = { frame, file, identity: await file.stat() };
    await verifyPinnedFrame(dir, pinned);
    return pinned;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function pinFrames(dir: DirHandle, frames: ExportFrame[]): Promise<PinnedFrame[]> {
  const pinned: PinnedFrame[] = [];
  try {
    for (const frame of frames) {
      pinned.push(await pinFrame(dir, frame));
    }
    return pinned;
  } catch (error) {
    await Promise.all(pinned.map(({ file }) => file.close()));
    if ((error as NodeJS.ErrnoException).code === "EMFILE") {
      throw new Error(
        "Video cannot pin all frames: process file descriptor limit reached (EMFILE)",
      );
    }
    throw error;
  }
}

function concatInput(paths: string[], frameMs: number): string {
  const entries = paths.map((file) => `file '${file}'\nduration ${frameMs / 1000}\n`);
  return "ffconcat version 1.0\n" + entries.join("") + `file '${paths.at(-1)!}'\n`;
}

function videoArguments(size: PngSize, count: number, frameMs: number): string[] {
  const { width, height } = size;
  // Uniform still durations use an exact rational rate, not a fixed 25 fps grid.
  // Input -r replaces the concat image demuxer's coarse timestamps on older ffmpeg.
  // Millisecond container timestamps preserve every requested duration.
  return [
    "-nostdin",
    "-n",
    "-v",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-f",
    "concat",
    "-safe",
    "0",
    "-r",
    `1000/${frameMs}`,
    "-i",
    "pipe:0",
    "-vf",
    `scale=w='min(iw,${width})':h='min(ih,${height})':` +
      `force_original_aspect_ratio=decrease,pad=${width}:${height}:` +
      "(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
    "-an",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-preset",
    "veryfast",
    "-bf",
    "0",
    "-r",
    `1000/${frameMs}`,
    "-enc_time_base",
    `${frameMs}:1000`,
    "-video_track_timescale",
    "1000",
    "-t",
    String((count * frameMs) / 1000),
    "-movflags",
    "frag_keyframe+empty_moov",
    "-f",
    "mp4",
    "pipe:1",
  ];
}

function killVideoGroup(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group may already have exited.
  }
}

async function boundedSettle(tasks: Promise<unknown>[], milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeVideoOutput(
  child: ChildProcessWithoutNullStreams,
  file: fs.promises.FileHandle,
): Promise<void> {
  let bytes = 0;
  for await (const chunk of child.stdout) {
    bytes += chunk.length;
    if (bytes > 256 * 1024 * 1024) {
      throw new Error("Video exceeds 256 MiB output cap");
    }
    await file.writeFile(chunk);
  }
  if (bytes === 0) {
    throw new Error("ffmpeg produced no video");
  }
}

/** Keep complete diagnostic lines so truncation never detaches a secret from its key. */
class VideoDiagnostics {
  private pending = Buffer.alloc(0);
  private dropping = false;
  private tail = Buffer.alloc(0);

  append(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      this.appendPart(chunk.subarray(start, end));
      if (newline < 0) {
        return;
      }
      this.finishLine();
      start = end + 1;
    }
  }

  private appendPart(part: Buffer): void {
    if (this.dropping) {
      return;
    }
    // Discard an entire oversized line, including its remaining chunks.
    if (this.pending.length + part.length > 64 * 1024) {
      this.pending = Buffer.alloc(0);
      this.dropping = true;
      return;
    }
    this.pending = Buffer.concat([this.pending, part]);
  }

  private finishLine(): void {
    if (!this.dropping) {
      const line = sanitizeErrorText(this.pending.toString("utf8"), 64 * 1024);
      this.tail = Buffer.from(Buffer.concat([this.tail, Buffer.from(line + "\n")]).subarray(-2048));
    }
    this.pending = Buffer.alloc(0);
    this.dropping = false;
  }

  finish(): string {
    if (this.pending.length > 0) {
      this.finishLine();
    }
    return this.tail.toString("utf8").trim();
  }
}

async function encodeVideo(
  ffmpeg: string,
  args: string[],
  concat: string,
  file: fs.promises.FileHandle,
): Promise<void> {
  const child = spawn(ffmpeg, args, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const diagnosticTail = new VideoDiagnostics();
  const diagnostics = (async () => {
    for await (const chunk of child.stderr) {
      diagnosticTail.append(chunk);
    }
  })();
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("ffmpeg could not start")));
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg failed"))));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("ffmpeg timed out")), 120_000);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(concat);
  const tasks = [exited, writeVideoOutput(child, file), diagnostics];
  try {
    await Promise.race([Promise.all(tasks), deadline]);
  } catch (error) {
    killVideoGroup(child);
    await boundedSettle(tasks, 1000);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await boundedSettle(tasks, 500);
    const detail = diagnosticTail.finish();
    throw new Error(`${(error as Error).message}${detail === "" ? "" : `: ${detail}`}`);
  } finally {
    clearTimeout(timer);
  }
}

async function writePinnedVideo(
  dir: DirHandle,
  ffmpeg: string,
  pinned: PinnedFrame[],
  frameMs: number,
): Promise<ExportVideo> {
  const frames = pinned.map(({ frame }) => frame);
  const size = slideshowSize(frames);
  // The stored concat file works from this directory after descriptors close.
  await writeExclusive(
    dir,
    "slideshow.ffconcat",
    concatInput(
      frames.map((f) => f.file),
      frameMs,
    ),
  );
  const paths = pinned.map(({ file }) => `file:/proc/${process.pid}/fd/${file.fd}`);
  const file = await dir.openFile("slideshow.mp4", "wx", 0o600);
  const identity = await file.stat();
  try {
    await encodeVideo(
      ffmpeg,
      videoArguments(size, frames.length, frameMs),
      concatInput(paths, frameMs),
      file,
    );
    for (const frame of pinned) {
      await verifyPinnedFrame(dir, frame);
    }
  } catch (error) {
    // Remove only our partial video. Frames and track remain visibly incomplete.
    await dir.unlinkOwnedFile("slideshow.mp4", identity).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }
  return {
    file: "slideshow.mp4",
    concatFile: "slideshow.ffconcat",
    kind: "slideshow-of-stills",
    frameMs,
    ...size,
  };
}

async function writeVideo(
  dir: DirHandle,
  ffmpeg: string,
  frames: ExportFrame[],
  frameMs: number,
): Promise<ExportVideo> {
  if (frames.length === 0) {
    throw new Error("Video requires at least one exported frame");
  }
  const pinned = await pinFrames(dir, frames);
  try {
    return await writePinnedVideo(dir, ffmpeg, pinned, frameMs);
  } finally {
    await Promise.all(pinned.map(({ file }) => file.close()));
  }
}

interface Sources {
  sizes: Map<string, PngSize>;
  hashes: Map<string, string>;
  skipped: EvidenceExportManifest["skipped"];
}
async function inspectSources(
  screenshots: DirHandle | undefined,
  sources: Map<string, EvidenceAction[]>,
): Promise<Sources> {
  const sizes = new Map<string, PngSize>();
  const hashes = new Map<string, string>();
  const skipped: Sources["skipped"] = [];
  for (const source of sources.keys()) {
    const bytes = await readSource(screenshots, source);
    const size = typeof bytes === "string" ? bytes : validatedSize(bytes);
    if (typeof size === "string") {
      skipped.push({ source, reason: size });
      continue;
    }
    sizes.set(source, size);
    hashes.set(source, sha256(bytes as Buffer));
  }
  return { sizes, hashes, skipped };
}

async function writeFrames(
  dir: DirHandle,
  screenshots: DirHandle | undefined,
  sources: Map<string, EvidenceAction[]>,
  inspected: Sources,
  glyphs: ReadonlyMap<string, PointerGlyph>,
): Promise<ExportFrame[]> {
  const frames: ExportFrame[] = [];
  for (const [source, size] of inspected.sizes) {
    const bytes = await readSource(screenshots, source);
    if (typeof bytes === "string" || sha256(bytes) !== inspected.hashes.get(source)) {
      inspected.skipped.push({
        source,
        reason: typeof bytes === "string" ? bytes : "Screenshot changed during export",
      });
      continue;
    }
    const glyph = glyphs.get(source);
    const { output, ...annotation } = renderFrame(bytes, glyph);
    const frame: ExportFrame = {
      file: `frame-${String(frames.length + 1).padStart(4, "0")}.png`,
      source,
      sourceSha256: sha256(bytes),
      outputSha256: sha256(output),
      size,
      ...frameOwnership(sources.get(source)!, source),
      glyphKind: glyph?.kind ?? null,
      ...annotation,
    };
    await writeExclusive(dir, frame.file, output);
    frames.push(frame);
  }
  return frames;
}

function renderFrame(
  bytes: Buffer,
  glyph: PointerGlyph | undefined,
): Pick<ExportFrame, "annotated" | "reason"> & {
  output: Buffer;
} {
  if (glyph === undefined) {
    return { output: bytes, annotated: false, reason: copyReason(bytes) };
  }
  let raster;
  try {
    raster = decodePng(bytes);
  } catch (error) {
    return {
      output: bytes,
      annotated: false,
      reason: sanitizeErrorText(
        `PNG could not be decoded: ${String(error)}; source copied without annotation`,
      ),
    };
  }
  drawPointerGlyph(raster, glyph);
  return { output: encodePng(raster), annotated: true };
}

function copyReason(bytes: Buffer): string {
  try {
    assertRasterSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    return "No eligible pointer glyph";
  } catch {
    return "Over raster pixel cap; source copied without annotation";
  }
}

function frameOwnership(
  owners: EvidenceAction[],
  source: string,
): Pick<ExportFrame, "actionId" | "phase"> {
  const owner = owners.length === 1 ? owners[0] : undefined;
  const link =
    owner === undefined
      ? undefined
      : sanitizeCaptureLinks(owner.captures).find((c) => c.path === source);
  return { actionId: owner?.actionId ?? null, phase: link?.phase ?? null };
}

/**
 * All writes stay under one new export directory. Failures preserve that directory
 * without export.json; the missing final manifest marks it as incomplete.
 * Neither evidence files nor earlier exports are changed or removed.
 */
export async function exportEvidenceRun(
  catalog: RunCatalog,
  entry: RunCatalogEntry,
  options: EvidenceExportOptions = {},
): Promise<EvidenceExportResult> {
  const manifest = await catalog.refresh(entry);
  if (manifest === undefined) {
    throw new Error("Run changed before export");
  }
  if (!isEvidenceRun(manifest)) {
    throw new Error(
      "Export requires a lab evidence run; Rust and non-evidence runs are unsupported",
    );
  }
  if (manifest.evidenceRecovery === "corrupt") {
    throw new Error("Cannot export a corrupt evidence journal");
  }
  const frameMs = exportFrameMilliseconds(options.frameMs);
  const ffmpeg = options.video === true ? await findFfmpeg() : undefined;
  const journal = await catalog.readRootFile(entry, EVIDENCE_ACTION_LOG);
  const records = parseActionsJournal(journal.toString("utf8"), entry.dir);
  const createdAt = new Date().toISOString();
  const exportId = `${createdAt.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const result = await catalog.withRunDir(entry, async (runDir) => {
    const screenshots = await openScreenshotsDir(runDir);
    try {
      const sources = sourceRecords(records);
      const inspected = await inspectSources(screenshots, sources);
      const glyphs = (options.glyphSource ?? runPointerGlyphs)(records, inspected.sizes);
      return await withDirHandle(runDir.ensureChildDir("exports", 0o700), async (exports) => {
        await exports.mkdirChild(exportId, 0o700);
        return withDirHandle(exports.openChild(exportId), async (dir) => {
          const exportDir = path.join(entry.dir, "exports", exportId);
          try {
            const frames = await writeFrames(dir, screenshots, sources, inspected, glyphs);
            await writeExclusive(
              dir,
              "pointer-track.json",
              JSON.stringify(createPointerTrack(manifest.runId, records), null, 2) + "\n",
            );
            const output: EvidenceExportResult = {
              runId: manifest.runId,
              exportId,
              exportDir,
              frameCount: frames.length,
              annotatedCount: frames.filter((f) => f.annotated).length,
              pointerTrackPath: path.join(exportDir, "pointer-track.json"),
              videoPath: null,
              complete: true,
            };
            let video: ExportVideo | null = null;
            if (ffmpeg !== undefined) {
              try {
                video = await writeVideo(dir, ffmpeg, frames, frameMs);
              } catch (error) {
                return {
                  ...output,
                  complete: false,
                  videoError:
                    `${(error as Error).message}; frames and pointer track preserved ` +
                    `in incomplete export: ${exportDir}`,
                };
              }
              output.videoPath = path.join(exportDir, video.file);
            }
            const exportManifest: EvidenceExportManifest = {
              schema: "pickforge.evidence-export",
              version: 1,
              runId: manifest.runId,
              exportId,
              createdAt,
              runStatus: manifest.status,
              pointerGlyphVersion: POINTER_GLYPH_VERSION,
              journal: { bytes: journal.length, sha256: sha256(journal) },
              frames,
              skipped: inspected.skipped,
              pointerTrack: "pointer-track.json",
              video,
            };
            await writeExclusive(
              dir,
              "export.json",
              JSON.stringify(exportManifest, null, 2) + "\n",
            );
            return output;
          } catch (error) {
            throw new Error(`Export incomplete at ${exportDir}: ${(error as Error).message}`);
          }
        });
      });
    } finally {
      await screenshots?.close();
    }
  });
  if (result === undefined) {
    throw new Error("Run changed before export");
  }
  return result;
}
