import fs from "node:fs";
import path from "node:path";
import { DirHandle, RunStorageAccessError, withDirHandle } from "./dir-handle.js";
import { isMissing, openRunDirIn, verifyExistingRoot } from "./run-root.js";
import { redactSecrets } from "./redact.js";
import type { RunCatalog, RunCatalogEntry, RunCatalogRoot } from "./run-catalog.js";
import { latestOutcomeStatus } from "./evidence-outcome.js";

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

type JsonObject = Record<string, unknown>;
type StateValue = string | number | boolean;
/** Device state and versions recorded with one state of a schema v4 run. */
export interface RustEvidenceCapture {
  phase: "before" | "step" | "after";
  step?: string;
  capturedAt: string;
  appBuild: string;
  emulatorVersion: string;
  systemImage: string;
  requested: Record<string, StateValue>;
  observed: Record<string, StateValue>;
}
/** A UI tree, log or report entry. Its content is never read or rendered here. */
export interface RustEvidenceArtifact {
  phase: "before" | "step" | "after";
  step?: string;
  kind: string;
  origin: string;
  label: string;
  capturedAt: string;
  /** "missing" means the document lists a file this run directory does not hold. */
  status: "captured" | "unavailable" | "missing";
  path?: string;
  format?: string;
  bytes?: number;
  reason?: string;
}
export interface RustEvidenceRun {
  source: "rust";
  state: "valid" | "corrupt";
  runId: string;
  projectId: string;
  createdAt: string;
  scenario: string;
  outcome: "passed" | "failed" | "inconclusive" | "corrupt";
  stepCount: number;
  checks: Array<{ name: string; status: string; summary: string }>;
  limitations: string[];
  screenshots: string[];
  captures: RustEvidenceCapture[];
  artifacts: RustEvidenceArtifact[];
  dir: string;
  reportPath: string;
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject : {};
}
/** Terminal controls in a tampered document must not reach the report. */
function text(value: unknown): string {
  return typeof value === "string" ? redactSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ") : "";
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function safeName(value: string): boolean {
  return SAFE_NAME.test(value) && value !== "." && !value.includes("..");
}

async function readDocument(dir: DirHandle): Promise<unknown> {
  const handle = await dir.openFile("evidence.json",
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) throw new Error("Invalid evidence file");
    // Bound the read itself as well: a concurrent writer cannot grow it past the cap.
    const buffer = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_EVIDENCE_BYTES) throw new Error("Oversized evidence file");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function artifactExists(dir: DirHandle, name: string): Promise<boolean> {
  const parts = name.split("/");
  if (!parts.every(safeName)) return false;
  const isFile = async (parent: DirHandle, file: string): Promise<boolean> => {
    const stat = await parent.lstatChild(file);
    return stat !== undefined && stat.isFile() && !stat.isSymbolicLink();
  };
  try {
    if (parts.length === 1) return await isFile(dir, parts[0]!);
    if (parts.length !== 2 || parts[0] !== "artifacts") return false;
    return await withDirHandle(dir.openChild("artifacts"), child => isFile(child, parts[1]!));
  } catch {
    return false;
  }
}

async function screenshots(dir: DirHandle, doc: JsonObject): Promise<string[]> {
  const names = new Set<string>();
  for (const phase of [doc.before, ...array(doc.steps), doc.after]) {
    for (const item of array(object(phase).artifacts)) {
      const artifact = object(item);
      if (artifact.kind !== "screenshot" || typeof artifact.path !== "string") continue;
      if (await artifactExists(dir, artifact.path)) names.add(text(artifact.path));
    }
  }
  return [...names];
}

interface PhaseRef { phase: "before" | "step" | "after"; step?: string; value: JsonObject }
function phases(doc: JsonObject): PhaseRef[] {
  return [
    { phase: "before" as const, value: object(doc.before) },
    ...array(doc.steps).map(item => ({ phase: "step" as const, step: text(object(item).label), value: object(item) })),
    { phase: "after" as const, value: object(doc.after) },
  ];
}
function where(ref: PhaseRef): Pick<RustEvidenceCapture, "phase" | "step"> {
  return ref.step === undefined ? { phase: ref.phase } : { phase: ref.phase, step: ref.step };
}
function stateValues(value: unknown): Record<string, StateValue> {
  const values: Record<string, StateValue> = {};
  for (const [key, item] of Object.entries(object(value))) {
    if (!/^[A-Za-z]{1,32}$/.test(key)) continue;
    if (typeof item === "string") values[key] = text(item);
    else if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) values[key] = item;
  }
  return values;
}
/** Schema v1 to v3 documents have no capture records. */
function captures(doc: JsonObject): RustEvidenceCapture[] {
  return phases(doc).flatMap(ref => {
    if (typeof ref.value.capture !== "object" || ref.value.capture === null) return [];
    const capture = object(ref.value.capture);
    const field = (name: string) => typeof capture[name] === "string" ? text(capture[name]) : "unknown";
    return [{
      ...where(ref), capturedAt: field("capturedAt"), appBuild: field("appBuild"),
      emulatorVersion: field("emulatorVersion"), systemImage: field("systemImage"),
      requested: stateValues(capture.requested), observed: stateValues(capture.observed),
    }];
  });
}
async function textArtifact(dir: DirHandle, ref: PhaseRef, artifact: JsonObject): Promise<RustEvidenceArtifact> {
  const entry: RustEvidenceArtifact = {
    ...where(ref), kind: text(artifact.kind), origin: text(artifact.origin), label: text(artifact.label),
    capturedAt: typeof artifact.capturedAt === "string" ? text(artifact.capturedAt) : "unknown",
    status: "missing",
  };
  if (artifact.status === "unavailable") return { ...entry, status: "unavailable", reason: text(artifact.reason) };
  if (typeof artifact.path !== "string") return entry;
  const found = artifact.status === "captured" && await artifactExists(dir, artifact.path);
  return {
    ...entry, status: found ? "captured" : "missing", path: text(artifact.path), format: text(artifact.format),
    ...(typeof artifact.bytes === "number" ? { bytes: artifact.bytes } : {}),
  };
}

async function textArtifacts(dir: DirHandle, doc: JsonObject): Promise<RustEvidenceArtifact[]> {
  const artifacts: RustEvidenceArtifact[] = [];
  for (const ref of phases(doc)) {
    for (const item of array(ref.value.artifacts)) {
      const artifact = object(item);
      if (artifact.kind === "screenshot" || typeof artifact.kind !== "string") continue;
      artifacts.push(await textArtifact(dir, ref, artifact));
    }
  }
  return artifacts;
}

function validIdentity(doc: JsonObject, runId: string): boolean {
  if (typeof doc.schemaVersion !== "number" || ![1, 2, 3, 4].includes(doc.schemaVersion)) return false;
  if (doc.runId !== runId) return false;
  for (const field of ["projectId", "createdAt", "scenario"]) {
    if (typeof doc[field] !== "string") return false;
  }
  if (!Number.isFinite(Date.parse(doc.createdAt as string))) return false;
  return typeof doc.outcome === "string" &&
    ["passed", "failed", "inconclusive"].includes(doc.outcome);
}

/** Read through a pinned directory; malformed or unsafe evidence is a corrupt entry. */
async function readEvidenceIn(dir: DirHandle): Promise<RustEvidenceRun | undefined> {
  if (await dir.lstatChild("manifest.json") !== undefined) return undefined;
  if (await dir.lstatChild("evidence.json") === undefined) return undefined;
  const runId = path.basename(dir.dir);
  const report = await dir.lstatChild("report.md");
  const result: RustEvidenceRun = {
    source: "rust", state: "corrupt", runId: text(runId), projectId: "", createdAt: "",
    scenario: "", outcome: "corrupt", stepCount: 0, checks: [], limitations: [],
    screenshots: [], captures: [], artifacts: [], dir: text(dir.dir),
    reportPath: report?.isFile() === true && !report.isSymbolicLink() ? text(path.join(dir.dir, "report.md")) : "",
  };
  try {
    const doc = object(await readDocument(dir));
    if (!validIdentity(doc, runId)) return result;
    return {
      ...result, state: "valid", projectId: text(doc.projectId), createdAt: text(doc.createdAt),
      scenario: text(doc.scenario), outcome: doc.outcome as RustEvidenceRun["outcome"],
      stepCount: array(doc.steps).length,
      checks: array(doc.checks).map(item => {
        const check = object(item);
        return { name: text(check.name), status: text(check.status), summary: text(check.summary) };
      }),
      limitations: array(doc.limitations).filter(item => typeof item === "string").map(text),
      screenshots: await screenshots(dir, doc),
      captures: captures(doc),
      artifacts: await textArtifacts(dir, doc),
    };
  } catch {
    return result;
  }
}

/** Read a run path or an already confined directory without creating any files. */
export async function readRustEvidenceRun(dir: string | DirHandle): Promise<RustEvidenceRun | undefined> {
  if (typeof dir !== "string") return readEvidenceIn(dir);
  const absolute = path.resolve(dir);
  try {
    return await withDirHandle(DirHandle.open(absolute, { expectedRealDir: absolute }), readEvidenceIn);
  } catch {
    return undefined;
  }
}

async function readRoot(root: RunCatalogRoot): Promise<RustEvidenceRun[]> {
  const verified = await verifyExistingRoot(root);
  if (verified === undefined) return [];
  try {
    return await withDirHandle(DirHandle.open(root.dir, {
      expectedRealDir: root.expectedRealDir, expectedIdentity: verified.stat,
    }), async parent => {
      const runs: RustEvidenceRun[] = [];
      for (const name of (await parent.readEntryNames()).sort()) {
        if (!safeName(name) || name.startsWith(".")) continue;
        try {
          const run = await withDirHandle(openRunDirIn(parent, name), readRustEvidenceRun);
          if (run !== undefined) runs.push(run);
        } catch { /* Missing, replaced or linked directories are not runs. */ }
      }
      return runs;
    });
  } catch (error) {
    if (error instanceof RunStorageAccessError || isMissing(error)) return [];
    throw error;
  }
}

/** Pass the catalog's current entries to avoid a second manifest walk. */
export async function listRustEvidenceRuns(catalog: RunCatalog, entries?: RunCatalogEntry[]): Promise<RustEvidenceRun[]> {
  const runs = new Map<string, RustEvidenceRun>();
  const labIds = new Set((entries ?? await catalog.list()).map(entry => entry.manifest.runId));
  for (const root of catalog.roots) {
    for (const run of await readRoot(root)) {
      if (!runs.has(run.runId) && !labIds.has(run.runId)) runs.set(run.runId, run);
    }
  }
  return [...runs.values()].sort(compareRuns);
}

function compareRuns(left: { createdAt: string; runId: string }, right: { createdAt: string; runId: string }): number {
  const timestamp = (value: string): number => Date.parse(value) || 0;
  return timestamp(right.createdAt) - timestamp(left.createdAt) || left.runId.localeCompare(right.runId);
}

export async function listArtifactRuns(catalog: RunCatalog) {
  const entries = await catalog.list();
  // Journals are read one at a time so a listing never buffers more than one run's journal.
  const lab = [];
  for (const entry of entries) {
    lab.push({
      source: "lab" as const, runId: text(entry.manifest.runId), slug: text(entry.manifest.slug),
      createdAt: text(entry.manifest.createdAt), status: text(entry.manifest.status),
      artifacts: entry.manifest.artifacts.length, outcome: await latestOutcomeStatus(catalog, entry),
    });
  }
  const rust = (await listRustEvidenceRuns(catalog, entries)).map(run => ({
    source: run.source, runId: run.runId, slug: run.scenario, createdAt: run.createdAt,
    status: run.outcome, outcome: null,
    artifacts: run.screenshots.length + run.artifacts.filter(item => item.status === "captured").length,
  }));
  return [...lab, ...rust].sort(compareRuns);
}

export function renderRustEvidenceReport(run: RustEvidenceRun): string[] {
  return [
    `# Rust evidence: ${run.runId}`, `Scenario: ${run.scenario}`, `Outcome: ${run.outcome}`,
    `Steps: ${run.stepCount}`, "Checks:",
    ...run.checks.map(check => `- ${check.name}: ${check.status} ${check.summary}`),
    "Limitations:", ...run.limitations.map(item => `- ${item}`),
    ...(run.reportPath === "" ? [] : [`Report: ${run.reportPath}`]),
    "Screenshots:", ...run.screenshots.map(name => `- ${name}`),
    ...(run.captures.length === 0 ? [] : ["Captures:", ...run.captures.flatMap(captureLines)]),
    ...(run.artifacts.length === 0 ? [] : ["Artifacts:", ...run.artifacts.map(artifactLine)]),
  ];
}

function phaseName(item: { phase: string; step?: string }): string {
  return item.step === undefined ? item.phase : `step ${item.step}`;
}
function stateLine(values: Record<string, StateValue>): string {
  const pairs = Object.entries(values).map(([key, value]) => `${key} ${String(value)}`);
  return pairs.length === 0 ? "none" : pairs.join(", ");
}
function captureLines(capture: RustEvidenceCapture): string[] {
  return [
    `- ${phaseName(capture)}: captured at ${capture.capturedAt}; app build ${capture.appBuild}; ` +
      `emulator ${capture.emulatorVersion}; system image ${capture.systemImage}`,
    `  requested: ${stateLine(capture.requested)}`,
    `  observed: ${stateLine(capture.observed)}`,
  ];
}
function artifactLine(artifact: RustEvidenceArtifact): string {
  const head = `- ${phaseName(artifact)}: ${artifact.label} (${artifact.kind} from ${artifact.origin})`;
  if (artifact.status === "unavailable") return `${head}: unavailable at ${artifact.capturedAt}, ${artifact.reason ?? ""}`;
  if (artifact.status === "missing") return `${head}: missing ${artifact.path ?? ""}`.trimEnd();
  const size = artifact.bytes === undefined ? "" : `, ${artifact.bytes} bytes`;
  return `${head}: ${artifact.path}, ${artifact.format}${size}, captured at ${artifact.capturedAt}`;
}
