import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendAction, beginEvidenceRun, parseActionsJournal, parseRecoverableActionsJournal, readActions } from "../src/evidence.js";
import { createRun, type RunHandle } from "../src/run.js";
import { createSession } from "../src/session.js";
import { EvidenceOutcomeError, recordEvidenceOutcome, sanitizeOutcome, type EvidenceOutcomeInput } from "../src/evidence-outcome.js";
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
    revision: "r".repeat(300), steps: Array(40).fill("s".repeat(700)), limitations: Array(40).fill("l".repeat(700)),
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

it.each(["desktop_screenshot", "desktop_launch", "session_list", "evaluate_script"])("refuses pass from recording alone: %s", async (tool) => {
  await interaction(tool);
  await expect(recordEvidenceOutcome(project, run.runId, input)).rejects.toThrow(/Recording alone/);
});
it("refuses failed interactions and missing inspected screenshots", async () => {
  await interaction("desktop_click", "error");
  await expect(recordEvidenceOutcome(project, run.runId, input)).rejects.toThrow(/successful interaction/);
  await interaction();
  await expect(recordEvidenceOutcome(project, run.runId, { ...input, inspectedScreenshots: [] })).rejects.toThrow(/Recording alone/);
});
it.each(["desktop_click", "android_tap", "chrome_devtools/fill", "chrome_devtools/press_key"])("accepts pass with %s and an inspected screenshot", async (tool) => {
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
it("rejects invalid schemas and excessive screenshot lists", () => {
  expect(() => sanitizeOutcome({ ...input, status: "invalid" as "pass" })).toThrow(EvidenceOutcomeError);
  expect(() => sanitizeOutcome({ ...input, inspectedScreenshots: Array(65).fill("screenshots/a.png") })).toThrow(/64/);
});
it("keeps legacy journals readable and skips future record kinds", async () => {
  await interaction();
  const raw = await fs.promises.readFile(path.join(run.dir, "actions.jsonl"), "utf8");
  expect(parseActionsJournal(raw, run.dir)).toHaveLength(1);
  const future = `${raw}{"kind":"future","payload":true}\n`;
  expect(parseActionsJournal(future, run.dir)).toEqual(parseActionsJournal(raw, run.dir));
  expect(parseRecoverableActionsJournal(future).records).toEqual(parseActionsJournal(raw, run.dir));
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
  expect(await fs.promises.readFile(path.join(run.dir, "report.html"), "utf8")).toContain("Outcome: pass");
  expect((await run.readManifest()).status).toBe("completed");
});

it("permits explicit outcomes on orphaned runs while refusing stale actions", async () => {
  await run.finish("orphaned");
  await expect(interaction()).rejects.toThrow(/orphaned/);
  const outcome = await recordEvidenceOutcome(project, run.runId, { ...input, status: "blocked", inspectedScreenshots: [] });
  expect(outcome.status).toBe("blocked");
  expect((await run.readManifest()).status).toBe("orphaned");
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
