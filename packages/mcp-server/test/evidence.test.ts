import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listRuns,
  readActions,
  resolveRunStorage,
  saveProjectConfig,
  type EnvLike,
} from "@pickforge/picklab-core";
import { withMcpEvidence } from "../src/evidence.js";
import {
  makeLabDirs,
  PLANTED_TOKEN,
  removeLabDirs,
  type LabDirs,
} from "./helpers.js";

let dirs: LabDirs;
let env: EnvLike;
const sessionId = "desk-evidence";

beforeEach(() => {
  dirs = makeLabDirs();
  env = { PICKLAB_HOME: dirs.home };
});

afterEach(() => {
  removeLabDirs(dirs);
});

async function evidenceRecords() {
  const [manifest] = await listRuns(dirs.projectDir, env);
  expect(manifest).toBeDefined();
  const { runsDir } = await resolveRunStorage(dirs.projectDir, env);
  return readActions(path.join(runsDir, manifest!.runId));
}

describe("MCP evidence producer", () => {
  it("records thrown failures without changing the operation error", async () => {
    const original = new Error(`Authorization: Bearer ${PLANTED_TOKEN}`);

    await expect(
      withMcpEvidence(
        { projectDir: dirs.projectDir, env: { PICKLAB_HOME: dirs.home } },
        {
          sessionId,
          tool: "desktop_launch",
          target: { name: `token=${PLANTED_TOKEN}`, ignored: PLANTED_TOKEN },
        },
        async () => {
          throw original;
        },
      ),
    ).rejects.toBe(original);

    const records = await evidenceRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: "mcp",
      tool: "desktop_launch",
      sessionId,
      status: "error",
      target: { name: "token=[REDACTED]" },
    });
    expect(JSON.stringify(records)).not.toContain(PLANTED_TOKEN);
  });

  it("records structured tool errors as failed actions", async () => {
    const result = await withMcpEvidence(
      { projectDir: dirs.projectDir, env: { PICKLAB_HOME: dirs.home } },
      { sessionId, tool: "android_run_adb" },
      async () => ({
        data: { code: 1 },
        errors: [`token=${PLANTED_TOKEN}`],
      }),
    );

    expect(result).toEqual({
      data: { code: 1 },
      errors: [`token=${PLANTED_TOKEN}`],
    });
    const records = await evidenceRecords();
    expect(records[0]).toMatchObject({
      tool: "android_run_adb",
      status: "error",
      error: "token=[REDACTED]",
    });
    expect(JSON.stringify(records)).not.toContain(PLANTED_TOKEN);
  });

  it.each([
    [Object.assign(new Error("cancelled"), { name: "AbortError" }), "cancelled"],
    [new Error("operation timed out"), "timeout"],
  ])("classifies %s failures as %s", async (failure, status) => {
    await expect(
      withMcpEvidence(
        { projectDir: dirs.projectDir, env: { PICKLAB_HOME: dirs.home } },
        { sessionId, tool: "desktop_click" },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect((await evidenceRecords())[0]).toMatchObject({ status });
  });

  it("associates only confined regular artifacts", async () => {
    const outside = path.join(dirs.root, "outside.png");
    fs.writeFileSync(outside, "outside");

    await withMcpEvidence(
      { projectDir: dirs.projectDir, env: { PICKLAB_HOME: dirs.home } },
      {
        sessionId,
        tool: "desktop_screenshot",
        artifacts: (_result, run) => [
          "screenshots/ok.png",
          path.join(run.dir, "screenshots", "absolute.png"),
          outside,
          run.dir,
          "screenshots/directory",
          "screenshots/link.png",
          "screenshots/missing.png",
        ],
      },
      async ({ run }) => {
        const screenshots = path.join(run!.dir, "screenshots");
        fs.mkdirSync(path.join(screenshots, "directory"), { recursive: true });
        fs.writeFileSync(path.join(screenshots, "ok.png"), "ok");
        fs.writeFileSync(path.join(screenshots, "absolute.png"), "absolute");
        fs.symlinkSync(outside, path.join(screenshots, "link.png"));
        return { data: { ok: true } };
      },
    );

    expect((await evidenceRecords())[0]).toMatchObject({
      artifacts: [
        path.join("screenshots", "ok.png"),
        path.join("screenshots", "absolute.png"),
      ],
    });
  });

  it("does not create evidence without a session or when disabled", async () => {
    const withoutSession = await withMcpEvidence(
      { projectDir: dirs.projectDir, env: { PICKLAB_HOME: dirs.home } },
      { tool: "desktop_click" },
      async ({ run }) => ({ data: { run } }),
    );
    expect(withoutSession.data.run).toBeUndefined();

    await saveProjectConfig(dirs.projectDir, { evidence: { enabled: false } });
    const disabled = await withMcpEvidence(
      { projectDir: dirs.projectDir, env: { PICKLAB_HOME: dirs.home } },
      { sessionId, tool: "desktop_click" },
      async ({ run }) => ({ data: { run } }),
    );
    expect(disabled.data.run).toBeUndefined();
    expect(await listRuns(dirs.projectDir)).toEqual([]);
  });

  it("preserves successful results when evidence append fails", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await withMcpEvidence(
        { projectDir: dirs.projectDir, env: { PICKLAB_HOME: dirs.home } },
        { sessionId, tool: "desktop_click" },
        async ({ run }) => {
          await fs.promises.rm(run!.dir, { recursive: true, force: true });
          return { data: { ok: true } };
        },
      );

      expect(result).toEqual({ data: { ok: true } });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("[picklab evidence] desktop_click:"),
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
