import type { DirHandle } from "./dir-handle.js";
import { EVIDENCE_ACTION_LOG } from "./run.js";
import { appendAction, isEvidenceRun, isTruncationRecord, parseActionsJournal, readActionsIn, readEvidenceManifestIn, type EvidenceRecord } from "./evidence.js";
import { redactSecrets } from "./redact.js";
import { writeEvidenceReport } from "./evidence-render.js";
import { adoptRunIn } from "./run.js";
import { withExistingRunsRootDir } from "./run-root.js";
import { openRunCatalog, type RunCatalog, type RunCatalogEntry } from "./run-catalog.js";
import type { EnvLike } from "./paths.js";

export interface EvidenceOutcomeInput {
  scenario: string;
  status: "pass" | "fail" | "partial" | "blocked";
  revision?: string;
  steps?: string[];
  inspectedScreenshots: string[];
  limitations?: string[];
  notes?: string;
}

export interface EvidenceOutcomeRecord extends EvidenceOutcomeInput {
  kind: "outcome";
  actionId?: never;
  recordedAt: string;
}

export class EvidenceOutcomeError extends Error {
  override name = "EvidenceOutcomeError";
  constructor(message: string, readonly missingScreenshots: string[] = []) {
    super(message);
  }
}

export function isOutcomeRecord(record: EvidenceRecord): record is EvidenceOutcomeRecord {
  return "kind" in record && record.kind === "outcome";
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validOutcomeFields(record: Record<string, unknown>): boolean {
  if (![record.recordedAt, record.scenario, record.status].every((value) => typeof value === "string")) return false;
  if (!["pass", "fail", "partial", "blocked"].includes(record.status as string)) return false;
  if (!stringList(record.inspectedScreenshots)) return false;
  if (![record.steps, record.limitations].every((value) => value === undefined || stringList(value))) return false;
  return [record.revision, record.notes].every((value) => value === undefined || typeof value === "string");
}

function cappedText(text: string, cap: number): string {
  return redactSecrets(text).slice(0, cap);
}

/** Callers may supply `recordedAt`; only a short, well-formed ISO timestamp is persisted. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Oversize lists are refused rather than truncated, so a caller never believes a trimmed record. */
function assertOutcomeLimits(input: EvidenceOutcomeInput, recordedAt: string): void {
  if (!validOutcomeFields({ ...input, recordedAt })) throw new EvidenceOutcomeError("Invalid evidence outcome fields");
  if (recordedAt.length > 40 || !ISO_TIMESTAMP.test(recordedAt) || Number.isNaN(Date.parse(recordedAt))) {
    throw new EvidenceOutcomeError("Invalid evidence outcome timestamp");
  }
  if (input.inspectedScreenshots.length > 64) throw new EvidenceOutcomeError("At most 64 inspected screenshots are allowed");
  if ((input.steps?.length ?? 0) > 32) throw new EvidenceOutcomeError("At most 32 steps are allowed");
  if ((input.limitations?.length ?? 0) > 32) throw new EvidenceOutcomeError("At most 32 limitations are allowed");
}

export function sanitizeOutcome(input: EvidenceOutcomeInput, recordedAt = new Date().toISOString()): EvidenceOutcomeRecord {
  assertOutcomeLimits(input, recordedAt);
  const record: EvidenceOutcomeRecord = {
    kind: "outcome", recordedAt,
    scenario: cappedText(input.scenario, 200), status: input.status,
    inspectedScreenshots: [...input.inspectedScreenshots],
  };
  if (input.revision !== undefined) record.revision = cappedText(input.revision, 128);
  if (input.notes !== undefined) record.notes = cappedText(input.notes, 512);
  if (input.steps !== undefined) record.steps = input.steps.map((text) => cappedText(text, 512));
  if (input.limitations !== undefined) record.limitations = input.limitations.map((text) => cappedText(text, 512));
  return record;
}

/**
 * Tool names producers actually persist for input that changes the app under
 * test. Pointer moves and pure observation (screenshots, UI trees, logcat,
 * launch, exec, listings) are deliberately absent.
 */
const INTERACTION_TOOLS: ReadonlySet<string> = new Set([
  "desktop_click", "desktop_double_click", "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key",
  "android_tap", "android_type", "android_back", "android_home",
  ...["click", "click_at", "drag", "fill", "fill_form", "handle_dialog", "hover", "navigate_page", "press_key", "type_text", "upload_file"]
    .map((name) => `chrome_devtools/${name}`),
]);

function successfulInteraction(record: EvidenceRecord): boolean {
  return !isOutcomeRecord(record) && !isTruncationRecord(record) && record.status === "ok" && INTERACTION_TOOLS.has(record.tool);
}

async function missingScreenshots(dir: DirHandle, names: string[]): Promise<string[]> {
  const stat = await dir.lstatChild("screenshots");
  if (stat?.isDirectory() !== true || stat.isSymbolicLink()) return names;
  const screenshots = await dir.openChild("screenshots");
  try {
    const missing: string[] = [];
    for (const relative of names) {
      if (!/^screenshots\/[A-Za-z0-9._-]+\.png$/.test(relative)) {
        missing.push(relative);
        continue;
      }
      const file = await screenshots.lstatChild(relative.slice("screenshots/".length));
      if (file?.isFile() !== true || file.isSymbolicLink() || file.nlink !== 1) missing.push(relative);
    }
    return missing;
  } finally {
    await screenshots.close();
  }
}

/** Called under the journal lock, before the existing append path writes. */
export async function validateOutcomeIn(dir: DirHandle, record: EvidenceOutcomeRecord): Promise<void> {
  const missing = await missingScreenshots(dir, record.inspectedScreenshots);
  if (missing.length > 0) {
    const safeNames = missing.map((name) => cappedText(name, 512));
    throw new EvidenceOutcomeError(`Missing or unsafe inspected screenshots: ${safeNames.join(", ")}`, safeNames);
  }
  const inspected = record.inspectedScreenshots.length > 0;
  if (record.status === "partial" && !inspected) throw new EvidenceOutcomeError("A partial outcome requires an inspected screenshot");
  if (record.status === "pass") {
    const status = (await readEvidenceManifestIn(dir)).status;
    if (status !== "running" && status !== "completed") {
      throw new EvidenceOutcomeError("pass is not allowed on an orphaned or failed run");
    }
  }
  if (record.status === "pass" && (!inspected || !(await readActionsIn(dir)).some(successfulInteraction))) {
    throw new EvidenceOutcomeError("Recording alone does not establish acceptance: pass requires a successful interaction and an inspected screenshot");
  }
}

export async function recordEvidenceOutcome(projectDir: string, runId: string, input: EvidenceOutcomeInput, env: EnvLike = process.env): Promise<EvidenceOutcomeRecord> {
  const catalog = await openRunCatalog(projectDir, env);
  const entry = await catalog.find(runId);
  if (entry === undefined || !isEvidenceRun(entry.manifest)) throw new EvidenceOutcomeError(`Evidence run not found: ${cappedText(runId, 128)}`);
  // Adoption must use the selected writable root, never a legacy catalog fallback.
  const run = await withExistingRunsRootDir(projectDir, env, async (root) => {
    if (root === undefined || root.dir !== entry.rootDir) {
      throw new EvidenceOutcomeError("Cannot append to a legacy catalog fallback");
    }
    return adoptRunIn(root, runId, entry.manifest);
  });
  const record = sanitizeOutcome(input);
  await appendAction(run, record);
  const manifest = await run.readManifest();
  if (manifest.status !== "running") await writeEvidenceReport(run, manifest);
  return record;
}

/** Latest outcome record among already-parsed journal records, or null. */
export function latestOutcome(records: readonly EvidenceRecord[]): EvidenceOutcomeRecord | null {
  return records.filter(isOutcomeRecord).at(-1) ?? null;
}

/** Latest recorded outcome status for a catalog entry, or null when absent or unreadable. */
export async function latestOutcomeStatus(catalog: RunCatalog, entry: RunCatalogEntry): Promise<EvidenceOutcomeRecord["status"] | null> {
  if (!isEvidenceRun(entry.manifest) || entry.manifest.evidenceRecovery === "corrupt") return null;
  try {
    const raw = await catalog.readRootTextIfPresent(entry, EVIDENCE_ACTION_LOG);
    if (raw === undefined) return null;
    return latestOutcome(parseActionsJournal(raw, entry.dir))?.status ?? null;
  } catch {
    return null;
  }
}
