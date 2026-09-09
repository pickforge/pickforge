import fs from "node:fs";
import path from "node:path";
import { DirHandle, withDirHandle } from "./dir-handle.js";
import { openRunDirIn, verifyExistingRoot } from "./run-root.js";
import { redactSecrets } from "./redact.js";
import type { RunCatalog, RunCatalogRoot } from "./run-catalog.js";

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

type JsonObject = Record<string, unknown>;
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
  dir: string;
  reportPath: string;
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? redactSecrets(value) : "";
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

async function screenshotExists(dir: DirHandle, name: string): Promise<boolean> {
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
      if (await screenshotExists(dir, artifact.path)) names.add(text(artifact.path));
    }
  }
  return [...names];
}

function validIdentity(doc: JsonObject, runId: string): boolean {
  if (typeof doc.schemaVersion !== "number" || ![1, 2, 3].includes(doc.schemaVersion)) return false;
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
  const result: RustEvidenceRun = {
    source: "rust", state: "corrupt", runId: text(runId), projectId: "", createdAt: "",
    scenario: "", outcome: "corrupt", stepCount: 0, checks: [], limitations: [],
    screenshots: [], dir: text(dir.dir), reportPath: text(path.join(dir.dir, "report.md")),
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
        if (!safeName(name)) continue;
        try {
          const run = await withDirHandle(openRunDirIn(parent, name), readRustEvidenceRun);
          if (run !== undefined) runs.push(run);
        } catch { /* Missing, replaced or linked directories are not runs. */ }
      }
      return runs;
    });
  } catch {
    return [];
  }
}

export async function listRustEvidenceRuns(catalog: RunCatalog): Promise<RustEvidenceRun[]> {
  const runs = new Map<string, RustEvidenceRun>();
  const labIds = new Set((await catalog.list()).map(entry => entry.manifest.runId));
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
  const lab = (await catalog.list()).map(({ manifest }) => ({
    source: "lab" as const, runId: text(manifest.runId), slug: text(manifest.slug),
    createdAt: text(manifest.createdAt), status: text(manifest.status), artifacts: manifest.artifacts.length,
  }));
  const rust = (await listRustEvidenceRuns(catalog)).map(run => ({
    source: run.source, runId: run.runId, slug: run.scenario, createdAt: run.createdAt,
    status: run.outcome, artifacts: run.screenshots.length,
  }));
  return [...lab, ...rust].sort(compareRuns);
}

export function renderRustEvidenceReport(run: RustEvidenceRun): string[] {
  return [
    `# Rust evidence: ${run.runId}`, `Scenario: ${run.scenario}`, `Outcome: ${run.outcome}`,
    `Steps: ${run.stepCount}`, "Checks:",
    ...run.checks.map(check => `- ${check.name}: ${check.status} ${check.summary}`),
    "Limitations:", ...run.limitations.map(item => `- ${item}`),
    `Report: ${run.reportPath}`, "Screenshots:", ...run.screenshots.map(name => `- ${name}`),
  ].map(redactSecrets);
}
