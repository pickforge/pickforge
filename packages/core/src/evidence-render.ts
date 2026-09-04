import path from "node:path";
import { RunStorageAccessError, type DirHandle } from "./dir-handle.js";
import { redactSecrets } from "./redact.js";
import { RunHandle, type RunManifest } from "./run.js";
import { withBoundRunDir } from "./run-root.js";
import {
  isEvidenceRun,
  isTruncationRecord,
  readActionsIn,
  type EvidenceAction,
  type EvidenceRecord,
} from "./evidence.js";

export const EVIDENCE_REPORT = "report.html";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordTimestamp(record: EvidenceRecord): string {
  return isTruncationRecord(record) ? record.recordedAt : record.startedAt;
}

export function sortEvidenceRecords(
  records: readonly EvidenceRecord[],
): EvidenceRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const byTime = compareText(
        recordTimestamp(left.record),
        recordTimestamp(right.record),
      );
      if (byTime !== 0) return byTime;
      const byId = compareText(left.record.actionId, right.record.actionId);
      return byId !== 0 ? byId : left.index - right.index;
    })
    .map(({ record }) => record);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    result[key] = stableValue((value as Record<string, unknown>)[key]);
  }
  return result;
}

function safeText(value: unknown): string {
  return redactSecrets(String(value));
}

function stableJson(value: unknown): string {
  return redactSecrets(JSON.stringify(stableValue(value)));
}

function actionTitle(action: EvidenceAction): string {
  return `${safeText(action.source)} / ${safeText(action.tool)}`;
}

export function renderRunReport(
  manifest: RunManifest,
  dir: string,
  records: readonly EvidenceRecord[] = [],
): string[] {
  const lines = [
    `# Pickforge run ${safeText(manifest.runId)}`,
    "",
    `- Slug: ${safeText(manifest.slug)}`,
    `- Status: ${safeText(manifest.status)}`,
    `- Created: ${safeText(manifest.createdAt)}`,
  ];
  if (manifest.sessionId !== undefined) {
    lines.push(`- Session: ${safeText(manifest.sessionId)}`);
  }
  lines.push(
    `- Directory: ${safeText(dir)}`,
    "",
    `## Artifacts (${manifest.artifacts.length})`,
    "",
  );
  if (manifest.artifacts.length === 0) {
    lines.push("(none)");
  }
  for (const artifact of manifest.artifacts) {
    lines.push(
      `- [${safeText(artifact.type)}] ${safeText(artifact.name)} — ` +
        `${safeText(artifact.path)} (${safeText(artifact.createdAt)})`,
    );
  }

  if (!isEvidenceRun(manifest)) return lines;

  const ordered = sortEvidenceRecords(records);
  lines.push("", `## Actions (${ordered.length})`, "");
  if (ordered.length === 0) {
    lines.push("(none)");
    return lines;
  }
  ordered.forEach((record, index) => {
    const step = index + 1;
    if (isTruncationRecord(record)) {
      lines.push(
        `### Step ${step} — Evidence truncated`,
        "",
        `- Recorded: ${safeText(record.recordedAt)}`,
        `- Bytes: ${record.bytes} / ${record.maxBytes}`,
        "",
      );
      return;
    }
    lines.push(
      `### Step ${step} — ${actionTitle(record)}`,
      "",
      `- Started: ${safeText(record.startedAt)}`,
      `- Status: ${safeText(record.status)}`,
    );
    if (record.sessionId !== undefined) {
      lines.push(`- Session: ${safeText(record.sessionId)}`);
    }
    if (record.durationMs !== undefined) {
      lines.push(`- Duration: ${record.durationMs} ms`);
    }
    if (record.target !== undefined) {
      lines.push(`- Target: ${stableJson(record.target)}`);
    }
    if (record.artifacts !== undefined && record.artifacts.length > 0) {
      lines.push(
        `- Artifacts: ${record.artifacts.map(safeText).join(", ")}`,
      );
    }
    if (record.error !== undefined) {
      lines.push(`- Error: ${safeText(record.error)}`);
    }
    lines.push("");
  });
  return lines;
}

function escapeHtml(value: unknown): string {
  return safeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMetadata(label: string, value: unknown): string {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

function safeScreenshotPath(value: string): boolean {
  return /^screenshots\/[A-Za-z0-9._-]+\.png$/.test(value) && !value.includes("..");
}

function renderAction(
  action: EvidenceAction,
  step: number,
  safeScreenshots: ReadonlySet<string>,
): string {
  const metadata = [
    renderMetadata("Started", action.startedAt),
    renderMetadata("Status", action.status),
  ];
  if (action.sessionId !== undefined) {
    metadata.push(renderMetadata("Session", action.sessionId));
  }
  if (action.durationMs !== undefined) {
    metadata.push(renderMetadata("Duration", `${action.durationMs} ms`));
  }
  if (action.target !== undefined) {
    metadata.push(renderMetadata("Target", stableJson(action.target)));
  }
  if (action.error !== undefined) {
    metadata.push(renderMetadata("Error", action.error));
  }

  const screenshots = (action.artifacts ?? [])
    .filter((artifact) => safeScreenshots.has(artifact))
    .map(
      (artifact) =>
        `<figure><img src="${escapeHtml(artifact)}" alt="Screenshot for step ${step}" loading="lazy"><figcaption>${escapeHtml(artifact)}</figcaption></figure>`,
    )
    .join("");

  return `<article class="step status-${escapeHtml(action.status)}">
<header><span class="step-number">Step ${step}</span><h2>${escapeHtml(actionTitle(action))}</h2></header>
<dl>${metadata.join("")}</dl>
${screenshots === "" ? "" : `<div class="filmstrip">${screenshots}</div>`}
</article>`;
}

export function renderEvidenceHtml(
  manifest: RunManifest,
  records: readonly EvidenceRecord[],
  safeScreenshots: ReadonlySet<string> = new Set(),
): string {
  const ordered = sortEvidenceRecords(records);
  const steps = ordered
    .map((record, index) => {
      const step = index + 1;
      if (!isTruncationRecord(record)) {
        return renderAction(record, step, safeScreenshots);
      }
      return `<article class="step status-truncated">
<header><span class="step-number">Step ${step}</span><h2>Evidence truncated</h2></header>
<dl>${renderMetadata("Recorded", record.recordedAt)}${renderMetadata("Bytes", `${record.bytes} / ${record.maxBytes}`)}</dl>
</article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pickforge run ${escapeHtml(manifest.runId)}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:960px;margin:0 auto;padding:2rem;line-height:1.5}header{display:flex;align-items:baseline;gap:.75rem}.summary,.step{border:1px solid #8886;border-radius:.75rem;padding:1rem;margin:1rem 0}.step-number{font-weight:700;white-space:nowrap}h1,h2{margin:.25rem 0}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}.filmstrip{display:grid;gap:1rem;margin-top:1rem}figure{margin:0}img{display:block;max-width:100%;height:auto;border:1px solid #8886;border-radius:.5rem}figcaption{font-size:.875rem;overflow-wrap:anywhere}.status-error,.status-timeout,.status-truncated{border-color:#b33}.empty{opacity:.7}
</style>
</head>
<body>
<main>
<section class="summary">
<h1>Pickforge run ${escapeHtml(manifest.runId)}</h1>
<dl>${renderMetadata("Slug", manifest.slug)}${renderMetadata("Status", manifest.status)}${renderMetadata("Created", manifest.createdAt)}${manifest.sessionId === undefined ? "" : renderMetadata("Session", manifest.sessionId)}</dl>
</section>
<section aria-label="Action timeline">
${steps === "" ? '<p class="empty">No recorded actions.</p>' : steps}
</section>
</main>
</body>
</html>
`;
}

async function openScreenshotsDir(
  runDir: DirHandle,
): Promise<DirHandle | undefined> {
  const stat = await runDir.lstatChild("screenshots");
  if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
    return undefined;
  }
  return runDir.openChild("screenshots");
}

async function collectSafeScreenshots(
  runDir: DirHandle,
  records: readonly EvidenceRecord[],
): Promise<Set<string>> {
  const safe = new Set<string>();
  const screenshots = await openScreenshotsDir(runDir);
  if (screenshots === undefined) return safe;
  const candidates = new Set(
    records.flatMap((record) =>
      isTruncationRecord(record) ? [] : (record.artifacts ?? []),
    ),
  );
  try {
    for (const relative of candidates) {
      if (!safeScreenshotPath(relative)) continue;
      const name = relative.slice("screenshots/".length);
      const stat = await screenshots.lstatChild(name);
      if (stat?.isFile() === true && !stat.isSymbolicLink()) safe.add(relative);
    }
  } finally {
    await screenshots.close().catch(() => {});
  }
  return safe;
}

export async function writeEvidenceReport(
  run: RunHandle,
  manifest: RunManifest = run.manifest,
): Promise<string> {
  if (!(run instanceof RunHandle)) {
    throw new RunStorageAccessError(
      "writeEvidenceReport requires a verified RunHandle; run directory paths are refused",
    );
  }
  if (!isEvidenceRun(manifest)) {
    throw new Error(`Run ${manifest.runId} is not an evidence run`);
  }
  if (manifest.runId !== run.runId) {
    throw new RunStorageAccessError(
      `Refusing report manifest ${manifest.runId} for run ${run.runId}`,
    );
  }
  await withBoundRunDir(run.binding, async (runDir) => {
    const records = await readActionsIn(runDir);
    const safeScreenshots = await collectSafeScreenshots(runDir, records);
    const html = renderEvidenceHtml(manifest, records, safeScreenshots);
    await runDir.writeFileAtomic(EVIDENCE_REPORT, html);
  });
  return path.join(run.dir, EVIDENCE_REPORT);
}
