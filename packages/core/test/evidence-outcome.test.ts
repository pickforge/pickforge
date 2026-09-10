import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendAction, beginEvidenceRun, parseActionsJournal, parseRecoverableActionsJournal, readActions } from "../src/evidence.js";
import { createRun, type RunHandle } from "../src/run.js";
import { createSession } from "../src/session.js";
import { EvidenceOutcomeError, latestOutcome, latestOutcomeStatus, recordEvidenceOutcome, sanitizeOutcome, type EvidenceOutcomeInput } from "../src/evidence-outcome.js";
import { openRunCatalog } from "../src/run-catalog.js";
import { listArtifactRuns } from "../src/rust-evidence.js";
import { renderRunReport } from "../src/evidence-render.js";

let project: string;
let run: RunHandle;
const secret = `ghp_${"a".repeat(36)}`;
const input: EvidenceOutcomeInput = { scenario: "Checkout", status: "pass", inspectedScreenshots: ["screenshots/a.png"] };

beforeEach(async () => {
  project = await fs.promises.mkdtemp(path.join(os.tmpdir(), "outcome-"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
  vi.stubEnv("PICKFORGE_HOME", path.join(project, "home"));
  run = await createRun(project, "evidence", { evidence: true });
  await fs.promises.writeFile(path.join(run.dir, "screenshots/a.png"), "png");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.promises.rm(project, { recursive: true, force: true });
});

async function interaction(tool = "desktop_click", status = "ok" as "ok" | "error") {
  await appendAction(run, { actionId: "input", source: "mcp", tool, status, startedAt: new Date().toISOString() });
}

it("round trips device schema and derives only known session geometry", async () => {
  const device = { kind: "mobile-emulation" as const, viewport: { width: 390, height: 844 }, scale: 2, touch: true, browser: "Chrome", platform: "Linux" };
  const explicit = await createRun(project, "device", { evidence: true, device });
  expect((await explicit.readManifest()).device).toEqual(device);
  for (const type of ["desktop", "browser", "android"] as const) {
    const session = await createSession({ type, projectDir: project, desktop: { display: ":99", width: 1280, height: 720 } });
    const { run: derived } = await beginEvidenceRun(project, session.id);
    expect((await derived.readManifest()).device).toEqual(type === "android" ? { kind: "emulator" } : { kind: "desktop", viewport: { width: 1280, height: 720 } });
  }
  expect((await run.readManifest()).device).toBeUndefined();
});

it("sanitizes every text field and caps lists before persistence", async () => {
  const outcome = await recordEvidenceOutcome(project, run.runId, {
    ...input, status: "blocked", scenario: `token=${secret}`, notes: `token=${secret}`,
    revision: "r".repeat(300), steps: Array(32).fill("s".repeat(700)), limitations: Array(32).fill("l".repeat(700)),
  });
  expect(outcome.scenario).not.toContain(secret);
  expect(outcome.notes).not.toContain(secret);
  expect(outcome.revision).toHaveLength(128);
  expect(outcome.steps).toHaveLength(32);
  expect(outcome.steps![0]).toHaveLength(512);
  expect(outcome.limitations).toHaveLength(32);
  expect(outcome.limitations![0]).toHaveLength(512);
  expect(sanitizeOutcome({ ...input, scenario: "s".repeat(300), notes: "n".repeat(700) }).scenario).toHaveLength(200);
  expect(sanitizeOutcome({ ...input, notes: "n".repeat(700) }).notes).toHaveLength(512);
  const raw = await fs.promises.readFile(path.join(run.dir, "actions.jsonl"), "utf8");
  expect(raw).not.toContain(secret);
  expect(parseActionsJournal(raw, run.dir)).toEqual([outcome]);
  expect(parseRecoverableActionsJournal(raw).records).toEqual([outcome]);
});

it.each(["desktop_screenshot", "desktop_launch", "session_list", "evaluate_script", "desktop_move"])("refuses pass from recording alone: %s", async (tool) => {
  await interaction(tool);
  await expect(recordEvidenceOutcome(project, run.runId, input)).rejects.toThrow(/Recording alone/);
});
it("refuses failed interactions and missing inspected screenshots", async () => {
  await interaction("desktop_click", "error");
  await expect(recordEvidenceOutcome(project, run.runId, input)).rejects.toThrow(/successful interaction/);
  await interaction();
  await expect(recordEvidenceOutcome(project, run.runId, { ...input, inspectedScreenshots: [] })).rejects.toThrow(/Recording alone/);
});
it.each(["desktop_click", "android_tap", "android_back", "chrome_devtools/fill", "chrome_devtools/press_key"])("accepts pass with %s and an inspected screenshot", async (tool) => {
  await interaction(tool);
  expect((await recordEvidenceOutcome(project, run.runId, input)).status).toBe("pass");
});
it("enforces partial, fail and blocked rules", async () => {
  await expect(recordEvidenceOutcome(project, run.runId, { ...input, status: "partial", inspectedScreenshots: [] })).rejects.toThrow(/partial/);
  for (const status of ["partial", "fail", "blocked"] as const) {
    const record = await recordEvidenceOutcome(project, run.runId, { ...input, status, inspectedScreenshots: status === "partial" ? input.inspectedScreenshots : [] });
    expect(record.status).toBe(status);
  }
});
it("rejects missing, traversal, symlink, directory and hardlink screenshots with typed names", async () => {
  await fs.promises.symlink("a.png", path.join(run.dir, "screenshots/link.png"));
  await fs.promises.mkdir(path.join(run.dir, "screenshots/dir.png"));
  await fs.promises.link(path.join(run.dir, "screenshots/a.png"), path.join(run.dir, "screenshots/hard.png"));
  const names = ["screenshots/missing.png", "../a.png", "screenshots/link.png", "screenshots/dir.png", "screenshots/hard.png"];
  await expect(recordEvidenceOutcome(project, run.runId, { ...input, status: "blocked", inspectedScreenshots: names })).rejects.toMatchObject({ name: "EvidenceOutcomeError", missingScreenshots: names });
  expect(await readActions(run.dir)).toEqual([]);
});
it("rejects invalid schemas, timestamps and oversize lists instead of truncating", () => {
  expect(() => sanitizeOutcome({ ...input, status: "invalid" as "pass" })).toThrow(EvidenceOutcomeError);
  expect(() => sanitizeOutcome({ ...input, inspectedScreenshots: Array(65).fill("screenshots/a.png") })).toThrow(/64/);
  expect(() => sanitizeOutcome({ ...input, steps: Array(33).fill("step") })).toThrow(/32 steps/);
  expect(() => sanitizeOutcome({ ...input, limitations: Array(33).fill("limit") })).toThrow(/32 limitations/);
  expect(() => sanitizeOutcome(input, "not-a-timestamp")).toThrow(/timestamp/);
  expect(() => sanitizeOutcome(input, `${new Date().toISOString()}${"0".repeat(40)}`)).toThrow(/timestamp/);
});
it("keeps legacy journals readable and skips future record kinds", async () => {
  await interaction();
  const raw = await fs.promises.readFile(path.join(run.dir, "actions.jsonl"), "utf8");
  expect(parseActionsJournal(raw, run.dir)).toHaveLength(1);
  const future = `${raw}{"kind":"future","payload":true}\n`;
  expect(parseActionsJournal(future, run.dir)).toEqual(parseActionsJournal(raw, run.dir));
  const recovered = parseRecoverableActionsJournal(future);
  expect(recovered.records).toEqual(parseActionsJournal(raw, run.dir));
  expect(recovered.warning).toMatch(/1 record\(s\) of an unknown kind skipped/);
  // A non-string kind is corrupt, and an action keeps its payload even with a kind.
  expect(() => parseActionsJournal(`${raw}{"kind":5}\n`, run.dir)).toThrow(/Corrupt evidence journal/);
  const kinded = JSON.stringify({ ...JSON.parse(raw.trim()), kind: "action" });
  expect(parseActionsJournal(`${kinded}\n`, run.dir)).toEqual(parseActionsJournal(raw, run.dir).map((record) => ({ ...record, kind: "action" })));
  const legacy = await createRun(project, "legacy");
  await expect(recordEvidenceOutcome(project, legacy.runId, input)).rejects.toThrow(/Evidence run not found/);
});
it("refreshes finalized reports and prints device and latest outcome", async () => {
  await interaction();
  await run.finish();
  await recordEvidenceOutcome(project, run.runId, { ...input, status: "blocked" });
  await recordEvidenceOutcome(project, run.runId, input);
  const records = await readActions(run.dir);
  expect(records).toHaveLength(3);
  const report = renderRunReport({ ...await run.readManifest(), device: { kind: "desktop" } }, run.dir, records).join("\n");
  expect(report).toContain('Device: {"kind":"desktop"}');
  expect(report).toContain("Outcome: pass; Checkout; 1 inspected");
  // The viewer renders the latest outcome as its own banner, not a bare line.
  const html = await fs.promises.readFile(path.join(run.dir, "report.html"), "utf8");
  expect(html).toContain('class="panel outcome s-pass"');
  expect(html).toContain('<span class="pill">Pass</span> Checkout');
  expect((await run.readManifest()).status).toBe("completed");
});

it("permits explicit outcomes on orphaned runs while refusing stale actions", async () => {
  await run.finish("orphaned");
  await expect(interaction()).rejects.toThrow(/orphaned/);
  const outcome = await recordEvidenceOutcome(project, run.runId, { ...input, status: "blocked", inspectedScreenshots: [] });
  expect(outcome.status).toBe("blocked");
  await expect(recordEvidenceOutcome(project, run.runId, input)).rejects.toThrow(/pass is not allowed on an orphaned or failed run/);
  expect((await run.readManifest()).status).toBe("orphaned");
});
it("marks mixed sessions unknown and survives an unreadable session record", async () => {
  const sessionFile = async (): Promise<string> => {
    const session = await createSession({ type: "desktop", projectDir: project, desktop: { display: ":99", width: 1280, height: 720 } });
    return path.join(project, "home", "sessions", `${session.id}.json`);
  };
  const mixed = await sessionFile();
  const record = JSON.parse(await fs.promises.readFile(mixed, "utf8")) as { id: string; type: string };
  await fs.promises.writeFile(mixed, JSON.stringify({ ...record, type: "desktop+android" }));
  expect((await (await beginEvidenceRun(project, record.id)).run.readManifest()).device).toEqual({ kind: "unknown" });
  const broken = await sessionFile();
  const brokenId = (JSON.parse(await fs.promises.readFile(broken, "utf8")) as { id: string }).id;
  await fs.promises.writeFile(broken, "{ not json");
  expect((await (await beginEvidenceRun(project, brokenId)).run.readManifest()).device).toBeUndefined();
});
it("refuses a legacy fallback without materializing another store", async () => {
  const home = path.join(project, "other-home");
  await expect(recordEvidenceOutcome(project, run.runId, { ...input, status: "blocked" }, {
    PICKFORGE_STORAGE_MODE: "home", PICKFORGE_HOME: home,
  })).rejects.toThrow(/legacy catalog fallback/);
  expect(fs.existsSync(home)).toBe(false);
});
it("enforces sanitization and acceptance even through direct journal appends", async () => {
  await expect(appendAction(run, { ...input, kind: "outcome", recordedAt: new Date().toISOString() })).rejects.toThrow(/Recording alone/);
  await appendAction(run, { ...input, kind: "outcome", recordedAt: new Date().toISOString(), status: "blocked", notes: `token=${secret}` });
  expect(JSON.stringify(await readActions(run.dir))).not.toContain(secret);
});

/** Latest outcome status the catalog reports for a run, through the tail scan. */
async function catalogStatus(runId = run.runId): Promise<string | null> {
  const catalog = await openRunCatalog(project);
  const entry = (await catalog.list()).find((candidate) => candidate.manifest.runId === runId);
  return latestOutcomeStatus(catalog, entry!);
}

/** One well-formed action line padded close to the per-record cap. */
function paddedActionLine(): string {
  return `${JSON.stringify({
    actionId: "pad", source: "mcp", tool: "desktop_click", status: "ok",
    startedAt: "2026-09-09T12:00:00Z", error: "p".repeat(60_000),
  })}\n`;
}

async function appendRaw(text: string): Promise<void> {
  await fs.promises.appendFile(path.join(run.dir, "actions.jsonl"), text);
}

it("reads the latest outcome from the tail and ignores torn or corrupt tail lines", async () => {
  expect(await catalogStatus()).toBeNull();
  await interaction();
  await recordEvidenceOutcome(project, run.runId, { ...input, status: "partial" });
  await recordEvidenceOutcome(project, run.runId, { ...input, status: "blocked", inspectedScreenshots: [] });
  expect(await catalogStatus()).toBe("blocked");
  // An unterminated final record is dropped, exactly as a full read drops it.
  await appendRaw(JSON.stringify({ ...input, kind: "outcome", status: "fail", recordedAt: new Date().toISOString() }));
  expect(await catalogStatus()).toBe("blocked");
  // A complete line a full read would reject keeps the corrupt-journal rule.
  await appendRaw("\n{ not json\n");
  expect(await catalogStatus()).toBeNull();
  const legacy = await createRun(project, "legacy");
  expect(await catalogStatus(legacy.runId)).toBeNull();
});

it("bounds the tail scan on a journal of near-cap lines", async () => {
  await interaction();
  await appendRaw(paddedActionLine().repeat(80));
  await recordEvidenceOutcome(project, run.runId, input);
  const journal = await fs.promises.stat(path.join(run.dir, "actions.jsonl"));
  expect(journal.size).toBeGreaterThan(4 * 1024 * 1024);
  const started = performance.now();
  expect(await catalogStatus()).toBe("pass");
  expect(performance.now() - started).toBeLessThan(500);
  expect((await listArtifactRuns(await openRunCatalog(project))).find((entry) => entry.runId === run.runId))
    .toMatchObject({ outcome: "pass" });
  // The full parse agrees; the tail scan just does not have to read that far.
  expect(latestOutcome(await readActions(run.dir))?.status).toBe("pass");
  // Still found when several near-cap lines sit between the outcome and the end.
  await appendRaw(paddedActionLine().repeat(4));
  expect(await catalogStatus()).toBe("pass");
});

it("reports no outcome once the byte budget is spent before reaching it", async () => {
  await interaction();
  await recordEvidenceOutcome(project, run.runId, input);
  expect(await catalogStatus()).toBe("pass");
  await appendRaw(paddedActionLine().repeat(40));
  expect(await catalogStatus()).toBeNull();
});
