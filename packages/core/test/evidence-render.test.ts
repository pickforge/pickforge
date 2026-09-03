import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVIDENCE_REPORT,
  appendAction,
  createRun,
  renderEvidenceHtml,
  renderRunReport,
  sortEvidenceRecords,
  writeEvidenceReport,
  type EvidenceAction,
  type EvidenceRecord,
  type RunManifest,
} from "../src/index.js";

const TOKEN = `ghp_${"a".repeat(36)}`;

let root: string;
let projectDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-evidence-render-"));
  projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  // Isolate createRun's default storage resolution from the real developer
  // home; the exact mode does not matter to these render-only assertions.
  vi.stubEnv("PICKLAB_STORAGE_MODE", "project-local");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function action(overrides: Partial<EvidenceAction> = {}): EvidenceAction {
  return {
    actionId: "act-1",
    source: "mcp",
    tool: "desktop_click",
    startedAt: "2026-07-13T12:00:00.000Z",
    status: "ok",
    ...overrides,
  };
}

function evidenceManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: "20260713-120000-evidence",
    slug: "evidence",
    createdAt: "2026-07-13T12:00:00.000Z",
    status: "completed",
    artifacts: [],
    evidenceVersion: 1,
    actionLog: "actions.jsonl",
    ...overrides,
  };
}

describe("sortEvidenceRecords", () => {
  it("orders by timestamp then action id without mutating append order", () => {
    const appended: EvidenceRecord[] = [
      action({ actionId: "z", startedAt: "2026-07-13T12:00:02.000Z" }),
      action({ actionId: "b", startedAt: "2026-07-13T12:00:01.000Z" }),
      action({ actionId: "a", startedAt: "2026-07-13T12:00:01.000Z" }),
      {
        actionId: "marker",
        evidenceTruncated: true,
        reason: "evidence-cap",
        bytes: 100,
        maxBytes: 100,
        recordedAt: "2026-07-13T12:00:03.000Z",
      },
    ];

    expect(sortEvidenceRecords(appended).map((record) => record.actionId)).toEqual([
      "a",
      "b",
      "z",
      "marker",
    ]);
    expect(appended.map((record) => record.actionId)).toEqual([
      "z",
      "b",
      "a",
      "marker",
    ]);
  });
});

describe("renderRunReport", () => {
  it("keeps legacy reports as artifact inventories", () => {
    const lines = renderRunReport(
      {
        runId: "legacy",
        slug: "legacy",
        createdAt: "2026-07-13T12:00:00.000Z",
        status: "completed",
        artifacts: [],
      },
      "/tmp/legacy",
    );

    expect(lines).toContain("## Artifacts (0)");
    expect(lines.join("\n")).not.toContain("## Actions");
  });

  it("renders a deterministic redacted action timeline", () => {
    const lines = renderRunReport(evidenceManifest(), "/tmp/evidence", [
      action({
        actionId: "second",
        tool: "desktop_type",
        startedAt: "2026-07-13T12:00:02.000Z",
        target: { z: 1, a: `token=${TOKEN}` },
      }),
      action({
        actionId: "first",
        startedAt: "2026-07-13T12:00:01.000Z",
      }),
    ]);
    const report = lines.join("\n");

    expect(report.indexOf("Step 1 — mcp / desktop_click")).toBeLessThan(
      report.indexOf("Step 2 — mcp / desktop_type"),
    );
    expect(report).toContain('Target: {"a":"token=[REDACTED]","z":1}');
    expect(report).not.toContain(TOKEN);
  });
});

describe("renderEvidenceHtml", () => {
  it("escapes page-controlled text, redacts secrets, and makes no external requests", () => {
    const html = renderEvidenceHtml(
      evidenceManifest({
        runId: '</title><script src="https://evil.invalid/x.js">boom</script>',
        slug: `token=${TOKEN}`,
      }),
      [
        action({
          source: '<img src="https://evil.invalid/leak">',
          tool: "desktop_type",
          target: { label: "</dd><script>alert(1)</script>" },
          error: `Authorization: Bearer ${TOKEN}`,
          artifacts: [
            "screenshots/good.png",
            "https://evil.invalid/leak.png",
            "screenshots/../../leak.png",
          ],
        }),
      ],
      new Set(["screenshots/good.png"]),
    );

    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/(?:src|href)="https:\/\/evil\.invalid/);
    expect(html).not.toContain(TOKEN);
    expect(html).toContain(
      "&lt;img src=&quot;https://evil.invalid/leak&quot;&gt;",
    );
    expect(html).toContain("&lt;/dd&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('src="screenshots/good.png"');
    expect(html).not.toContain("../../leak.png");
  });

  it("assigns display step numbers after deterministic ordering", () => {
    const html = renderEvidenceHtml(evidenceManifest(), [
      action({ actionId: "later", startedAt: "2026-07-13T12:00:02.000Z" }),
      action({
        actionId: "earlier",
        tool: "desktop_move",
        startedAt: "2026-07-13T12:00:01.000Z",
      }),
    ]);

    expect(html.indexOf("Step 1")).toBeLessThan(html.indexOf("desktop_move"));
    expect(html.indexOf("desktop_move")).toBeLessThan(html.indexOf("Step 2"));
    expect(html.indexOf("Step 2")).toBeLessThan(html.indexOf("desktop_click"));
  });
});

describe("writeEvidenceReport", () => {
  it("writes a static filmstrip and embeds only regular confined screenshots", async () => {
    const run = await createRun(projectDir, "filmstrip", {
      evidence: true,
      now: new Date("2026-07-13T12:00:00.000Z"),
    });
    const good = path.join(run.dir, "screenshots", "good.png");
    const outside = path.join(root, "outside.png");
    fs.writeFileSync(good, "png");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(run.dir, "screenshots", "escape.png"));
    await appendAction(
      run.dir,
      action({
        artifacts: [
          "screenshots/good.png",
          "screenshots/escape.png",
          "../outside.png",
        ],
      }),
    );

    const reportPath = await writeEvidenceReport(run.dir, run.manifest);
    const html = fs.readFileSync(reportPath, "utf8");

    expect(reportPath).toBe(path.join(run.dir, EVIDENCE_REPORT));
    expect(html).toContain('src="screenshots/good.png"');
    expect(html).not.toContain("escape.png");
    expect(html).not.toContain("../outside.png");
    expect(
      fs.readdirSync(run.dir).some((name) => name.includes("report.html.tmp")),
    ).toBe(false);
  });

  it("replaces a planted report symlink without touching its target", async () => {
    const run = await createRun(projectDir, "report-link", { evidence: true });
    const outside = path.join(root, "outside-report.html");
    fs.writeFileSync(outside, "outside-secret");
    const target = path.join(run.dir, EVIDENCE_REPORT);
    fs.symlinkSync(outside, target);

    await writeEvidenceReport(run.dir, run.manifest);

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside-secret");
  });

  it("rejects a symlinked run directory", async () => {
    const run = await createRun(projectDir, "real-run", { evidence: true });
    const linked = path.join(root, "linked-run");
    fs.symlinkSync(run.dir, linked);

    await expect(writeEvidenceReport(linked, run.manifest)).rejects.toThrow(
      /Unsafe evidence run directory/,
    );
  });

  it("rejects legacy runs and corrupt evidence journals", async () => {
    const legacy = await createRun(projectDir, "legacy");
    await expect(writeEvidenceReport(legacy.dir, legacy.manifest)).rejects.toThrow(
      /not an evidence run/,
    );

    const evidence = await createRun(projectDir, "corrupt", { evidence: true });
    fs.writeFileSync(
      path.join(evidence.dir, "actions.jsonl"),
      '{"actionId":"ok"}\nnot-json\n',
    );
    await expect(
      writeEvidenceReport(evidence.dir, evidence.manifest),
    ).rejects.toThrow(/Corrupt evidence journal/);
  });
});
