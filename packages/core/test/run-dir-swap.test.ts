import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendAction,
  beginEvidenceRun,
  finalizeActiveEvidenceRun,
  readActions,
} from "../src/evidence.js";
import { recordTakeoverEvidence } from "../src/takeover.js";
import { writeEvidenceReport } from "../src/evidence-render.js";
import { createRun, type RunManifest } from "../src/run.js";
import { captureToTarget, resolveScreenshotTarget } from "../src/target.js";

// Ancestor-swap coverage for #54.
//
// Every test here swaps a *verified ancestor* for a symlink pointing outside
// the project at the exact moment a sensitive write is in flight — the window
// a re-check before the write cannot close, because the re-check and the write
// are two separate pathname lookups. They are written against the public API
// and plain `fs` patching only, so they also run against the pre-fix head:
// there, manifests, screenshots, takeover journals, and reports leak outside,
// while a traversing artifact name writes outside its staging directory.

let root: string;
let project: string;
let outside: string;

const SECRET_PIXELS = "SECRET_PIXELS";

/** Every *file* below `outside`: what a redirected write would leave behind. */
async function outsideFiles(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, {
      withFileTypes: true,
    })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), childRel);
      } else {
        found.push(childRel);
      }
    }
  };
  await walk(outside, "");
  return found.sort();
}

/**
 * Rename `.picklab` away and leave a symlink to `outside` in its place, with
 * the run layout pre-planted inside `outside` — an attacker who knows the
 * layout, which is what makes a redirected write land in a real file rather
 * than fail with `ENOENT`.
 */
async function swapPicklabForOutsideLink(runId?: string): Promise<string> {
  if (runId !== undefined) {
    for (const sub of ["screenshots", "logs"]) {
      await fs.promises.mkdir(path.join(outside, "runs", runId, sub), {
        recursive: true,
      });
    }
  }
  const picklab = path.join(project, ".picklab");
  const moved = path.join(project, ".picklab-real");
  await fs.promises.rename(picklab, moved);
  await fs.promises.symlink(outside, picklab);
  return moved;
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-swap-"));
  project = path.join(root, "project");
  outside = path.join(root, "outside");
  await fs.promises.mkdir(project);
  await fs.promises.mkdir(outside);
  vi.stubEnv("PICKFORGE_HOME", path.join(root, "home"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe("ancestor swapped while a manifest write is in flight", () => {
  it("writes the manifest into the verified run directory, never outside", async () => {
    // Fire at the manifest's temp write — after the run directory has been
    // created and verified, and after any re-check a pathname write could do.
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    let moved: string | undefined;
    vi.spyOn(fs.promises, "writeFile").mockImplementation((async (
      target: Parameters<typeof fs.promises.writeFile>[0],
      data: Parameters<typeof fs.promises.writeFile>[1],
      options?: Parameters<typeof fs.promises.writeFile>[2],
    ) => {
      if (
        moved === undefined &&
        typeof target === "string" &&
        path.basename(target).startsWith(".manifest.json.tmp-")
      ) {
        moved = await swapPicklabForOutsideLink(
          path.basename(path.dirname(target)),
        );
      }
      return realWriteFile(target, data, options);
    }) as typeof fs.promises.writeFile);

    const run = await createRun(project, "swap");
    expect(moved).toBeDefined();

    // Nothing reached the attacker's directory.
    expect(await outsideFiles()).toEqual([]);
    // The manifest landed in the directory that was verified and opened.
    const realRunDir = path.join(
      moved!,
      "runs",
      path.basename(run.dir),
    );
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(realRunDir, "manifest.json"), "utf8"),
    ) as { runId: string; status: string };
    expect(manifest.runId).toBe(run.runId);
    expect(manifest.status).toBe("running");
  });

  it("keeps later status writes out of the swapped-in directory", async () => {
    const run = await createRun(project, "later");
    const moved = await swapPicklabForOutsideLink(path.basename(run.dir));
    // The verified root now resolves outside the project: the write must fail
    // rather than land there.
    await expect(run.finish("completed")).rejects.toThrow();
    expect(await outsideFiles()).toEqual([]);
    const manifest = JSON.parse(
      await fs.promises.readFile(
        path.join(moved, "runs", path.basename(run.dir), "manifest.json"),
        "utf8",
      ),
    ) as { status: string };
    expect(manifest.status).toBe("running");
  });
});

describe("ancestor swapped while a screenshot capture is in flight", () => {
  it("publishes the image into the verified run directory, never outside", async () => {
    const target = await resolveScreenshotTarget({
      projectDir: project,
      defaultSlug: "desktop",
      conflictError: "conflict",
    });
    const runDirName = path.basename(path.dirname(path.dirname(target.outPath)));
    let moved: string | undefined;
    // The capture is exactly the window an attacker wants: the run directory
    // was verified before the tool started and the bytes are written while it
    // runs. The producer writes to the path it is handed.
    await expect(
      captureToTarget(target, async (outPath?: string) => {
        moved = await swapPicklabForOutsideLink(runDirName);
        await fs.promises.writeFile(outPath ?? target.outPath, SECRET_PIXELS);
      }),
      // The capture itself is published through the descriptor held across it;
      // the manifest update afterwards has to re-verify the (now symlinked)
      // root and fails closed.
    ).rejects.toThrow(/resolves to|symlink|disappeared/);
    expect(moved).toBeDefined();

    // No pixel of the capture reached the attacker's directory.
    expect(await outsideFiles()).toEqual([]);
    const realRunDir = path.join(moved!, "runs", runDirName);
    expect(
      await fs.promises.readFile(
        path.join(realRunDir, "screenshots", "screenshot.png"),
        "utf8",
      ),
    ).toBe(SECRET_PIXELS);
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(realRunDir, "manifest.json"), "utf8"),
    ) as { status: string; artifacts: { path: string }[] };
    expect(manifest.status).toBe("running");
    expect(manifest.artifacts).toEqual([]);
  });

  it("records the artifact normally when the swap is reverted before the manifest write", async () => {
    const target = await resolveScreenshotTarget({
      projectDir: project,
      defaultSlug: "desktop",
      conflictError: "conflict",
    });
    const runDirName = path.basename(path.dirname(path.dirname(target.outPath)));
    const data = await captureToTarget(target, async (outPath?: string) => {
      const moved = await swapPicklabForOutsideLink(runDirName);
      await fs.promises.writeFile(outPath ?? target.outPath, SECRET_PIXELS);
      await fs.promises.unlink(path.join(project, ".picklab"));
      await fs.promises.rename(moved, path.join(project, ".picklab"));
    });
    expect(await outsideFiles()).toEqual([]);
    expect(await fs.promises.readFile(target.outPath, "utf8")).toBe(
      SECRET_PIXELS,
    );
    expect(data.path).toBe(target.outPath);
    const manifest = JSON.parse(
      await fs.promises.readFile(
        path.join(target.run!.dir, "manifest.json"),
        "utf8",
      ),
    ) as { status: string; artifacts: { path: string }[] };
    expect(manifest.status).toBe("completed");
    expect(manifest.artifacts[0]?.path).toBe(
      path.join("screenshots", "screenshot.png"),
    );
  });
});

describe("ancestor swapped around evidence writes", () => {
  it("keeps best-effort takeover evidence out of a swapped ancestor", async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    let moved: string | undefined;
    let runId: string | undefined;
    const logicalRunsRoot = path.join(project, ".picklab", "runs");
    const open = vi.spyOn(fs.promises, "open").mockImplementation((async (
      target: Parameters<typeof fs.promises.open>[0],
      flags: Parameters<typeof fs.promises.open>[1],
      mode?: Parameters<typeof fs.promises.open>[2],
    ) => {
      const targetPath = String(target);
      const isLogicalRunOpen =
        targetPath === logicalRunsRoot || path.dirname(targetPath) === logicalRunsRoot;
      if (moved === undefined && isLogicalRunOpen) {
        const entries = await fs.promises.readdir(logicalRunsRoot);
        runId = entries.find((entry) => !entry.startsWith("."));
        if (runId === undefined) throw new Error("takeover run was not created");
        moved = await swapPicklabForOutsideLink(runId);
      }
      return realOpen(target, flags, mode);
    }) as typeof fs.promises.open);

    try {
      await recordTakeoverEvidence(project, "desk-take00", "takeover_start");
    } finally {
      open.mockRestore();
    }
    expect(moved).toBeDefined();
    expect(await outsideFiles()).toEqual([]);

    await fs.promises.unlink(path.join(project, ".picklab"));
    await fs.promises.rename(moved!, path.join(project, ".picklab"));
    expect((await readActions(path.join(logicalRunsRoot, runId!))).map((r) => r.actionId))
      .toEqual([]);
  });

  it("refuses the legacy pathname journal target after an ancestor swap", async () => {
    const { run } = await beginEvidenceRun(project, "desk-swap00");
    const moved = await swapPicklabForOutsideLink(run.runId);
    const appendByPath = appendAction as unknown as (
      runDir: string,
      record: Parameters<typeof appendAction>[1],
    ) => ReturnType<typeof appendAction>;

    await expect(
      appendByPath(run.dir, {
        actionId: "path-target",
        source: "test",
        tool: "swap",
        startedAt: new Date().toISOString(),
        status: "ok",
      }),
    ).rejects.toThrow(/verified RunHandle/);
    expect(await outsideFiles()).toEqual([]);

    await fs.promises.unlink(path.join(project, ".picklab"));
    await fs.promises.rename(moved, path.join(project, ".picklab"));
    expect(await readActions(run.dir)).toEqual([]);
  });

  it("keeps journal appends inside the verified run directory", async () => {
    const { run } = await beginEvidenceRun(project, "desk-swap01");
    const moved = await swapPicklabForOutsideLink(run.runId);

    await expect(
      appendAction(run, {
        actionId: "a1",
        source: "test",
        tool: "swap",
        startedAt: new Date().toISOString(),
        status: "ok",
      }),
    ).rejects.toThrow();
    expect(await outsideFiles()).toEqual([]);

    // Restoring the real tree leaves the journal readable and unpolluted.
    await fs.promises.unlink(path.join(project, ".picklab"));
    await fs.promises.rename(moved, path.join(project, ".picklab"));
    expect(await readActions(run.dir)).toEqual([]);
  });

  it("refuses pathname reports and fails bound reports closed after a swap", async () => {
    const { run } = await beginEvidenceRun(project, "desk-report0");
    await appendAction(run, {
      actionId: "before-swap",
      source: "test",
      tool: "report",
      startedAt: new Date().toISOString(),
      status: "ok",
    });
    await swapPicklabForOutsideLink(run.runId);
    const writeByPath = writeEvidenceReport as unknown as (
      runDir: string,
      manifest: RunManifest,
    ) => Promise<string>;

    await expect(writeByPath(run.dir, run.manifest)).rejects.toThrow(
      /verified RunHandle/,
    );
    await expect(writeEvidenceReport(run)).rejects.toThrow();
    expect(await outsideFiles()).toEqual([]);
  });

  it("keeps an in-flight report in the verified run directory", async () => {
    const { run } = await beginEvidenceRun(project, "desk-report1");
    await appendAction(run, {
      actionId: "report-step",
      source: "test",
      tool: "report",
      startedAt: new Date().toISOString(),
      status: "ok",
    });
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    let moved: string | undefined;
    vi.spyOn(fs.promises, "writeFile").mockImplementation((async (
      target: Parameters<typeof fs.promises.writeFile>[0],
      data: Parameters<typeof fs.promises.writeFile>[1],
      options?: Parameters<typeof fs.promises.writeFile>[2],
    ) => {
      if (
        moved === undefined &&
        typeof target === "string" &&
        path.basename(target).startsWith(".report.html.tmp-")
      ) {
        moved = await swapPicklabForOutsideLink(run.runId);
      }
      return realWriteFile(target, data, options);
    }) as typeof fs.promises.writeFile);
    const writeAtEitherHead = writeEvidenceReport as unknown as (
      target: typeof run | string,
      manifest?: RunManifest,
    ) => Promise<string>;

    await writeAtEitherHead(
      writeEvidenceReport.length === 1 ? run : run.dir,
      run.manifest,
    );

    expect(moved).toBeDefined();
    expect(await outsideFiles()).toEqual([]);
    const report = await fs.promises.readFile(
      path.join(moved!, "runs", run.runId, "report.html"),
      "utf8",
    );
    expect(report).toContain("test / report");
  });

  it("keeps the active pointer and finalization inside the verified root", async () => {
    const { run } = await beginEvidenceRun(project, "desk-swap02");
    const moved = await swapPicklabForOutsideLink(run.runId);

    // The runs root no longer resolves where it was verified: finalization
    // fails closed instead of finalizing through the planted symlink.
    await expect(
      finalizeActiveEvidenceRun(project, "desk-swap02"),
    ).rejects.toThrow(/resolves to|symlink/);
    expect(await outsideFiles()).toEqual([]);

    await fs.promises.unlink(path.join(project, ".picklab"));
    await fs.promises.rename(moved, path.join(project, ".picklab"));
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(run.dir, "manifest.json"), "utf8"),
    ) as { status: string };
    expect(manifest.status).toBe("running");
    expect(
      fs.existsSync(
        path.join(project, ".picklab", "runs", ".active-desk-swap02.json"),
      ),
    ).toBe(true);
  });
});

describe("artifact capture path validation", () => {
  it("rejects a traversing artifact name before the producer writes", async () => {
    const run = await createRun(project, "artifact-name");
    const escapedName = `${path.basename(root)}-escaped-artifact`;
    let producedPath: string | undefined;
    try {
      await expect(
        run.captureArtifact("screenshots", `../${escapedName}`, async (outPath) => {
          producedPath = outPath;
          await fs.promises.writeFile(outPath, SECRET_PIXELS);
        }),
      ).rejects.toThrow(/Invalid .* name/);
      expect(producedPath).toBeUndefined();
      expect(fs.existsSync(path.join(os.tmpdir(), escapedName))).toBe(false);
      expect(await outsideFiles()).toEqual([]);
    } finally {
      await fs.promises.rm(path.join(os.tmpdir(), escapedName), { force: true });
    }
  });
});
