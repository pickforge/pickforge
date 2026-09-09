import { createHash } from "node:crypto";
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
  reportContentSecurityPolicy,
  sortEvidenceRecords,
  writeEvidenceReport,
  type EvidenceAction,
  type EvidenceRecord,
  type ReportManifest,
  type ReportOutcome,
  type RunManifest,
} from "../src/index.js";
import { renderEvidenceSessionIndex } from "../src/evidence-render.js";

const TOKEN = `ghp_${"a".repeat(36)}`;

let root: string;
let projectDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-evidence-render-"));
  projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  // Isolate createRun's default storage resolution from the real developer
  // home; the exact mode does not matter to these render-only assertions.
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
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

function evidenceManifest(
  overrides: Partial<ReportManifest> = {},
): ReportManifest {
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
    expect(html.match(/<script>/g)).toHaveLength(1);
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

    const headers = [...html.matchAll(
      /<span class="step-number">Step (\d+)<\/span><h2>([^<]*)<\/h2>/g,
    )].map((match) => `${match[1]}:${match[2]}`);

    expect(headers).toEqual(["1:mcp / desktop_move", "2:mcp / desktop_click"]);
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
    fs.linkSync(outside, path.join(run.dir, "screenshots", "hard.png"));
    await appendAction(
      run,
      action({
        artifacts: [
          "screenshots/good.png",
          "screenshots/escape.png",
          "screenshots/hard.png",
          "screenshots/missing.png",
          "../outside.png",
        ],
      }),
    );

    const reportPath = await writeEvidenceReport(run);
    const html = fs.readFileSync(reportPath, "utf8");

    expect(reportPath).toBe(path.join(run.dir, EVIDENCE_REPORT));
    expect(html).toContain('src="screenshots/good.png"');
    expect(html).not.toContain("escape.png");
    expect(html).not.toContain("hard.png");
    expect(html).not.toContain("missing.png");
    expect(html).not.toContain("../outside.png");
    const manifest = JSON.parse(fs.readFileSync(path.join(run.dir, "manifest.json"), "utf8")) as RunManifest;
    expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual([
      "screenshots/good.png", "actions.jsonl", "report.html",
    ]);
    expect(manifest.evidenceTruncated).toBe(false);
    expect(
      fs.readdirSync(run.dir).some((name) => name.includes("report.html.tmp")),
    ).toBe(false);
  });

  it("keeps an existing artifact whose name contains a space", async () => {
    const run = await createRun(projectDir, "spaced", { evidence: true });
    const relative = "spaced name.log";
    fs.writeFileSync(path.join(run.dir, relative), "log-body");
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(run.dir, "manifest.json"), "utf8"),
    ) as RunManifest;
    onDisk.artifacts.push({
      type: "log",
      name: relative,
      path: relative,
      createdAt: onDisk.createdAt,
    });
    fs.writeFileSync(
      path.join(run.dir, "manifest.json"),
      `${JSON.stringify(onDisk, null, 2)}\n`,
    );
    await writeEvidenceReport(run);
    const written = JSON.parse(
      fs.readFileSync(path.join(run.dir, "manifest.json"), "utf8"),
    ) as RunManifest;
    expect(written.artifacts.map((artifact) => artifact.path)).toContain(relative);
  });

  it("reconciles truncation and preserves the final lifecycle-record refresh", async () => {
    const run = await createRun(projectDir, "truncated", { evidence: true });
    await appendAction(run, action(), { maxBytes: 1 });
    await run.finish("completed");
    await writeEvidenceReport(run);
    expect(run.manifest.evidenceTruncated).toBe(true);
    expect(run.manifest.artifacts.map((artifact) => artifact.path)).toEqual(["actions.jsonl", "report.html"]);
    // Session teardown records its final action after finish, then refreshes.
    await appendAction(run, action({ tool: "session_destroy" }));
    await writeEvidenceReport(run);
    expect(fs.readFileSync(path.join(run.dir, "report.html"), "utf8")).toContain("session_destroy");
  });

  it("replaces a planted report symlink without touching its target", async () => {
    const run = await createRun(projectDir, "report-link", { evidence: true });
    const outside = path.join(root, "outside-report.html");
    fs.writeFileSync(outside, "outside-secret");
    const target = path.join(run.dir, EVIDENCE_REPORT);
    fs.symlinkSync(outside, target);

    await writeEvidenceReport(run);

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside-secret");
  });

  it("rejects pathname targets even when they currently name the run", async () => {
    const run = await createRun(projectDir, "real-run", { evidence: true });
    const linked = path.join(root, "linked-run");
    fs.symlinkSync(run.dir, linked);
    const writeByPath = writeEvidenceReport as unknown as (
      runDir: string,
      manifest: RunManifest,
    ) => Promise<string>;

    await expect(writeByPath(linked, run.manifest)).rejects.toThrow(
      /verified RunHandle/,
    );
  });

  it("rejects legacy runs and corrupt evidence journals", async () => {
    const legacy = await createRun(projectDir, "legacy");
    await expect(writeEvidenceReport(legacy)).rejects.toThrow(
      /not an evidence run/,
    );

    const evidence = await createRun(projectDir, "corrupt", { evidence: true });
    fs.writeFileSync(
      path.join(evidence.dir, "actions.jsonl"),
      '{"actionId":"ok"}\nnot-json\n',
    );
    await expect(
      writeEvidenceReport(evidence),
    ).rejects.toThrow(/Corrupt evidence journal/);
  });
});

const SCRIPT = /<script>([\s\S]*?)<\/script>/;

function scriptOf(html: string): string {
  const found = SCRIPT.exec(html);
  expect(found).not.toBeNull();
  return found![1]!;
}

function cspOf(html: string): string {
  const found = /content="([^"]*)"/.exec(html);
  return found![1]!;
}

function outcome(overrides: Partial<ReportOutcome> = {}): ReportOutcome {
  return {
    kind: "outcome",
    recordedAt: "2026-07-13T12:05:00.000Z",
    scenario: "Checkout",
    status: "pass",
    revision: "abc123",
    steps: ["Open the cart", "Pay"],
    inspectedScreenshots: ["screenshots/good.png"],
    limitations: ["No payment provider sandbox"],
    ...overrides,
  };
}

describe("evidence report script pinning", () => {
  it("allows exactly the emitted script through a sha256 CSP source", () => {
    const html = renderEvidenceHtml(evidenceManifest(), []);
    const digest = createHash("sha256")
      .update(scriptOf(html), "utf8")
      .digest("base64");

    expect(cspOf(html)).toBe(
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; " +
        `script-src 'sha256-${digest}'; ` +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(reportContentSecurityPolicy()).toBe(cspOf(html));
    expect(cspOf(html)).not.toContain("unsafe-eval");
    expect(cspOf(html)).not.toContain("script-src 'unsafe-inline'");
    expect(cspOf(html)).not.toContain("connect-src");
  });

  it("keeps the session index CSP script-free", () => {
    const index = renderEvidenceSessionIndex("s1", []);
    expect(index).toContain(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(index).not.toContain("<script");
    expect(index).not.toContain("sha256-");
  });

  it("carries no network, evaluation, or markup-injection primitives", () => {
    const script = scriptOf(renderEvidenceHtml(evidenceManifest(), []));

    for (const banned of [
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "eval",
      "Function",
      "import",
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
    ]) {
      expect(script).not.toContain(banned);
    }
  });
});

describe("evidence report device, outcome, and filters", () => {
  it("renders unknown device fields rather than inventing them", () => {
    const html = renderEvidenceHtml(evidenceManifest(), []);

    expect(html).toContain("<dt>Device</dt><dd>unknown</dd>");
    expect(html).toContain("<dt>Viewport</dt><dd>unknown</dd>");
    expect(html).toContain("<dt>Touch</dt><dd>unknown</dd>");
    expect(html).toContain("<dt>Revision</dt><dd>unknown</dd>");
    expect(html).toContain("<dt>Scenario</dt><dd>unknown</dd>");
  });

  it("renders recorded device metadata", () => {
    const html = renderEvidenceHtml(
      evidenceManifest({
        device: {
          kind: "mobile-emulation",
          viewport: { width: 390, height: 844 },
          scale: 3,
          touch: true,
          browser: "Chromium 141",
          platform: "linux",
        },
      }),
      [],
    );

    expect(html).toContain("<dt>Device</dt><dd>mobile-emulation</dd>");
    expect(html).toContain("<dt>Viewport</dt><dd>390x844</dd>");
    expect(html).toContain("<dt>Scale</dt><dd>3</dd>");
    expect(html).toContain("<dt>Touch</dt><dd>yes</dd>");
    expect(html).toContain("<dt>Browser</dt><dd>Chromium 141</dd>");
    expect(html).toContain("<dt>Platform</dt><dd>linux</dd>");
  });

  it("says plainly that recording alone is not a pass", () => {
    const html = renderEvidenceHtml(evidenceManifest(), [action()]);

    expect(html).toContain(
      "No acceptance outcome recorded. Recording alone does not establish a pass.",
    );
    expect(html).toContain("s-none");
  });

  it.each([
    ["pass", "Pass"],
    ["fail", "Fail"],
    ["partial", "Partial"],
    ["blocked", "Blocked"],
  ] as const)("renders the %s outcome state", (status, label) => {
    const html = renderEvidenceHtml(evidenceManifest(), [
      action(),
      outcome({ status }),
    ]);

    expect(html).toContain(`outcome s-${status}`);
    expect(html).toContain(`<span class="pill">${label}</span>`);
    expect(html).toContain("<dt>Inspected captures</dt><dd>1</dd>");
    expect(html).toContain("<li>No payment provider sandbox</li>");
    expect(html).toContain("<dt>Revision</dt><dd>abc123</dd>");
    expect(html).toContain("<dt>Scenario</dt><dd>Checkout</dd>");
  });

  it("falls back to an unknown outcome state and keeps the step numbering", () => {
    const html = renderEvidenceHtml(evidenceManifest(), [
      outcome({ status: "flaky" as ReportOutcome["status"], steps: [], limitations: [] }),
      action(),
    ]);

    expect(html).toContain("outcome s-unknown");
    expect(html).toContain("Limitations: none recorded.");
    expect(html).toContain("Step 1");
    expect(html).not.toContain("Step 2");
  });

  it("counts captures per device filter group", () => {
    const html = renderEvidenceHtml(
      evidenceManifest({ device: { kind: "mobile-emulation" } }),
      [
        action({
          actionId: "a",
          startedAt: "2026-07-13T12:00:01.000Z",
          artifacts: ["screenshots/one.png"],
        }),
        action({
          actionId: "b",
          tool: "android_tap",
          startedAt: "2026-07-13T12:00:02.000Z",
          artifacts: ["screenshots/two.png"],
        }),
        action({
          actionId: "c",
          tool: "browser_click",
          startedAt: "2026-07-13T12:00:03.000Z",
          artifacts: ["screenshots/three.png", "screenshots/four.png"],
        }),
      ],
      new Set([
        "screenshots/one.png",
        "screenshots/two.png",
        "screenshots/three.png",
        "screenshots/four.png",
      ]),
    );

    expect(html).toContain('for="lens-all" data-for-lens>All<span class="count">4</span>');
    expect(html).toContain('Desktop<span class="count">1</span>');
    expect(html).toContain('Android emulator<span class="count">1</span>');
    expect(html).toContain('Mobile<span class="count">2</span>');
    expect(html).toContain(
      '#lens-mobile:checked~.shell [data-lens]:not([data-lens="mobile"]){display:none}',
    );
    expect(html).toContain('data-lens="android"');
  });

  it("offers scenario filters only when several outcomes exist", () => {
    const single = renderEvidenceHtml(evidenceManifest(), [outcome()]);
    expect(single).not.toContain('id="scn-all"');

    const many = renderEvidenceHtml(
      evidenceManifest(),
      [
        action({ artifacts: ["screenshots/good.png"] }),
        action({
          actionId: "second",
          startedAt: "2026-07-13T12:00:02.000Z",
          artifacts: ["screenshots/other.png"],
        }),
        outcome(),
        outcome({
          scenario: "Refund",
          recordedAt: "2026-07-13T12:06:00.000Z",
          inspectedScreenshots: ["screenshots/other.png", "screenshots/good.png"],
        }),
      ],
      new Set(["screenshots/good.png", "screenshots/other.png"]),
    );

    expect(many).toContain('id="scn-all"');
    expect(many).toContain('Checkout<span class="count">1</span>');
    expect(many).toContain('Refund<span class="count">2</span>');
    expect(many).toContain(
      '#scn-1:checked~.shell [data-scenario]:not([data-scenario~="1"]){display:none}',
    );
    // The later outcome supplies the summary revision and scenario.
    expect(many).toContain("<dt>Scenario</dt><dd>Refund</dd>");
  });

  it("builds an inspection view with browsing links and an original file link", () => {
    const html = renderEvidenceHtml(
      evidenceManifest(),
      [
        action({ artifacts: ["screenshots/one.png"] }),
        action({
          actionId: "second",
          startedAt: "2026-07-13T12:00:02.000Z",
          artifacts: ["screenshots/two.png"],
        }),
      ],
      new Set(["screenshots/one.png", "screenshots/two.png"]),
    );

    expect(html).toContain('<section class="inspect" id="cap-1-1"');
    expect(html).toContain('<a class="btn go-next" href="#cap-2-1">Next</a>');
    expect(html).toContain('<span class="btn go-prev" aria-disabled="true">Previous</span>');
    expect(html).toContain('<a class="btn" href="screenshots/two.png">Open original</a>');
    expect(html).toContain('href="#captures">Close</a>');
    expect(html).toContain('id="zoom-cap-2-1"');
  });
});

describe("evidence report recovery states", () => {
  it("states the empty run explicitly", () => {
    const html = renderEvidenceHtml(evidenceManifest(), []);

    expect(html).toContain(
      "No actions were recorded in this run. An empty run is evidence of nothing.",
    );
    expect(html).toContain("No actions recorded.");
    expect(html).toContain("No screenshots were captured in this run.");
  });

  it("states truncation explicitly and keeps the marker card", () => {
    const html = renderEvidenceHtml(evidenceManifest(), [
      action(),
      {
        actionId: "marker",
        evidenceTruncated: true,
        reason: "evidence-cap",
        bytes: 120,
        maxBytes: 100,
        recordedAt: "2026-07-13T12:00:09.000Z",
      },
    ]);

    expect(html).toContain(
      "Recording stopped at the evidence cap. Actions after the truncation marker are missing from this report.",
    );
    expect(html).toContain("Evidence truncated");
    expect(html).toContain("<dt>Bytes</dt><dd>120 / 100</dd>");
  });

  it("states a corrupt, missing, or torn journal explicitly", () => {
    expect(
      renderEvidenceHtml(evidenceManifest({ evidenceRecovery: "missing" }), []),
    ).toContain("Journal is corrupt or missing. Timeline unavailable");
    expect(
      renderEvidenceHtml(evidenceManifest({ evidenceRecovery: "corrupt" }), [
        action(),
      ]),
    ).toContain("journal corrupt after record 1");
    expect(
      renderEvidenceHtml(evidenceManifest({ evidenceRecovery: "torn-tail" }), [
        action(),
      ]),
    ).toContain("Interrupted final journal line omitted from this report");
    expect(
      renderEvidenceHtml(evidenceManifest({ status: "orphaned" }), [action()]),
    ).toContain("Owner unavailable. Recovered evidence is not a successful completion.");
  });

  it("still renders a manifest that predates the evidence marker", () => {
    const html = renderEvidenceHtml(
      {
        runId: "legacy",
        slug: "legacy",
        createdAt: "2026-07-13T12:00:00.000Z",
        status: "completed",
        artifacts: [],
      },
      [action()],
    );

    expect(html).toContain("Run legacy");
    expect(html).toContain("mcp / desktop_click");
  });
});

describe("evidence report escaping, redaction, and determinism", () => {
  it("escapes and redacts device, outcome, and search-indexed text", () => {
    const html = renderEvidenceHtml(
      evidenceManifest({
        device: {
          kind: "unknown",
          browser: '"><script>alert(1)</script>',
          platform: `platform token=${TOKEN}`,
        },
      }),
      [
        action({
          tool: '"><img src=x onerror=alert(1)>',
          target: { note: `target token=${TOKEN}` },
          artifacts: ["screenshots/good.png"],
        }),
        outcome({
          scenario: '"><b>scenario</b>',
          revision: `rev token=${TOKEN}`,
          steps: ['step "><i>one</i>', `step token=${TOKEN}`],
          limitations: [`limit token=${TOKEN}`, '"><u>limit</u>'],
          notes: `note token=${TOKEN}`,
        }),
      ],
      new Set(["screenshots/good.png"]),
    );

    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>scenario</b>");
    expect(html).not.toContain("<i>one</i>");
    expect(html).not.toContain("<u>limit</u>");
    expect(html).toContain("&lt;b&gt;scenario&lt;/b&gt;");
    expect(html).toContain("limit token=[REDACTED]");
    // The search index is an escaped, lowercased attribute, never raw markup.
    expect(html).toMatch(/data-search="[^"<>]*"/);
    expect(html).toContain('data-search="step 1 mcp / &quot;&gt;&lt;img');
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it("renders byte-identical HTML for the same inputs", () => {
    const build = () =>
      renderEvidenceHtml(
        evidenceManifest({ device: { kind: "desktop", touch: false } }),
        [
          action({ actionId: "b", startedAt: "2026-07-13T12:00:02.000Z" }),
          action({
            actionId: "a",
            startedAt: "2026-07-13T12:00:01.000Z",
            target: { z: 1, a: 2 },
            artifacts: ["screenshots/good.png"],
          }),
          outcome(),
        ],
        new Set(["screenshots/good.png"]),
      );

    expect(build()).toBe(build());
  });

  it("keeps screenshot path admission unchanged", () => {
    const html = renderEvidenceHtml(
      evidenceManifest(),
      [
        action({
          artifacts: [
            "screenshots/good.png",
            "screenshots/../../leak.png",
            "logs/other.txt",
          ],
        }),
      ],
      new Set(["screenshots/good.png"]),
    );

    expect(html).toContain('src="screenshots/good.png"');
    expect(html).not.toContain("leak.png");
    expect(html).not.toContain("logs/other.txt");
  });
});
