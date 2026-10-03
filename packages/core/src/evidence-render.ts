import { readBoundedFileIn } from "./bounded-read.js";
import type { RunCatalog, RunCatalogEntry } from "./run-catalog.js";
import { createHash } from "node:crypto";
import zlib, { crc32 } from "node:zlib";
import {
  isOutcomeRecord,
  type EvidenceOutcomeRecord,
} from "./evidence-outcome.js";
import path from "node:path";
import { assertSafeEntryName, RunStorageAccessError, type DirHandle } from "./dir-handle.js";
import { redactSecrets } from "./redact.js";
import { isSafeScreenshotPath as safeScreenshotPath, sanitizeActionTarget, sanitizeCaptureLinks } from "./evidence-sanitize.js";
import {
  EVIDENCE_ACTION_LOG,
  RunHandle,
  type EvidenceDevice,
  type RunArtifact,
  type RunManifest,
} from "./run.js";
import { withBoundRunDir } from "./run-root.js";
import {
  isEvidenceRun,
  isTruncationRecord,
  readActionsIn,
  readEvidenceManifestIn,
  withJournalLock,
  type EvidenceAction,
  type EvidenceCaptureLink,
  type EvidenceRecord,
} from "./evidence.js";
import type { RecoveredEvidenceRun } from "./evidence-recovery.js";

export const EVIDENCE_REPORT = "report.html";
export const EVIDENCE_SHARE_REPORT = "report-share.html";
export const MAX_SHARE_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_SHARE_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_SHARE_INFLATED_IMAGE_BYTES = 1024 * 1024 * 1024;

interface ShareImages {
  hashes: Map<string, string>;
  payloads: Record<string, string>;
  bytes: number;
  omitted: Map<string, string>;
}

/** Inspect metadata only; the large share report never travels through MCP. */
export async function evidenceShareReportInfo(
  catalog: RunCatalog, entry: RunCatalogEntry,
): Promise<{ shareReportPath: string | null; shareReportBytes: number | null }> {
  const bytes = await catalog.withRunDir(entry, async (dir) => {
    const stat = await dir.lstatChild(EVIDENCE_SHARE_REPORT);
    return stat?.isFile() === true && !stat.isSymbolicLink() && stat.nlink === 1 ? stat.size : null;
  });
  return {
    shareReportPath: bytes == null ? null : path.join(entry.dir, EVIDENCE_SHARE_REPORT),
    shareReportBytes: bytes ?? null,
  };
}

/** One stable entry point for a session's process-scoped evidence runs. */
export function renderEvidenceSessionIndex(
  sessionId: string,
  runs: readonly RecoveredEvidenceRun[],
): string {
  const rows = runs
    .map((run) =>
      `<li><a href="${escapeHtml(run.runId)}/${EVIDENCE_REPORT}">${escapeHtml(run.runId)}</a>: ${escapeHtml(run.status)}, ${run.actions} records, journal ${escapeHtml(run.journal)}${run.warning === undefined ? "" : `, ${escapeHtml(run.warning)}`}</li>`,
    )
    .join("\n");
  // The session index CSP is meta-delivered, so it must not carry
  // frame-ancestors: browsers ignore that directive in <meta> policies.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pickforge session ${escapeHtml(sessionId)}</title></head>
<body><h1>Pickforge session ${escapeHtml(sessionId)}</h1>
<p>Recovery snapshot. Runs remain in place, ordered by run id. Orphaned means the owner was unavailable, not successful completion. Journals are unchanged.</p>
<ul>${rows}</ul></body></html>\n`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordTimestamp(record: EvidenceRecord): string {
  return (isTruncationRecord(record) || isOutcomeRecord(record)) ? record.recordedAt : record.startedAt;
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
      const byId = compareText(isOutcomeRecord(left.record) ? "" : left.record.actionId, isOutcomeRecord(right.record) ? "" : right.record.actionId);
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
  if (manifest.device !== undefined) lines.push(`- Device: ${stableJson(manifest.device)}`);
  const outcome = records.filter(isOutcomeRecord).at(-1);
  if (outcome !== undefined) lines.push(`- Outcome: ${safeText(outcome.status)}; ${safeText(outcome.scenario)}; ${outcome.inspectedScreenshots.length} inspected screenshot(s)`);
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

  const warning = recoveryWarning(manifest, records);
  if (warning !== "") lines.push("", warning);
  const ordered = timelineRecords(records);
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

function recoveryWarning(
  manifest: RunManifest,
  records: readonly EvidenceRecord[] = [],
): string {
  if (manifest.evidenceRecovery === "missing") {
    return "Journal is corrupt or missing. Timeline unavailable; original evidence was not changed.";
  }
  if (manifest.evidenceRecovery === "corrupt") {
    if (records.length === 0) {
      return "Journal is corrupt or missing. Timeline unavailable; original evidence was not changed.";
    }
    return `journal corrupt after record ${records.length}`;
  }
  if (manifest.evidenceRecovery === "torn-tail") {
    return "Interrupted final journal line omitted from this report, preserved in actions.jsonl.";
  }
  return manifest.status === "orphaned"
    ? "Owner unavailable. Recovered evidence is not a successful completion."
    : "";
}

function escapeHtml(value: unknown): string {
  return safeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Records that carry a step in the timeline. Outcome records are acceptance
 * metadata, not steps, so they are partitioned out before step numbering.
 */
type TimelineRecord = Exclude<EvidenceRecord, EvidenceOutcomeRecord>;

function timelineRecords(records: readonly EvidenceRecord[]): TimelineRecord[] {
  const timeline = records.filter(
    (record): record is TimelineRecord => !isOutcomeRecord(record),
  );
  // Sorting preserves membership, and `timeline` holds no outcome records.
  return sortEvidenceRecords(timeline) as TimelineRecord[];
}

type Lens = "desktop" | "mobile" | "android";

const LENS_LABELS: ReadonlyArray<readonly [Lens, string]> = [
  ["desktop", "Desktop"],
  ["mobile", "Mobile"],
  ["android", "Android emulator"],
];

const OUTCOME_LABELS: Record<string, string> = {
  pass: "Pass",
  fail: "Fail",
  partial: "Partial",
  blocked: "Blocked",
  unknown: "Unknown",
};

const OUTCOME_NOTE: Record<string, string> = {
  pass: "Accepted after inspecting the captures below.",
  fail: "Rejected. The captures below show the failure.",
  partial: "Partly accepted. Unverified parts are listed as limitations.",
  blocked: "Could not be verified. Nothing here establishes a pass.",
  unknown: "Outcome status not recognised. Treat this run as unverified.",
};

const NO_OUTCOME =
  "No acceptance outcome recorded. Recording alone does not establish a pass.";

const EMPTY_RUN =
  "No actions were recorded in this run. An empty run is evidence of nothing.";

const TRUNCATED_RUN =
  "Recording stopped at the evidence cap. Actions after the truncation marker are missing from this report.";

/**
 * The one pinned script. Kept literal so its sha256 is stable, and limited to
 * text search plus arrow-key browsing. Filters, capture inspection, and the
 * navigation links keep working without it; only search and the arrow keys
 * need it, and the live "shown" count is hidden while it is blocked.
 */
const REPORT_SCRIPT = `(() => {
const doc = document;
doc.body.classList.add("js");
const box = doc.getElementById("search");
const cards = Array.prototype.slice.call(doc.querySelectorAll("[data-search]"));
const shown = doc.getElementById("match-count");
const none = doc.getElementById("no-match");
const radios = Array.prototype.slice.call(doc.querySelectorAll(".lens-input, .scn-input"));
const chosen = (selector, cut) => {
  const on = doc.querySelector(selector);
  return on ? on.id.slice(cut) : "all";
};
const passes = (card, attribute, value) => {
  const own = card.getAttribute(attribute);
  if (value === "all" || own === null) return true;
  return own.split(" ").indexOf(value) >= 0;
};
const apply = () => {
  const query = box.value.toLowerCase().trim();
  const lens = chosen(".lens-input:checked", 5);
  const scenario = chosen(".scn-input:checked", 4);
  let captures = 0;
  let steps = 0;
  cards.forEach((card) => {
    const hit = query === "" || card.getAttribute("data-search").indexOf(query) >= 0;
    card.hidden = !hit;
    if (!hit) return;
    if (!passes(card, "data-lens", lens)) return;
    if (!passes(card, "data-scenario", scenario)) return;
    if (card.classList.contains("cap")) captures += 1;
    else steps += 1;
  });
  shown.textContent = String(captures);
  const narrowed = query !== "" || lens !== "all" || scenario !== "all";
  none.hidden = captures > 0 || !narrowed;
  none.textContent =
    steps === 0
      ? "Nothing matches the current search and filters."
      : "No captures match. " + String(steps) + " timeline step(s) still match.";
};
box.addEventListener("input", apply);
radios.forEach((radio) => radio.addEventListener("change", apply));
apply();
doc.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const active = doc.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
  const open = doc.querySelector(".inspect:target");
  if (!open) return;
  const step = open.querySelector(event.key === "ArrowRight" ? ".go-next" : ".go-prev");
  if (!step || !step.getAttribute("href")) return;
  event.preventDefault();
  location.hash = step.getAttribute("href");
});
})();`;

// Hashes and base64 contain no markup or secret-bearing text.
const SHARE_REPORT_SCRIPT = `(() => {
const payloads = JSON.parse(document.getElementById("image-data").textContent);
document.querySelectorAll("img[data-img]").forEach((img) => {
  img.src = "data:image/png;base64," + payloads[img.getAttribute("data-img")];
});
})();
` + REPORT_SCRIPT;

const REPORT_STYLE = `:root{color-scheme:dark;--bg:#0A0A0B;--p1:#0F0F11;--p2:#141417;--text:#F2F2F3;--muted:#6E6E75;--dim:#A4A4AB;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);--ember:#FF7A1A;--pass:#55C993;--fail:#E77B86;--partial:#D9A441;--blocked:#9494B0;--unknown:#9494B0}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 Geist,Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}
a{color:inherit}
.mono,.eyebrow,.brand,.count,.pill{font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
:focus-visible{outline:2px solid var(--ember);outline-offset:3px}
.lens-input,.scn-input,.zoom{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.topbar{display:flex;align-items:center;gap:12px;height:60px;padding:0 24px;border-bottom:1px solid var(--line);background:var(--p1)}
.mark{width:24px;height:24px;color:var(--ember);flex:none}
.brand{font-size:11px;font-weight:600;letter-spacing:.14em}
.brand span{color:var(--muted)}
.cols{display:grid;grid-template-columns:232px minmax(0,1fr);max-width:1560px;margin:0 auto}
.sidebar{border-right:1px solid var(--line);padding:28px 16px;min-height:calc(100vh - 60px)}
.eyebrow{display:block;color:var(--muted);font-size:10px;letter-spacing:.16em;text-transform:uppercase;margin:0 0 10px}
.sidebar label{display:flex;align-items:center;gap:8px;min-height:38px;padding:6px 12px;margin:2px 0;border:1px solid transparent;border-radius:8px;cursor:pointer;color:var(--dim)}
.sidebar label:hover{border-color:var(--line2)}
.count{margin-left:auto;font-size:11px;color:var(--muted)}
.sidebar hr{border:0;border-top:1px solid var(--line);margin:22px 0}
main{padding:32px 36px 64px;min-width:0}
h1{font-size:clamp(24px,3vw,34px);letter-spacing:-.03em;font-weight:600;margin:4px 0 16px}
h2{font-size:15px;font-weight:600;margin:0}
.panel{border:1px solid var(--line);border-radius:14px;background:var(--p1);padding:18px 20px;margin:0 0 20px}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 20px;margin:0}
dt{color:var(--muted);font-size:12px}
dd{margin:0;overflow-wrap:anywhere;font-size:13px}
.pill{display:inline-flex;align-items:center;gap:7px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:5px 9px;border-radius:999px;border:1px solid currentColor}
.pill::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}
.outcome{border-left:2px solid currentColor}
.outcome p{margin:8px 0 0;color:var(--dim);font-size:13px}
.outcome ul{margin:8px 0 0;padding-left:18px;color:var(--dim);font-size:13px}
.s-pass{color:var(--pass)}.s-fail{color:var(--fail)}.s-partial{color:var(--partial)}.s-blocked{color:var(--blocked)}.s-unknown{color:var(--unknown)}.s-none{color:var(--dim)}
.outcome h2,.outcome dd{color:var(--text)}
.warn{border:1px solid var(--partial);border-radius:10px;padding:12px 16px;margin:0 0 12px;color:var(--partial);font-size:13px}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:26px 0 14px}
.search-wrap{display:flex;align-items:center;gap:8px}
body:not(.js) .search-wrap,body:not(.js) .js-only{display:none}
#search{background:var(--p1);border:1px solid var(--line2);border-radius:8px;padding:9px 12px;color:var(--text);font:inherit;font-size:12px;width:220px;max-width:100%}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.cap{margin:0;border:1px solid var(--line);border-radius:12px;background:var(--p1);overflow:hidden}
.cap:hover{border-color:var(--line2)}
.cap a{display:block;text-decoration:none}
.stage{height:170px;background:var(--p2);display:flex;align-items:center;justify-content:center;padding:10px;overflow:hidden}
.stage img{max-width:100%;max-height:100%;object-fit:contain;object-position:top}
figcaption{padding:12px;font-size:12px;line-height:1.5;color:var(--dim)}
figcaption b{display:block;color:var(--text);font-weight:550;overflow-wrap:anywhere}
figcaption .mono{display:block;margin-top:4px;font-size:10px;color:var(--muted);overflow-wrap:anywhere}
.cap[data-lens="mobile"] .stage,.cap[data-lens="android"] .stage{height:220px}
.step{border:1px solid var(--line);border-radius:12px;background:var(--p1);padding:16px 18px;margin:0 0 10px}
.step header{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}
.step-number{font-family:'Geist Mono',ui-monospace,monospace;font-size:11px;color:var(--muted);white-space:nowrap}
.step h2{font-size:14px;font-weight:550}
.shots{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;font-size:12px}
.shots a{color:var(--dim)}
.status-error,.status-timeout,.status-truncated{border-color:var(--fail)}
.empty{padding:28px;text-align:center;color:var(--dim);border:1px dashed var(--line2);border-radius:12px}
footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}
.inspect{display:none}
.inspect:target{display:flex;flex-direction:column;position:fixed;inset:0;z-index:20;background:var(--p1)}
.inspect-bar,.inspect-foot{display:flex;align-items:center;gap:10px;padding:10px 16px;font-size:12px;color:var(--dim)}
.inspect-bar{border-bottom:1px solid var(--line)}
.inspect-foot{border-top:1px solid var(--line);justify-content:space-between}
.btn{display:inline-flex;align-items:center;min-height:36px;padding:6px 12px;border:1px solid var(--line2);border-radius:8px;background:var(--p2);color:var(--text);text-decoration:none;font-size:12px;cursor:pointer}
.btn:hover{border-color:var(--ember)}
.btn[aria-disabled="true"]{color:var(--muted);border-color:var(--line);cursor:default}
.inspect-bar .grow{margin-left:auto}
.zoom:focus-visible~.inspect-bar label{outline:2px solid var(--ember);outline-offset:2px}
.zoom:checked~.inspect-bar label{border-color:var(--ember);color:var(--ember)}
.inspect-stage{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;justify-content:center;align-items:flex-start;background:var(--bg)}
.inspect-stage img{max-width:100%;max-height:100%;object-fit:contain}
.zoom:checked~.inspect-stage{display:block}
.zoom:checked~.inspect-stage img{max-width:none;max-height:none;width:auto}
@media (max-width:900px){.cols{display:block}.sidebar{min-height:0;border-right:0;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px}.sidebar .eyebrow,.sidebar hr{display:none}.sidebar label{width:auto;min-height:44px}main{padding:24px 16px 48px}.toolbar{flex-direction:column;align-items:stretch}#search{width:100%}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}`;

/** Emitted only when a pointer marker renders, so unmarked reports keep their bytes. */
const MARKER_STYLE = `.marker-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.marker-label{margin-right:auto}
.pointer-note{display:block}
.framed{container-type:size}
.image-frame{position:relative;display:block;flex:none;width:min(100cqw,calc(100cqh * var(--w) / var(--h)),calc(var(--w) * 1px));aspect-ratio:var(--w) / var(--h)}
.image-frame img{display:block;width:100%;height:100%;max-width:none;max-height:none}
.zoom:checked~.inspect-stage .image-frame{width:calc(var(--w) * 1px)}
.zoom:checked~.inspect-stage .image-frame img{width:100%;height:100%}
.pointer-line{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.pointer-line line{stroke:var(--ember);stroke-width:2;stroke-linecap:round}
.pointer-line .halo{stroke:var(--bg);stroke-width:4}
.pointer-ring,.pointer-dot{position:absolute;left:var(--x);top:var(--y);border-radius:50%;transform:translate(-50%,-50%);pointer-events:none}
.pointer-ring{width:16px;height:16px;border:2px solid var(--ember);box-shadow:0 0 0 1px var(--bg),inset 0 0 0 1px var(--bg)}
.pointer-dot{width:6px;height:6px;background:var(--ember);box-shadow:0 0 0 1px var(--bg)}
.attempted .pointer-ring{border-style:dashed}
.attempted .pointer-line line{stroke-dasharray:6 4;stroke-linecap:butt}
#markers:not(:checked)~.shell .pointer,#markers:not(:checked)~.inspect .pointer{display:none}
`;

function renderMetadata(label: string, value: unknown): string {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

function outcomeStatus(value: unknown): string {
  return value === "pass" || value === "fail" || value === "partial" || value === "blocked"
    ? value
    : "unknown";
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function sortOutcomes(outcomes: readonly EvidenceOutcomeRecord[]): EvidenceOutcomeRecord[] {
  return outcomes
    .map((outcome, index) => ({ outcome, index }))
    .sort((left, right) => {
      const byTime = compareText(
        String(left.outcome.recordedAt),
        String(right.outcome.recordedAt),
      );
      if (byTime !== 0) return byTime;
      const byName = compareText(
        String(left.outcome.scenario),
        String(right.outcome.scenario),
      );
      return byName !== 0 ? byName : left.index - right.index;
    })
    .map(({ outcome }) => outcome);
}

function deviceLens(device: EvidenceDevice | undefined): Lens {
  const kind = deviceKind(device?.kind);
  if (kind === "emulator") return "android";
  return kind === "mobile-emulation" || kind === "physical" ? "mobile" : "desktop";
}

function actionLens(action: EvidenceAction, fallback: Lens): Lens {
  const tool = String(action.tool);
  if (tool.startsWith("android_")) return "android";
  if (tool.startsWith("desktop_")) return "desktop";
  return fallback;
}

function shortText(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * The search index is matched case-insensitively, so it must be redacted
 * before it is lowercased: several credential patterns are case-sensitive and
 * would survive a lowercase-first pass.
 */
function searchAttribute(parts: readonly string[]): string {
  return escapeHtml(parts.map(safeText).join(" ").toLowerCase());
}

const DEVICE_KINDS: ReadonlySet<string> = new Set([
  "desktop",
  "mobile-emulation",
  "physical",
  "emulator",
  "unknown",
]);

/**
 * Device metadata arrives from a journal on disk, so every field is validated
 * at runtime. Anything malformed renders as "unknown" rather than crashing the
 * finalizer or printing a half-value.
 */
function deviceKind(value: unknown): string {
  return typeof value === "string" && DEVICE_KINDS.has(value) ? value : "unknown";
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function viewportText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "unknown";
  const { width, height } = value as { width?: unknown; height?: unknown };
  return positiveInteger(width) && positiveInteger(height)
    ? `${String(width)}x${String(height)}`
    : "unknown";
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "unknown";
}

function booleanText(value: unknown): string {
  if (value === true) return "yes";
  return value === false ? "no" : "unknown";
}

function stringText(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : "unknown";
}

function deviceRows(device: EvidenceDevice | undefined): string {
  const fields = (device ?? {}) as Record<string, unknown>;
  return [
    renderMetadata("Device", deviceKind(fields.kind)),
    renderMetadata("Viewport", viewportText(fields.viewport)),
    renderMetadata("Image", viewportText(fields.image)),
    renderMetadata("Scale", numberText(fields.scale)),
    renderMetadata("Coordinates", stringText(fields.coordinateSpace)),
    renderMetadata("Touch", booleanText(fields.touch)),
    renderMetadata("Browser", stringText(fields.browser)),
    renderMetadata("Platform", stringText(fields.platform)),
  ].join("");
}

function renderSummary(
  manifest: RunManifest,
  latest: EvidenceOutcomeRecord | undefined,
): string {
  return `<section class="panel" aria-label="Run summary">
<h1>Run ${escapeHtml(manifest.runId)}</h1>
<dl>${renderMetadata("Project", manifest.slug)}${renderMetadata("Status", manifest.status)}${renderMetadata("Created", manifest.createdAt)}${renderMetadata("Session", manifest.sessionId ?? "unknown")}${deviceRows(manifest.device)}${renderMetadata("Revision", stringText(latest?.revision))}${renderMetadata("Scenario", stringText(latest?.scenario))}</dl>
</section>`;
}

function renderOutcome(outcome: EvidenceOutcomeRecord, index: number): string {
  const status = outcomeStatus(outcome.status);
  const limitations = textList(outcome.limitations);
  const steps = textList(outcome.steps);
  const inspected = textList(outcome.inspectedScreenshots).length;
  const detail = [
    renderMetadata("Recorded", outcome.recordedAt),
    renderMetadata("Revision", stringText(outcome.revision)),
    renderMetadata("Inspected captures", inspected),
  ].join("");
  const notes =
    outcome.notes === undefined
      ? ""
      : `<p>${escapeHtml(outcome.notes)}</p>`;
  const stepList =
    steps.length === 0
      ? ""
      : `<ul>${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>`;
  const limitationList =
    limitations.length === 0
      ? `<p>Limitations: none recorded.</p>`
      : `<p>Limitations</p><ul>${limitations.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>`;
  return `<section class="panel outcome s-${status}" data-scenario="${index}">
<h2><span class="pill">${escapeHtml(OUTCOME_LABELS[status] ?? "Unknown")}</span> ${escapeHtml(outcome.scenario)}</h2>
<p>${escapeHtml(OUTCOME_NOTE[status] ?? OUTCOME_NOTE.unknown)}</p>
<dl>${detail}</dl>${notes}${stepList}${limitationList}
</section>`;
}

function renderOutcomes(outcomes: readonly EvidenceOutcomeRecord[]): string {
  if (outcomes.length === 0) {
    return `<section class="panel outcome s-none" aria-label="Acceptance outcome">
<h2><span class="pill">Not recorded</span> Acceptance outcome</h2>
<p>${NO_OUTCOME}</p>
</section>`;
  }
  return outcomes.map(renderOutcome).join("\n");
}

function renderWarnings(
  manifest: RunManifest,
  records: readonly EvidenceRecord[],
): string {
  const warnings: string[] = [];
  const recovery = recoveryWarning(manifest, records);
  if (recovery !== "") warnings.push(recovery);
  if (records.some(isTruncationRecord)) warnings.push(TRUNCATED_RUN);
  if (records.length === 0) warnings.push(EMPTY_RUN);
  return warnings
    .map((warning) => `<p class="warn">${escapeHtml(warning)}</p>`)
    .join("\n");
}

interface Capture {
  id: string;
  step: number;
  title: string;
  path: string;
  status: string;
  target: string;
  lens: Lens;
  scenarios: number[];
  search: string;
  marker?: PointerMarker;
}

interface PngSize {
  width: number;
  height: number;
}

/** Actual PNG sizes by capture path; a capture without one is never marked. */
type ImageSizes = ReadonlyMap<string, Readonly<PngSize>>;

interface PointerMarker {
  width: number;
  height: number;
  x: number;
  y: number;
  from?: readonly [number, number];
  state: "attempted" | "completed";
  label: string;
}

/**
 * A marker needs an explicit capture link whose size matches the PNG on disk,
 * a verified xvfb-root point inside that capture and attempted input. Journal
 * fields are re-validated here because the journal is on-disk data; anything
 * else renders unmarked.
 */
function pointerMarker(record: EvidenceAction, artifact: string, size: Readonly<PngSize> | undefined): PointerMarker | undefined {
  const state = record.inputState;
  if (state !== "attempted" && state !== "completed") return undefined;
  const link = sizedLink(record, artifact, size);
  if (link === undefined) return undefined;
  const { width, height } = link;
  const inside = (px: number, py: number) => px < width && py < height;
  const { coordinateSpace, x, y, fromX, fromY } = sanitizeActionTarget(record.target);
  if (coordinateSpace !== "xvfb-root" || x === undefined || y === undefined || !inside(x, y)) return undefined;
  const from = fromX === undefined || fromY === undefined ? undefined : [fromX, fromY] as const;
  if (from === undefined ? String(record.tool) === "desktop_drag" : !inside(...from)) return undefined;
  const verb = shortText(safeText(record.tool).replace(/^desktop_/, "").replaceAll("_", " "), 40);
  const where = from === undefined ? `at ${x}, ${y}` : `${from[0]}, ${from[1]} → ${x}, ${y}`;
  return { width, height, x, y, from, state, label: `Pointer: ${verb} ${where} · ${link.phase} · ${state}` };
}

/** The capture link for `artifact`, only when its size equals the actual PNG. */
function sizedLink(record: EvidenceAction, artifact: string, size: Readonly<PngSize> | undefined): EvidenceCaptureLink | undefined {
  const link = sanitizeCaptureLinks(record.captures).find((entry) => entry.path === artifact);
  if (link === undefined || size === undefined) return undefined;
  return link.width === size.width && link.height === size.height ? link : undefined;
}

function claimedPaths(record: EvidenceAction): Set<string> {
  const artifacts: unknown[] = Array.isArray(record.artifacts) ? record.artifacts : [];
  const links: unknown[] = Array.isArray(record.captures) ? record.captures : [];
  const linked = links.map((entry) => (entry as { path?: unknown } | null)?.path);
  return new Set([...artifacts, ...linked].filter((entry): entry is string => typeof entry === "string"));
}

/** Paths that more than one record claims; no single action owns them. */
function contestedPaths(ordered: readonly TimelineRecord[]): Set<string> {
  const seen = new Set<string>();
  const contested = new Set<string>();
  for (const record of ordered) {
    if (isTruncationRecord(record)) continue;
    for (const claimed of claimedPaths(record)) (seen.has(claimed) ? contested : seen).add(claimed);
  }
  return contested;
}

function captureScenarios(
  relative: string,
  outcomes: readonly EvidenceOutcomeRecord[],
): number[] {
  const matched: number[] = [];
  outcomes.forEach((outcome, index) => {
    if (textList(outcome.inspectedScreenshots).includes(relative)) {
      matched.push(index);
    }
  });
  return matched;
}

function collectCaptures(
  ordered: readonly TimelineRecord[],
  safeScreenshots: ReadonlySet<string>,
  outcomes: readonly EvidenceOutcomeRecord[],
  fallback: Lens,
  sizeOf: (artifact: string) => Readonly<PngSize> | undefined,
): Capture[] {
  const captures: Capture[] = [];
  ordered.forEach((record, index) => {
    if (isTruncationRecord(record)) return;
    const step = index + 1;
    const lens = actionLens(record, fallback);
    const title = actionTitle(record);
    const target =
      record.target === undefined ? "" : shortText(stableJson(record.target));
    (record.artifacts ?? [])
      .filter((artifact) => safeScreenshots.has(artifact))
      .forEach((artifact, position) => {
        const marker = pointerMarker(record, artifact, sizeOf(artifact));
        captures.push({
          ...(marker === undefined ? {} : { marker }),
          id: `cap-${step}-${position + 1}`,
          step,
          title,
          path: artifact,
          status: safeText(record.status),
          target,
          lens,
          scenarios: captureScenarios(artifact, outcomes),
          search: searchAttribute([
            `step ${step}`,
            title,
            artifact,
            safeText(record.status),
            target,
          ]),
        });
      });
  });
  return captures;
}

/**
 * `data-scenario` is always emitted, empty included: the scenario rules hide
 * everything carrying the attribute without the selected index, so an omitted
 * attribute would leave unassigned captures visible under every scenario.
 */
function filterAttributes(lens: Lens, scenarios: readonly number[]): string {
  return ` data-lens="${lens}" data-scenario="${escapeHtml(scenarios.join(" "))}"`;
}

function imageSource(capture: Capture, share?: ShareImages): string {
  return share === undefined
    ? `src="${escapeHtml(capture.path)}"`
    : `data-img="${share.hashes.get(capture.path)!}"`;
}

function captureDescription(capture: Capture): string {
  return capture.step === 0 ? "Recorded screenshot" : `Capture for step ${capture.step}`;
}

function captureHeading(capture: Capture): string {
  const title = escapeHtml(capture.title);
  return capture.step === 0 ? title : `Step ${capture.step} · ${title}`;
}

function captureAlt(capture: Capture): string {
  const description = captureDescription(capture);
  return description === capture.title ? escapeHtml(description) : `${description}, ${escapeHtml(capture.title)}`;
}

/** Percent of the image box at the pixel centre; fixed precision keeps output stable. */
function percent(pixel: number, size: number): string {
  return `${Number(((pixel + 0.5) / size * 100).toFixed(4))}%`;
}

function pointAt(className: string, marker: PointerMarker, x: number, y: number): string {
  return `<span class="pointer ${className}" style="--x:${percent(x, marker.width)};--y:${percent(y, marker.height)}" aria-hidden="true"></span>`;
}

function pointerLine(marker: PointerMarker): string {
  if (marker.from === undefined) return "";
  const [fromX, fromY] = marker.from;
  const ends = `x1="${fromX + 0.5}" y1="${fromY + 0.5}" x2="${marker.x + 0.5}" y2="${marker.y + 0.5}"`;
  return `<svg class="pointer pointer-line" viewBox="0 0 ${marker.width} ${marker.height}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><line class="halo" ${ends} vector-effect="non-scaling-stroke"/><line ${ends} vector-effect="non-scaling-stroke"/></svg>${pointAt("pointer-dot", marker, fromX, fromY)}`;
}

/** Image plus overlay; an unmarked capture keeps its original bare markup. */
function framedImage(capture: Capture, image: string): string {
  const marker = capture.marker;
  if (marker === undefined) return image;
  return `<span class="image-frame${marker.state === "attempted" ? " attempted" : ""}" style="--w:${marker.width};--h:${marker.height}">${image}${pointerLine(marker)}${pointAt("pointer-ring", marker, marker.x, marker.y)}</span>`;
}

function stageClass(base: string, capture: Capture): string {
  return capture.marker === undefined ? base : `${base} framed`;
}

function markerNote(capture: Capture, className: string): string {
  return capture.marker === undefined ? "" : `<span class="${className}">${escapeHtml(capture.marker.label)}</span>`;
}

function renderCapture(capture: Capture, share?: ShareImages): string {
  return `<figure class="cap"${filterAttributes(capture.lens, capture.scenarios)} data-search="${capture.search}">
<a href="#${capture.id}" aria-label="${capture.step === 0 ? "Inspect capture" : `Inspect step ${capture.step} capture`} ${escapeHtml(capture.path)}">
<span class="${stageClass("stage", capture)}">${framedImage(capture, `<img ${imageSource(capture, share)} alt="${captureAlt(capture)}" loading="lazy">`)}</span>
<figcaption><b>${captureHeading(capture)}</b><span class="mono">${escapeHtml(capture.status)} · ${escapeHtml(capture.path)}</span>${capture.target === "" ? "" : `<span class="mono">${escapeHtml(capture.target)}</span>`}${markerNote(capture, "mono")}</figcaption>
</a></figure>`;
}

function browseLink(target: Capture | undefined, next: boolean): string {
  const label = next ? "Next" : "Previous";
  const className = next ? "go-next" : "go-prev";
  if (target === undefined) {
    return `<span class="btn ${className}" aria-disabled="true">${label}</span>`;
  }
  return `<a class="btn ${className}" href="#${target.id}">${label}</a>`;
}

function renderInspect(captures: readonly Capture[], index: number, share?: ShareImages): string {
  const capture = captures[index]!;
  return `<section class="inspect" id="${capture.id}" aria-label="${captureDescription(capture)}">
<input type="checkbox" class="zoom" id="zoom-${capture.id}">
<div class="inspect-bar"><span class="mono">${captureHeading(capture)} · ${escapeHtml(capture.path)}${markerNote(capture, "pointer-note")}</span>
<label class="btn grow" for="zoom-${capture.id}">Actual size</label>
${share === undefined ? `<a class="btn" href="${escapeHtml(capture.path)}">Open original</a>` : ""}
<a class="btn" href="#captures">Close</a></div>
<div class="${stageClass("inspect-stage", capture)}">${framedImage(capture, `<img ${imageSource(capture, share)} alt="${captureAlt(capture)}">`)}</div>
<div class="inspect-foot">${browseLink(captures[index - 1], false)}<span class="mono">${index + 1} / ${captures.length}</span>${browseLink(captures[index + 1], true)}</div>
</section>`;
}

function renderStep(
  record: TimelineRecord,
  step: number,
  captures: readonly Capture[],
  fallback: Lens,
): string {
  if (isTruncationRecord(record)) {
    return `<article class="step status-truncated" data-search="${searchAttribute([`step ${step}`, "evidence truncated"])}">
<header><span class="step-number">Step ${step}</span><h2>Evidence truncated</h2></header>
<dl>${renderMetadata("Recorded", record.recordedAt)}${renderMetadata("Bytes", `${record.bytes} / ${record.maxBytes}`)}</dl>
</article>`;
  }
  const metadata = [
    renderMetadata("Started", record.startedAt),
    renderMetadata("Status", record.status),
  ];
  if (record.sessionId !== undefined) {
    metadata.push(renderMetadata("Session", record.sessionId));
  }
  if (record.durationMs !== undefined) {
    metadata.push(renderMetadata("Duration", `${record.durationMs} ms`));
  }
  if (record.target !== undefined) {
    metadata.push(renderMetadata("Target", stableJson(record.target)));
  }
  if (record.error !== undefined) {
    metadata.push(renderMetadata("Error", record.error));
  }
  const mine = captures.filter((capture) => capture.step === step);
  const shots =
    mine.length === 0
      ? ""
      : `<p class="shots">${mine.map((capture) => `<a href="#${capture.id}">${escapeHtml(capture.path)}</a>`).join("")}</p>`;
  const scenarios = [...new Set(mine.flatMap((capture) => capture.scenarios))].sort(
    (left, right) => left - right,
  );
  const search = searchAttribute([
    `step ${step}`,
    actionTitle(record),
    safeText(record.status),
    record.target === undefined ? "" : stableJson(record.target),
    record.error === undefined ? "" : safeText(record.error),
    ...mine.map((capture) => capture.path),
  ]);
  return `<article class="step status-${escapeHtml(record.status)}"${filterAttributes(actionLens(record, fallback), scenarios)} data-search="${search}">
<header><span class="step-number">Step ${step}</span><h2>${escapeHtml(actionTitle(record))}</h2></header>
<dl>${metadata.join("")}</dl>${shots}
</article>`;
}

function lensRadios(): string {
  const rows = [
    `<input type="radio" class="lens-input" name="lens" id="lens-all" checked>`,
  ];
  for (const [lens] of LENS_LABELS) {
    rows.push(`<input type="radio" class="lens-input" name="lens" id="lens-${lens}">`);
  }
  return rows.join("");
}

function activeRules(id: string): string {
  return (
    `#${id}:checked~.shell label[for="${id}"]{background:rgba(255,122,26,.08);` +
    `border-color:rgba(255,122,26,.28);color:var(--ember)}` +
    `#${id}:focus-visible~.shell label[for="${id}"]{outline:2px solid var(--ember);outline-offset:2px}`
  );
}

function lensRules(): string {
  return [
    activeRules("lens-all"),
    ...LENS_LABELS.map(
      ([lens]) =>
        `#lens-${lens}:checked~.shell [data-lens]:not([data-lens="${lens}"]){display:none}` +
        activeRules(`lens-${lens}`),
    ),
  ].join("");
}

function scenarioRules(count: number): string {
  if (count === 0) return "";
  const rules: string[] = [activeRules("scn-all")];
  for (let index = 0; index < count; index += 1) {
    rules.push(
      `#scn-${index}:checked~.shell [data-scenario]:not([data-scenario~="${index}"]){display:none}` +
        activeRules(`scn-${index}`),
    );
  }
  return rules.join("");
}

function lensButtons(captures: readonly Capture[]): string {
  const buttons = [
    `<label for="lens-all" data-for-lens>All<span class="count">${captures.length}</span></label>`,
  ];
  for (const [lens, label] of LENS_LABELS) {
    const count = captures.filter((capture) => capture.lens === lens).length;
    buttons.push(
      `<label for="lens-${lens}" data-for-lens>${label}<span class="count">${count}</span></label>`,
    );
  }
  return buttons.join("");
}

function scenarioButtons(
  outcomes: readonly EvidenceOutcomeRecord[],
  captures: readonly Capture[],
): string {
  if (outcomes.length < 2) return "";
  const buttons = [`<label for="scn-all">All scenarios<span class="count">${captures.length}</span></label>`];
  outcomes.forEach((outcome, index) => {
    const count = captures.filter((capture) =>
      capture.scenarios.includes(index),
    ).length;
    buttons.push(
      `<label for="scn-${index}">${escapeHtml(outcome.scenario)}<span class="count">${count}</span></label>`,
    );
  });
  return `<hr><span class="eyebrow">Scenario</span>${buttons.join("")}`;
}

function scenarioRadios(outcomes: readonly EvidenceOutcomeRecord[]): string {
  if (outcomes.length < 2) return "";
  const rows = [`<input type="radio" class="scn-input" name="scn" id="scn-all" checked>`];
  outcomes.forEach((_outcome, index) => {
    rows.push(`<input type="radio" class="scn-input" name="scn" id="scn-${index}">`);
  });
  return rows.join("");
}

/** The exact CSP the report carries, with the pinned script hash. */
export function reportContentSecurityPolicy(script: string = REPORT_SCRIPT, share = false): string {
  const digest = createHash("sha256").update(script, "utf8").digest("base64");
  // frame-ancestors is ignored in <meta>-delivered CSP, so it is deliberately absent.
  return `default-src 'none'; img-src ${share ? "data:" : "'self' data:"}; style-src 'unsafe-inline'; script-src 'sha256-${digest}'; base-uri 'none'; form-action 'none'`;
}

function appendShareCaptures(
  captures: Capture[], share: ShareImages, outcomes: readonly EvidenceOutcomeRecord[], fallback: Lens,
): void {
  for (const relative of share.hashes.keys()) {
    if (captures.some((capture) => capture.path === relative)) continue;
    captures.push({
      id: `cap-artifact-${captures.length + 1}`, step: 0, title: "Recorded screenshot",
      path: relative, status: "recorded", target: "", lens: fallback,
      scenarios: captureScenarios(relative, outcomes), search: searchAttribute([relative]),
    });
  }
}

export function renderEvidenceHtml(
  manifest: RunManifest,
  records: readonly EvidenceRecord[],
  safeScreenshots: ReadonlySet<string> = new Set(),
  share?: ShareImages,
  imageSizes?: ImageSizes,
): string {
  const outcomes = sortOutcomes(records.filter(isOutcomeRecord));
  const ordered = timelineRecords(records);
  const fallback = deviceLens(manifest.device);
  const contested = contestedPaths(ordered);
  const sizeOf = (artifact: string) => contested.has(artifact) ? undefined : imageSizes?.get(artifact);
  const captures = collectCaptures(ordered, safeScreenshots, outcomes, fallback, sizeOf);
  if (share !== undefined) appendShareCaptures(captures, share, outcomes, fallback);
  const script = share === undefined ? REPORT_SCRIPT : SHARE_REPORT_SCRIPT;
  const steps = ordered
    .map((record, index) => renderStep(record, index + 1, captures, fallback))
    .join("\n");
  const gallery =
    captures.length === 0
      ? `<p class="empty">${share === undefined ? "No screenshots were captured in this run." : "No screenshots are included in this file. See Not included below."}</p>`
      : `<div class="grid">${captures.map((capture) => renderCapture(capture, share)).join("\n")}</div>`;
  const inspects = captures
    .map((_capture, index) => renderInspect(captures, index, share))
    .join("\n");
  const marked = captures.some((capture) => capture.marker !== undefined);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${reportContentSecurityPolicy(script, share !== undefined)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pickforge run ${escapeHtml(manifest.runId)}</title>
<style>
${REPORT_STYLE}
${share === undefined ? "" : "body.js .no-js{display:none}\n"}${marked ? MARKER_STYLE + activeRules("markers") : ""}${lensRules()}${scenarioRules(outcomes.length < 2 ? 0 : outcomes.length)}
</style>
</head>
<body>
${lensRadios()}${scenarioRadios(outcomes)}${marked ? `<input type="checkbox" class="marker-input" id="markers" checked>` : ""}
<div class="shell">
<header class="topbar"><svg class="mark" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M5 22V6h11l7 7-7 7H9" stroke="currentColor" stroke-width="2"/><path d="m10 12 4 4 8-9" stroke="currentColor" stroke-width="2"/></svg><span class="brand">PICKFORGE <span>/ EVIDENCE</span></span></header>
<div class="cols">
<nav class="sidebar" aria-label="Capture filters">
<span class="eyebrow">Device</span>
${lensButtons(captures)}${scenarioButtons(outcomes, captures)}
</nav>
<main>
${renderSummary(manifest, outcomes.at(-1))}
${renderOutcomes(outcomes)}
${renderWarnings(manifest, ordered)}
<div class="toolbar"><h2 id="captures">Captures <span class="count js-only"><span id="match-count">${captures.length}</span> shown</span></h2>${marked ? `<label class="btn marker-label" for="markers">Pointer markers</label>` : ""}
<span class="search-wrap"><label class="eyebrow" for="search">Search</label><input id="search" type="search" placeholder="Filter captures and steps"></span></div>
${share === undefined ? "" : `<p class="warn no-js">JavaScript is required to display embedded captures. Report text remains readable.</p>\n`}${gallery}
<p class="empty js-only" id="no-match" role="status" hidden>Nothing matches the current search and filters.</p>
<div class="toolbar"><h2 id="timeline">Timeline</h2></div>
<section aria-label="Action timeline">
${steps === "" ? `<p class="empty">No actions recorded.</p>` : steps}
</section>
${share === undefined ? `<footer>Saved evidence for run ${escapeHtml(manifest.runId)}. Captures are files in this directory; the journal in actions.jsonl stays authoritative.</footer>` : renderShareFooter(share)}
</main>
</div>
</div>
${inspects}
${share === undefined ? "" : `<script type="application/json" id="image-data">${JSON.stringify(share.payloads)}</script>\n`}<script>${script}</script>
</body>
</html>
`;
}

function formatShareBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderShareFooter(share: ShareImages): string {
  const omissions = [...share.omitted].map(([relative, reason]) =>
    `<li>${escapeHtml(relative)}: ${escapeHtml(reason)}</li>`,
  ).join("");
  return `<footer>This file is self-contained. ${share.hashes.size} capture file(s) embedded as ${Object.keys(share.payloads).length} unique image(s), ${formatShareBytes(share.bytes)} before base64 encoding. Full resolution is preserved. Limits: ${MAX_SHARE_IMAGE_BYTES / (1024 * 1024)} MiB per image and ${MAX_SHARE_TOTAL_BYTES / (1024 * 1024)} MiB total. ${omissions === "" ? "Not included: none." : `Not included:<ul>${omissions}</ul>`} report.html, manifest.json and actions.jsonl are not included as attachments. Original screenshots, manifest.json and actions.jsonl remain the authoritative evidence.</footer>`;
}

/** Embed one image or record why not; returns the size of any fully valid PNG, embedded or not. */
function includeShareImage(
  share: ShareImages, relative: string, bytes: Buffer,
): PngSize | undefined {
  const omitted = share.omitted;
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (share.payloads[hash] !== undefined) {
    // Identical bytes already passed full validation.
    share.hashes.set(relative, hash);
    return headerSize(bytes);
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    omitted.set(relative, "Unsupported image; PNG signature missing");
    return undefined;
  }
  const size = completePngSize(bytes);
  if (size === undefined) {
    omitted.set(relative, "Incomplete or corrupt PNG");
    return undefined;
  }
  if (share.bytes + bytes.length > MAX_SHARE_TOTAL_BYTES) {
    omitted.set(relative, `Over total image cap (${formatShareBytes(MAX_SHARE_TOTAL_BYTES)})`);
    return size;
  }
  // Base64 bypasses text redaction: altering it would corrupt evidence.
  share.payloads[hash] = bytes.toString("base64");
  share.bytes += bytes.length;
  share.hashes.set(relative, hash);
  return size;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface PngChunk {
  type: string;
  data: Buffer;
  end: number;
}

function readPngChunk(bytes: Buffer, offset: number): PngChunk | undefined {
  if (offset + 12 > bytes.length) return undefined;
  const length = bytes.readUInt32BE(offset);
  const end = offset + 12 + length;
  if (end > bytes.length) return undefined;
  const type = bytes.toString("latin1", offset + 4, offset + 8);
  if (!/^[A-Za-z]{4}$/.test(type)) return undefined;
  const checksum = crc32(bytes.subarray(offset + 4, end - 4)) >>> 0;
  if (checksum !== bytes.readUInt32BE(end - 4)) return undefined;
  return { type, data: bytes.subarray(offset + 8, end - 4), end };
}

const PNG_COLOR_FORMATS: Readonly<Record<number, { depths: readonly number[]; samples: number }>> = {
  0: { depths: [1, 2, 4, 8, 16], samples: 1 },
  2: { depths: [8, 16], samples: 3 },
  3: { depths: [1, 2, 4, 8], samples: 1 },
  4: { depths: [8, 16], samples: 2 },
  6: { depths: [8, 16], samples: 4 },
};

// Each pass gives the first pixel (x, y) and the spacing (dx, dy).
const ADAM7_PASSES = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
] as const;

interface PngLayout {
  width: number;
  height: number;
  bitsPerPixel: number;
  interlaced: boolean;
}

function readPngLayout(data: Buffer): PngLayout | undefined {
  if (data.length !== 13) return undefined;
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return undefined;
  const format = PNG_COLOR_FORMATS[data[9]];
  if (format === undefined || !format.depths.includes(data[8])) return undefined;
  if (data[10] !== 0 || data[11] !== 0 || data[12] > 1) return undefined;
  return { width, height, bitsPerPixel: data[8] * format.samples, interlaced: data[12] === 1 };
}

function pngRawSize(layout: PngLayout): number | undefined {
  const { width, height, bitsPerPixel } = layout;
  const passes = layout.interlaced ? ADAM7_PASSES : [[0, 0, 1, 1]] as const;
  let size = 0;
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const rows = Math.max(0, Math.ceil((height - y) / dy));
    if (columns === 0 || rows === 0) continue;
    size += rows * (1 + Math.ceil(columns * bitsPerPixel / 8));
    if (size > MAX_SHARE_INFLATED_IMAGE_BYTES) return undefined;
  }
  return size;
}

function validPngStream(parts: readonly Buffer[], expectedSize: number): boolean {
  if (parts.length === 0) return false;
  const compressed = Buffer.concat(parts);
  try {
    // Node's info option returns this shape, but its typings only declare Buffer.
    const result = zlib.inflateSync(compressed, {
      info: true, maxOutputLength: expectedSize + 1,
    }) as unknown as { buffer: Buffer; engine: zlib.Inflate };
    return result.buffer.length === expectedSize && result.engine.bytesWritten === compressed.length;
  } catch {
    return false;
  }
}

/** Validate framing, checksums and bounded image data without changing evidence bytes. */
function completePng(bytes: Buffer, layout: PngLayout, start: number): boolean {
  const expectedSize = pngRawSize(layout);
  if (expectedSize === undefined) return false;
  let offset = start;
  const imageData: Buffer[] = [];
  while (offset < bytes.length) {
    const chunk = readPngChunk(bytes, offset);
    if (chunk === undefined || chunk.type === "IHDR") return false;
    if (chunk.type === "IEND") {
      return chunk.data.length === 0 && chunk.end === bytes.length && validPngStream(imageData, expectedSize);
    }
    if (chunk.type === "IDAT") imageData.push(chunk.data);
    offset = chunk.end;
  }
  return false;
}

function readPngHeader(bytes: Buffer): { layout: PngLayout; end: number } | undefined {
  const header = readPngChunk(bytes, 8);
  const layout = header?.type === "IHDR" ? readPngLayout(header.data) : undefined;
  return layout === undefined ? undefined : { layout, end: header!.end };
}

/** Size from IHDR alone; only for bytes that already passed full validation. */
function headerSize(bytes: Buffer): PngSize {
  const { width, height } = readPngHeader(bytes)!.layout;
  return { width, height };
}

/** The actual size of a PNG that passes full validation after its signature; otherwise unknown. */
function completePngSize(bytes: Buffer): PngSize | undefined {
  const header = readPngHeader(bytes);
  if (header === undefined || !completePng(bytes, header.layout, header.end)) return undefined;
  return { width: header.layout.width, height: header.layout.height };
}

function shareScreenshotPathReason(relative: string): string | undefined {
  const unsafe = "Unsafe or unsupported screenshot path; only screenshots/*.png are included";
  if (path.isAbsolute(relative) || relative.includes("\\") || relative.includes("\0")) return unsafe;
  if (relative.split("/").some((part) => part === "" || part === "." || part === "..")) return unsafe;
  if (!relative.startsWith("screenshots/")) return "Not a screenshot; only screenshots/*.png are embedded";
  return safeScreenshotPath(relative) ? undefined : unsafe;
}

/** Classify one candidate before reading through the held screenshot directory. */
async function readShareScreenshot(
  screenshots: DirHandle | undefined, relative: string,
): Promise<Buffer | string> {
  const pathReason = shareScreenshotPathReason(relative);
  if (pathReason !== undefined) return pathReason;
  if (screenshots === undefined) {
    return "Screenshot directory missing or unsafe";
  }
  const name = relative.slice("screenshots/".length);
  const stat = await screenshots.lstatChild(name);
  if (stat === undefined) {
    return "Missing file";
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return "Unsafe file; requires a regular file without symlinks or hardlinks";
  }
  if (stat.size > MAX_SHARE_IMAGE_BYTES) {
    return `Over per-image cap (${formatShareBytes(MAX_SHARE_IMAGE_BYTES)})`;
  }
  return readBoundedFileIn(screenshots, name, Date.now() + 30_000, {
    maxBytes: MAX_SHARE_IMAGE_BYTES, singleLink: true,
  });
}

/** Embed one candidate or record why not; any fully valid PNG also records its actual size. */
async function addShareCandidate(
  share: ShareImages, screenshots: DirHandle | undefined, relative: string, sizes: Map<string, PngSize>,
): Promise<void> {
  try {
    const candidate = await readShareScreenshot(screenshots, relative);
    if (typeof candidate === "string") {
      share.omitted.set(relative, candidate);
      return;
    }
    const size = includeShareImage(share, relative, candidate);
    if (size !== undefined) sizes.set(relative, size);
  } catch {
    share.omitted.set(relative, "File unreadable, changed, or unsafe during bounded read");
  }
}

/** Read original bytes through the held screenshot directory, never a caller path. */
async function collectShareImages(
  runDir: DirHandle, manifest: RunManifest, records: readonly EvidenceRecord[], sizes: Map<string, PngSize>,
): Promise<ShareImages> {
  const share: ShareImages = { hashes: new Map(), payloads: {}, bytes: 0, omitted: new Map() };
  const candidates = new Set([
    ...manifest.artifacts.map((artifact) => artifact.path),
    ...records.flatMap((record) => isTruncationRecord(record) ? []
      : isOutcomeRecord(record) ? textList(record.inspectedScreenshots) : record.artifacts ?? []),
  ]);
  const screenshots = await openScreenshotsDir(runDir).catch(() => undefined);
  try {
    for (const relative of candidates) {
      // Generated context is already rendered as text, not an external attachment.
      if ([EVIDENCE_REPORT, EVIDENCE_SHARE_REPORT, EVIDENCE_ACTION_LOG, "manifest.json"].includes(relative)) continue;
      await addShareCandidate(share, screenshots, relative, sizes);
    }
  } finally {
    await screenshots?.close().catch(() => {});
  }
  return share;
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
      isTruncationRecord(record) || isOutcomeRecord(record) ? [] : (record.artifacts ?? []),
    ),
  );
  try {
    for (const relative of candidates) {
      if (!safeScreenshotPath(relative)) continue;
      const name = relative.slice("screenshots/".length);
      const stat = await screenshots.lstatChild(name);
      if (stat?.isFile() === true && !stat.isSymbolicLink() && stat.nlink === 1) safe.add(relative);
    }
  } finally {
    await screenshots.close().catch(() => {});
  }
  return safe;
}

function artifactPathParts(relative: string): string[] | undefined {
  const parts = relative.split("/");
  if (parts.length === 0 || parts.length > 2) return undefined;
  try {
    for (const part of parts) assertSafeEntryName(part, "artifact name");
  } catch {
    return undefined;
  }
  return parts;
}

async function regularArtifact(
  runDir: DirHandle,
  relative: string,
): Promise<boolean> {
  const parts = artifactPathParts(relative);
  if (parts === undefined) return false;
  let dir = runDir;
  try {
    if (parts.length === 2) {
      const stat = await runDir.lstatChild(parts[0]!);
      if (stat?.isDirectory() !== true || stat.isSymbolicLink()) return false;
      dir = await runDir.openChild(parts[0]!);
    }
    const stat = await dir.lstatChild(parts.at(-1)!);
    return stat?.isFile() === true && !stat.isSymbolicLink() && stat.nlink === 1;
  } finally {
    if (dir !== runDir) await dir.close();
  }
}

async function evidenceInventory(
  dir: DirHandle,
  manifest: RunManifest,
  records: readonly EvidenceRecord[],
): Promise<RunArtifact[]> {
  const candidates = new Map(
    manifest.artifacts.map((artifact) => [artifact.path, artifact]),
  );
  for (const record of records) {
    if (isTruncationRecord(record) || isOutcomeRecord(record)) continue;
    for (const relative of record.artifacts ?? []) {
      candidates.set(relative, {
        type: safeScreenshotPath(relative) ? "screenshot" : "other",
        name: path.basename(relative),
        path: relative,
        createdAt: record.startedAt,
      });
    }
  }
  candidates.set(EVIDENCE_ACTION_LOG, {
    type: "log",
    name: EVIDENCE_ACTION_LOG,
    path: EVIDENCE_ACTION_LOG,
    createdAt: manifest.createdAt,
  });
  candidates.set(EVIDENCE_REPORT, {
    type: "report",
    name: EVIDENCE_REPORT,
    path: EVIDENCE_REPORT,
    createdAt: manifest.createdAt,
  });
  candidates.set(EVIDENCE_SHARE_REPORT, {
    type: "report", name: EVIDENCE_SHARE_REPORT, path: EVIDENCE_SHARE_REPORT,
    createdAt: manifest.createdAt,
  });
  const artifacts: RunArtifact[] = [];
  for (const artifact of candidates.values()) {
    if (
      artifact.path === EVIDENCE_REPORT || artifact.path === EVIDENCE_SHARE_REPORT ||
      await regularArtifact(dir, artifact.path)
    ) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

/** @internal Caller holds the journal lock and the verified run descriptor. */
export async function writeEvidenceReportIn(
  runDir: DirHandle,
  manifest: RunManifest,
  records: readonly EvidenceRecord[],
): Promise<void> {
  const safeScreenshots = await collectSafeScreenshots(runDir, records);
  // One full PNG validation pass gives marker sizes to both reports.
  const sizes = new Map<string, PngSize>();
  const share = await collectShareImages(runDir, manifest, records, sizes);
  manifest.artifacts = await evidenceInventory(runDir, manifest, records);
  if (manifest.evidenceRecovery === "corrupt" || manifest.evidenceRecovery === "missing") {
    delete manifest.evidenceTruncated;
  } else {
    manifest.evidenceTruncated = records.some(isTruncationRecord);
  }
  const html = renderEvidenceHtml(manifest, records, safeScreenshots, undefined, sizes);
  await runDir.writeFileAtomic(EVIDENCE_SHARE_REPORT, renderEvidenceHtml(manifest, records, new Set(share.hashes.keys()), share, sizes));
  await runDir.writeFileAtomic(EVIDENCE_REPORT, html);
  await runDir.writeFileAtomic(
    "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`,
  );
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
  await withBoundRunDir(run.binding, (runDir) =>
    withJournalLock(runDir, async () => {
      const fresh = await readEvidenceManifestIn(runDir);
      const records = await readActionsIn(runDir);
      await writeEvidenceReportIn(runDir, fresh, records);
      Object.assign(manifest, fresh);
    }),
  );
  return path.join(run.dir, EVIDENCE_REPORT);
}
