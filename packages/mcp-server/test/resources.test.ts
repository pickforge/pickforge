import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import {
  appendAction,
  createRun,
  writeEvidenceReport,
} from "@pickforge/lab-core";
import {
  connectLab,
  makeLabDirs,
  parseToolJson,
  PLANTED_TOKEN,
  PNG_MAGIC,
  removeLabDirs,
  writeDesktopSessionRecord,
  writeSyntheticRun,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

const RUN_ID = "20260609-120000-synthetic";

function first(contents: unknown): Record<string, any> {
  return (contents as Array<Record<string, any>>)[0] as Record<string, any>;
}

async function seedEvidenceRun(projectDir: string): Promise<string> {
  const run = await createRun(
    projectDir,
    "synthetic",
    { evidence: true, now: new Date("2026-06-09T12:00:00.000Z") },
    { PICKFORGE_STORAGE_MODE: "project-local" },
  );
  fs.writeFileSync(
    path.join(run.dir, "screenshots", "screenshot.png"),
    Buffer.concat([PNG_MAGIC, Buffer.from([0x00, 0x01, 0x02])]),
  );
  fs.writeFileSync(
    path.join(run.dir, "logs", "app.log"),
    `boot ok\ntoken=${PLANTED_TOKEN}\ndone\n`,
  );
  await run.addArtifact("screenshot", "screenshot.png", "screenshots/screenshot.png");
  await run.addArtifact("log", "app.log", "logs/app.log");
  await appendAction(run, {
    actionId: "second",
    source: '<img src="https://evil.invalid/leak">',
    tool: "desktop_type",
    startedAt: "2026-06-09T12:00:04.000Z",
    status: "error",
    target: { label: "</dd><script>alert(1)</script>" },
    error: `Authorization: Bearer ${PLANTED_TOKEN}`,
  });
  await appendAction(run, {
    actionId: "first",
    source: "mcp",
    tool: "desktop_click",
    startedAt: "2026-06-09T12:00:03.000Z",
    status: "ok",
  });
  await run.finish("completed");
  await writeEvidenceReport(run);
  return run.dir;
}

let dirs: LabDirs;
let lab: ConnectedLab;
let sessionId: string;

beforeEach(async () => {
  dirs = makeLabDirs();
  await seedEvidenceRun(dirs.projectDir);
  sessionId = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
  lab = await connectLab({
    projectDir: dirs.projectDir,
    env: { PICKFORGE_HOME: dirs.home, PATH: dirs.binDir },
  });
});

afterEach(async () => {
  await lab.close();
  removeLabDirs(dirs);
});

describe("resource listing", () => {
  it("lists run evidence, artifacts, and session statuses", async () => {
    const { resources } = await lab.client.listResources();
    const uris = resources.map((resource) => resource.uri);
    expect(uris).toContain("pickforge://runs");
    expect(uris).toContain(`pickforge://runs/${RUN_ID}/manifest`);
    expect(uris).toContain(`pickforge://runs/${RUN_ID}/actions`);
    expect(uris).toContain(`pickforge://runs/${RUN_ID}/report`);
    expect(uris).toContain(
      `pickforge://runs/${RUN_ID}/screenshots/screenshot.png`,
    );
    expect(uris).toContain(`pickforge://runs/${RUN_ID}/logs/app.log`);
    expect(uris).toContain(`pickforge://sessions/${sessionId}/status`);
  });

  it("exposes the parameterized resource templates", async () => {
    const { resourceTemplates } = await lab.client.listResourceTemplates();
    const templates = resourceTemplates.map(
      (template) => template.uriTemplate,
    );
    expect(templates).toEqual(
      expect.arrayContaining([
        "pickforge://runs/{runId}/manifest",
        "pickforge://runs/{runId}/actions",
        "pickforge://runs/{runId}/report",
        "pickforge://runs/{runId}/screenshots/{name}",
        "pickforge://runs/{runId}/logs/{name}",
        "pickforge://sessions/{sessionId}/status",
      ]),
    );
  });
});

describe("resource reads", () => {
  it("reads the run index as JSON", async () => {
    const { contents } = await lab.client.readResource({
      uri: "pickforge://runs",
    });
    const runs = JSON.parse(first(contents).text as string);
    expect(runs[0].runId).toBe(RUN_ID);
  });

  it("reads a run manifest as JSON", async () => {
    const { contents } = await lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/manifest`,
    });
    expect(first(contents).mimeType).toBe("application/json");
    const manifest = JSON.parse(first(contents).text as string);
    expect(manifest.runId).toBe(RUN_ID);
    expect(manifest.artifacts).toHaveLength(2);
  });

  it("reads deterministically ordered actions with secrets redacted", async () => {
    const { contents } = await lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/actions`,
    });
    expect(first(contents).mimeType).toBe("application/json");
    const text = first(contents).text as string;
    const actions = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(actions.map((action) => action.actionId)).toEqual(["first", "second"]);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(PLANTED_TOKEN);
  });

  it("reads the escaped static HTML report without planted secrets", async () => {
    const { contents } = await lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/report`,
    });
    expect(first(contents).mimeType).toBe("text/html");
    const html = first(contents).text as string;
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("&lt;/dd&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/(?:src|href)="https:\/\/evil\.invalid/);
    expect(html).not.toContain(PLANTED_TOKEN);
  });

  it("omits evidence resources for legacy runs", async () => {
    const legacyId = "20260609-110000-legacy";
    writeSyntheticRun(dirs.projectDir, legacyId);

    const { resources } = await lab.client.listResources();
    const uris = resources.map((resource) => resource.uri);
    expect(uris).not.toContain(`pickforge://runs/${legacyId}/actions`);
    expect(uris).not.toContain(`pickforge://runs/${legacyId}/report`);
    await expect(
      lab.client.readResource({ uri: `pickforge://runs/${legacyId}/actions` }),
    ).rejects.toThrow(/not found/i);
    await expect(
      lab.client.readResource({ uri: `pickforge://runs/${legacyId}/report` }),
    ).rejects.toThrow(/not found/i);
  });

  it("reports a missing evidence journal as not found", async () => {
    const actionsPath = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "actions.jsonl",
    );
    fs.rmSync(actionsPath);

    await expect(
      lab.client.readResource({ uri: `pickforge://runs/${RUN_ID}/actions` }),
    ).rejects.toThrow(/not found/i);
    const { resources } = await lab.client.listResources();
    expect(resources.map((resource) => resource.uri)).not.toContain(
      `pickforge://runs/${RUN_ID}/actions`,
    );
  });

  it("reports malformed evidence journals without returning partial data", async () => {
    const actionsPath = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "actions.jsonl",
    );
    fs.writeFileSync(actionsPath, '{"actionId":"ok"}\nnot-json\n');

    const result = lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/actions`,
    });
    await expect(result).rejects.toThrow(/Corrupt evidence journal/);
    await expect(result).rejects.not.toThrow(dirs.projectDir);
  });

  it("reads a screenshot as a base64 blob", async () => {
    const { contents } = await lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/screenshots/screenshot.png`,
    });
    expect(first(contents).mimeType).toBe("image/png");
    const data = Buffer.from(first(contents).blob as string, "base64");
    expect(data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);
  });

  it("refuses to inline a screenshot blob over 8MB", async () => {
    const bigPath = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "screenshots",
      "big.png",
    );
    fs.writeFileSync(
      bigPath,
      Buffer.concat([PNG_MAGIC, Buffer.alloc(8 * 1024 * 1024)]),
    );
    const { contents } = await lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/screenshots/big.png`,
    });
    expect(first(contents).mimeType).toBe("text/plain");
    expect(first(contents).blob).toBeUndefined();
    expect(first(contents).text).toContain("inline limit");
    expect(first(contents).text).toContain(bigPath);
  });

  it("reads a log with secrets redacted", async () => {
    const { contents } = await lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/logs/app.log`,
    });
    const text = first(contents).text as string;
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(PLANTED_TOKEN);
  });

  it("caps an oversized log to its trailing bytes instead of loading it all", async () => {
    const bigPath = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "logs",
      "big.log",
    );
    const filler = "x".repeat(1024);
    const lines: string[] = [];
    for (let i = 0; i < 1200; i += 1) {
      lines.push(`line-${i}-${filler}`);
    }
    lines.push(`tail-marker Authorization: Bearer ${PLANTED_TOKEN}`);
    fs.writeFileSync(bigPath, `${lines.join("\n")}\n`);
    expect(fs.statSync(bigPath).size).toBeGreaterThan(1024 * 1024);

    const { contents } = await lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/logs/big.log`,
    });
    const text = first(contents).text as string;
    expect(text).toContain("[truncated:");
    expect(text).toContain("tail-marker");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(PLANTED_TOKEN);
    expect(text).not.toContain("line-0-");
    expect(text.length).toBeLessThan(1024 * 1024 + 1024);
  });

  it("reads a session status as JSON", async () => {
    const { contents } = await lab.client.readResource({
      uri: `pickforge://sessions/${sessionId}/status`,
    });
    const status = JSON.parse(first(contents).text as string);
    expect(status.id).toBe(sessionId);
    expect(status.type).toBe("desktop");
    expect(status.desktop.xvfbAlive).toBe(false);
    expect(status.viewer).toEqual({
      endpoint: null,
      ready: false,
      readOnly: false,
      hostGuiLaunchSupported: false,
    });
  });
});

describe("traversal protection", () => {
  it.each([
    "pickforge://runs/../x/manifest",
    "pickforge://runs/%2e%2e/manifest",
    `pickforge://runs/${RUN_ID}/logs/%2e%2e%2fmanifest.json`,
    `pickforge://runs/${RUN_ID}/screenshots/..%2f..%2fmanifest.json`,
    "pickforge://sessions/%2e%2e%2fdesk-000001/status",
  ])("rejects %s", async (uri) => {
    await expect(lab.client.readResource({ uri })).rejects.toThrow();
  });

  it("rejects an unknown run id", async () => {
    await expect(
      lab.client.readResource({ uri: "pickforge://runs/nope/manifest" }),
    ).rejects.toThrow();
  });
});

describe("symlink protection", () => {
  it.each([
    ["actions", "actions.jsonl"],
    ["report", "report.html"],
  ])("rejects a symlinked %s evidence file", async (resource, fileName) => {
    const outside = path.join(dirs.root, `outside-${fileName}`);
    fs.writeFileSync(outside, `token=${PLANTED_TOKEN}\n`);
    const filePath = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      fileName,
    );
    fs.rmSync(filePath, { force: true });
    fs.symlinkSync(outside, filePath);

    await expect(
      lab.client.readResource({
        uri: `pickforge://runs/${RUN_ID}/${resource}`,
      }),
    ).rejects.toThrow(/not found/i);

    const { resources } = await lab.client.listResources();
    expect(resources.map((entry) => entry.uri)).not.toContain(
      `pickforge://runs/${RUN_ID}/${resource}`,
    );
  });

  it.each([
    ["actions", "actions.jsonl"],
    ["report", "report.html"],
  ])(
    "rejects a parent-directory swap before opening %s",
    async (resource, fileName) => {
      const runDir = path.join(
        dirs.projectDir,
        ".picklab",
        "runs",
        RUN_ID,
      );
      const backupRun = `${runDir}-backup`;
      const outsideRun = path.join(dirs.root, `outside-${resource}-run`);
      fs.mkdirSync(outsideRun, { recursive: true });
      fs.writeFileSync(
        path.join(outsideRun, fileName),
        resource === "actions"
          ? `${JSON.stringify({ actionId: PLANTED_TOKEN })}\n`
          : `<html>${PLANTED_TOKEN}</html>`,
      );

      const target = path.join(runDir, fileName);
      const realOpen = fs.promises.open.bind(fs.promises);
      let swapped = false;
      const openSpy = vi
        .spyOn(fs.promises, "open")
        .mockImplementation(async (...args) => {
          if (!swapped && path.resolve(String(args[0])) === target) {
            swapped = true;
            fs.renameSync(runDir, backupRun);
            fs.symlinkSync(outsideRun, runDir);
          }
          return realOpen(...args);
        });

      try {
        const result = lab.client.readResource({
          uri: `pickforge://runs/${RUN_ID}/${resource}`,
        });
        await expect(result).rejects.toThrow(/not found/i);
        await expect(result).rejects.not.toThrow(PLANTED_TOKEN);
        expect(swapped).toBe(true);
      } finally {
        openSpy.mockRestore();
        if (fs.existsSync(runDir) && fs.lstatSync(runDir).isSymbolicLink()) {
          fs.unlinkSync(runDir);
        }
        if (fs.existsSync(backupRun)) fs.renameSync(backupRun, runDir);
      }
    },
  );

  it("rejects a screenshot symlink pointing outside the run dir", async () => {
    const secret = path.join(dirs.root, "outside-secret.png");
    fs.writeFileSync(secret, Buffer.concat([PNG_MAGIC, Buffer.from([9])]));
    const linkPath = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "screenshots",
      "escape.png",
    );
    fs.symlinkSync(secret, linkPath);

    await expect(
      lab.client.readResource({
        uri: `pickforge://runs/${RUN_ID}/screenshots/escape.png`,
      }),
    ).rejects.toThrow(/not found/i);

    const { resources } = await lab.client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain(
      `pickforge://runs/${RUN_ID}/screenshots/escape.png`,
    );
  });

  it("rejects a log symlink pointing outside the run dir", async () => {
    const secret = path.join(dirs.root, "outside-secret.log");
    fs.writeFileSync(secret, `token=${PLANTED_TOKEN}\n`);
    const linkPath = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "logs",
      "escape.log",
    );
    fs.symlinkSync(secret, linkPath);

    await expect(
      lab.client.readResource({
        uri: `pickforge://runs/${RUN_ID}/logs/escape.log`,
      }),
    ).rejects.toThrow(/not found/i);

    const { resources } = await lab.client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain(
      `pickforge://runs/${RUN_ID}/logs/escape.log`,
    );
  });

  it("rejects a screenshot symlink pointing to a safe in-run file", async () => {
    const linkPath = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "screenshots",
      "link.png",
    );
    fs.symlinkSync("screenshot.png", linkPath);

    await expect(
      lab.client.readResource({
        uri: `pickforge://runs/${RUN_ID}/screenshots/link.png`,
      }),
    ).rejects.toThrow(/not found/i);

    const { resources } = await lab.client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain(
      `pickforge://runs/${RUN_ID}/screenshots/link.png`,
    );
  });

  it("rejects a log symlink pointing to a safe in-run file", async () => {
    const linkPath = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "logs",
      "link.log",
    );
    fs.symlinkSync("app.log", linkPath);

    await expect(
      lab.client.readResource({
        uri: `pickforge://runs/${RUN_ID}/logs/link.log`,
      }),
    ).rejects.toThrow(/not found/i);

    const { resources } = await lab.client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain(
      `pickforge://runs/${RUN_ID}/logs/link.log`,
    );
  });

  it("rejects a symlinked screenshots dir pointing outside the run dir", async () => {
    const outsideDir = path.join(dirs.root, "outside-screenshots");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideDir, "leak.png"),
      Buffer.concat([PNG_MAGIC, Buffer.from([9])]),
    );
    const subdir = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "screenshots",
    );
    fs.rmSync(subdir, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, subdir);

    await expect(
      lab.client.readResource({
        uri: `pickforge://runs/${RUN_ID}/screenshots/leak.png`,
      }),
    ).rejects.toThrow(/not found/i);

    const { resources } = await lab.client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain(
      `pickforge://runs/${RUN_ID}/screenshots/leak.png`,
    );
  });

  it("rejects a manifest symlink pointing outside the run dir", async () => {
    const secret = path.join(dirs.root, "outside-manifest.json");
    fs.writeFileSync(secret, JSON.stringify({ runId: "evil-leak" }));
    const manifestPath = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "manifest.json",
    );
    fs.rmSync(manifestPath, { force: true });
    fs.symlinkSync(secret, manifestPath);

    const result = lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/manifest`,
    });
    await expect(result).rejects.toThrow(/Run not found/i);
    await expect(result).rejects.not.toThrow(/evil-leak/);
  });

  it("does not leak a symlinked manifest via listings", async () => {
    const secret = path.join(dirs.root, "outside-manifest-leak.json");
    fs.writeFileSync(
      secret,
      JSON.stringify({
        runId: "evil-leak",
        slug: "leaked-slug",
        secretField: PLANTED_TOKEN,
        artifacts: [],
      }),
    );
    const manifestPath = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "manifest.json",
    );
    fs.rmSync(manifestPath, { force: true });
    fs.symlinkSync(secret, manifestPath);

    // pickforge://runs must not contain leaked fields/values or the skipped run.
    const { contents } = await lab.client.readResource({
      uri: "pickforge://runs",
    });
    const text = first(contents).text as string;
    expect(text).not.toContain(PLANTED_TOKEN);
    expect(text).not.toContain("leaked-slug");
    expect(text).not.toContain(RUN_ID);

    // listResources() must not include the run's manifest or files.
    const { resources } = await lab.client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).not.toContain(`pickforge://runs/${RUN_ID}/manifest`);
    expect(uris).not.toContain(
      `pickforge://runs/${RUN_ID}/screenshots/screenshot.png`,
    );
    expect(uris).not.toContain(`pickforge://runs/${RUN_ID}/logs/app.log`);

    // Direct manifest read still rejects without leaking.
    const result = lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/manifest`,
    });
    await expect(result).rejects.toThrow(/Run not found/i);
    await expect(result).rejects.not.toThrow(/evil-leak/);
  });

  it("rejects a symlinked logs dir pointing outside the run dir", async () => {
    const outsideDir = path.join(dirs.root, "outside-logs");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideDir, "leak.log"),
      `token=${PLANTED_TOKEN}\n`,
    );
    const subdir = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
      "logs",
    );
    fs.rmSync(subdir, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, subdir);

    await expect(
      lab.client.readResource({
        uri: `pickforge://runs/${RUN_ID}/logs/leak.log`,
      }),
    ).rejects.toThrow(/not found/i);

    const { resources } = await lab.client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain(
      `pickforge://runs/${RUN_ID}/logs/leak.log`,
    );
  });

  it("rejects a symlinked run dir pointing outside the runs root", async () => {
    const outsideRun = path.join(dirs.root, "outside-run");
    fs.mkdirSync(path.join(outsideRun, "logs"), { recursive: true });
    fs.mkdirSync(path.join(outsideRun, "screenshots"), { recursive: true });
    fs.writeFileSync(
      path.join(outsideRun, "manifest.json"),
      JSON.stringify({ runId: "evil-leak" }),
    );
    fs.writeFileSync(
      path.join(outsideRun, "logs", "leak.log"),
      `token=${PLANTED_TOKEN}\n`,
    );
    fs.writeFileSync(
      path.join(outsideRun, "screenshots", "leak.png"),
      Buffer.concat([PNG_MAGIC, Buffer.from([9])]),
    );

    const runDir = path.join(
      dirs.projectDir,
      ".picklab",
      "runs",
      RUN_ID,
    );
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.symlinkSync(outsideRun, runDir);

    const manifestResult = lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/manifest`,
    });
    await expect(manifestResult).rejects.toThrow(/not found/i);
    await expect(manifestResult).rejects.not.toThrow(/evil-leak/);

    await expect(
      lab.client.readResource({
        uri: `pickforge://runs/${RUN_ID}/logs/leak.log`,
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      lab.client.readResource({
        uri: `pickforge://runs/${RUN_ID}/screenshots/leak.png`,
      }),
    ).rejects.toThrow(/not found/i);

    const { resources } = await lab.client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).not.toContain(`pickforge://runs/${RUN_ID}/logs/leak.log`);
    expect(uris).not.toContain(
      `pickforge://runs/${RUN_ID}/screenshots/leak.png`,
    );
  });

  it("rejects a symlinked .picklab dir pointing outside the project", async () => {
    // Build a real outside project whose `.picklab/runs` holds a leaking run,
    // then point this project's `.picklab` at the outside `.picklab`.
    const outsideProject = fs.mkdtempSync(
      path.join(os.tmpdir(), "pickforge-lab-outside-proj-"),
    );
    try {
      const leakRunId = "20260609-130000-leak";
      writeSyntheticRun(outsideProject, leakRunId, {
        logBody: `token=${PLANTED_TOKEN}\n`,
      });
      // Rewrite the leaking manifest to carry a recognizable slug/field.
      const leakManifestPath = path.join(
        outsideProject,
        ".picklab",
        "runs",
        leakRunId,
        "manifest.json",
      );
      fs.writeFileSync(
        leakManifestPath,
        JSON.stringify({
          runId: leakRunId,
          slug: "leaked-slug",
          createdAt: "2026-06-09T13:00:00.000Z",
          status: "completed",
          secretField: PLANTED_TOKEN,
          artifacts: [],
        }),
      );

      const projectPickforge = path.join(dirs.projectDir, ".picklab");
      fs.rmSync(projectPickforge, { recursive: true, force: true });
      fs.symlinkSync(
        path.join(outsideProject, ".picklab"),
        projectPickforge,
      );

      // pickforge://runs must be empty and leak nothing.
      const { contents } = await lab.client.readResource({
        uri: "pickforge://runs",
      });
      const text = first(contents).text as string;
      expect(JSON.parse(text)).toEqual([]);
      expect(text).not.toContain(PLANTED_TOKEN);
      expect(text).not.toContain("leaked-slug");

      // Direct manifest/log/screenshot reads reject without leaking.
      const manifestResult = lab.client.readResource({
        uri: `pickforge://runs/${leakRunId}/manifest`,
      });
      await expect(manifestResult).rejects.toThrow(/not found/i);
      await expect(manifestResult).rejects.not.toThrow(/leaked-slug/);
      await expect(
        lab.client.readResource({
          uri: `pickforge://runs/${leakRunId}/logs/app.log`,
        }),
      ).rejects.toThrow(/not found/i);
      await expect(
        lab.client.readResource({
          uri: `pickforge://runs/${leakRunId}/screenshots/screenshot.png`,
        }),
      ).rejects.toThrow(/not found/i);

      // MCP tools must not expose outside manifest data.
      const listResult = parseToolJson(
        await lab.client.callTool({ name: "artifact_list", arguments: {} }),
      );
      expect(listResult.runs).toEqual([]);
      expect(JSON.stringify(listResult)).not.toContain(PLANTED_TOKEN);
      expect(JSON.stringify(listResult)).not.toContain("leaked-slug");

      const reportResult = await lab.client.callTool({
        name: "artifact_report",
        arguments: { runId: leakRunId },
      });
      expect(reportResult.isError).toBe(true);
      expect(JSON.stringify(reportResult)).not.toContain(PLANTED_TOKEN);
      expect(JSON.stringify(reportResult)).not.toContain("leaked-slug");
    } finally {
      fs.rmSync(outsideProject, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked runs root pointing outside the project", async () => {
    const outsideRuns = path.join(dirs.root, "outside-runs");
    const outsideRun = path.join(outsideRuns, RUN_ID);
    fs.mkdirSync(path.join(outsideRun, "logs"), { recursive: true });
    fs.mkdirSync(path.join(outsideRun, "screenshots"), { recursive: true });
    fs.writeFileSync(
      path.join(outsideRun, "manifest.json"),
      JSON.stringify({
        runId: "evil-leak",
        slug: "leaked-slug",
        secretField: PLANTED_TOKEN,
        artifacts: [],
      }),
    );
    fs.writeFileSync(
      path.join(outsideRun, "logs", "leak.log"),
      `token=${PLANTED_TOKEN}\n`,
    );
    fs.writeFileSync(
      path.join(outsideRun, "screenshots", "leak.png"),
      Buffer.concat([PNG_MAGIC, Buffer.from([9])]),
    );

    const runsRoot = path.join(dirs.projectDir, ".picklab", "runs");
    fs.rmSync(runsRoot, { recursive: true, force: true });
    fs.symlinkSync(outsideRuns, runsRoot);

    // Direct manifest read rejects without leaking outside data.
    const manifestResult = lab.client.readResource({
      uri: `pickforge://runs/${RUN_ID}/manifest`,
    });
    await expect(manifestResult).rejects.toThrow(/not found/i);
    await expect(manifestResult).rejects.not.toThrow(/evil-leak/);
    await expect(manifestResult).rejects.not.toThrow(/leaked-slug/);

    // Direct log read rejects without leaking outside data.
    await expect(
      lab.client.readResource({
        uri: `pickforge://runs/${RUN_ID}/logs/leak.log`,
      }),
    ).rejects.toThrow(/not found/i);

    // Direct screenshot read rejects without leaking outside data.
    await expect(
      lab.client.readResource({
        uri: `pickforge://runs/${RUN_ID}/screenshots/leak.png`,
      }),
    ).rejects.toThrow(/not found/i);

    // Listing remains empty and exposes no outside resources.
    const { contents } = await lab.client.readResource({
      uri: "pickforge://runs",
    });
    const text = first(contents).text as string;
    expect(JSON.parse(text)).toEqual([]);
    expect(text).not.toContain(PLANTED_TOKEN);
    expect(text).not.toContain("leaked-slug");

    const { resources } = await lab.client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).not.toContain(`pickforge://runs/${RUN_ID}/manifest`);
    expect(uris).not.toContain(`pickforge://runs/${RUN_ID}/logs/leak.log`);
    expect(uris).not.toContain(
      `pickforge://runs/${RUN_ID}/screenshots/leak.png`,
    );
  });
});
