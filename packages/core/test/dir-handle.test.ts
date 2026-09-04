import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DirHandle,
  RunStorageAccessError,
  assertSafeEntryName,
  capabilityPathsSupported,
  withDirHandle,
} from "../src/dir-handle.js";
import { appendAction, beginEvidenceRun } from "../src/evidence.js";
import * as coreIndex from "../src/index.js";
import { adoptRun, createRun } from "../src/run.js";
import { openRunsRootDir, withBoundRunDir } from "../src/run-root.js";

// Descriptor discipline for the run-storage write path: handles are opened for
// exactly one operation, always closed (success, failure, and rejection
// paths), and a closed handle refuses to hand out a capability path, since a
// released descriptor number can be reused by an unrelated open.

let root: string;
let project: string;
let outside: string;

/** Every path this process currently holds a descriptor on, under `dir`. */
function descriptorsUnder(dir: string): string[] {
  const target = fs.realpathSync(dir);
  return fs
    .readdirSync("/proc/self/fd")
    .flatMap((fd) => {
      try {
        return [fs.readlinkSync(path.join("/proc/self/fd", fd))];
      } catch {
        return [];
      }
    })
    .filter((link) => link === target || link.startsWith(`${target}/`))
    .sort();
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-fd-"));
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

describe("DirHandle lifecycle", () => {
  it("opens, resolves through /proc/self/fd, and releases the descriptor", async () => {
    expect(capabilityPathsSupported()).toBe(true);
    const handle = await DirHandle.open(project);
    expect(handle.open).toBe(true);
    expect(handle.resolve()).toMatch(/^\/proc\/self\/fd\/\d+$/);
    expect(handle.realDir).toBe(await fs.promises.realpath(project));
    expect(descriptorsUnder(project)).toEqual([
      await fs.promises.realpath(project),
    ]);

    await handle.close();
    expect(handle.open).toBe(false);
    expect(descriptorsUnder(project)).toEqual([]);
  });

  it("refuses every operation once closed, and closes idempotently", async () => {
    const handle = await DirHandle.open(project);
    await handle.close();
    await handle.close();

    expect(() => handle.resolve()).toThrow(RunStorageAccessError);
    expect(() => handle.resolve("x")).toThrow(/already closed/);
    await expect(handle.writeFileAtomic("x", "y")).rejects.toThrow(
      /already closed/,
    );
    await expect(handle.mkdirChild("x")).rejects.toThrow(/already closed/);
    expect(fs.existsSync(path.join(project, "x"))).toBe(false);
  });

  it("closes the descriptor when verification fails after the open", async () => {
    const real = path.join(root, "real");
    await fs.promises.mkdir(real);
    await expect(
      DirHandle.open(real, { expectedRealDir: path.join(root, "elsewhere") }),
    ).rejects.toThrow(/resolves to/);
    expect(descriptorsUnder(real)).toEqual([]);
  });

  it("closes the descriptor when the caller's work throws", async () => {
    await expect(
      withDirHandle(DirHandle.open(project), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(descriptorsUnder(project)).toEqual([]);
  });

  it("refuses a symlink, a non-directory, and an unsafe child name", async () => {
    await fs.promises.symlink(outside, path.join(project, "link"));
    await fs.promises.writeFile(path.join(project, "file"), "x");
    await withDirHandle(DirHandle.open(project), async (dir) => {
      await expect(dir.openChild("link")).rejects.toThrow(/symlink/);
      await expect(dir.openChild("file")).rejects.toThrow(/not a directory/);
      await expect(dir.openChild("..")).rejects.toThrow(/single path component/);
      await expect(dir.openChild("a/b")).rejects.toThrow(
        /single path component/,
      );
    });
    expect(descriptorsUnder(project)).toEqual([]);
    expect(descriptorsUnder(outside)).toEqual([]);
  });

  it("rejects entry names that are not a single component", () => {
    for (const name of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
      expect(() => assertSafeEntryName(name)).toThrow(RunStorageAccessError);
    }
    expect(() => assertSafeEntryName(".hidden")).not.toThrow();
  });

  it("leaves no temp entry behind when an atomic write fails", async () => {
    const spy = vi
      .spyOn(fs.promises, "rename")
      .mockRejectedValue(new Error("nope"));
    await withDirHandle(DirHandle.open(project), async (dir) => {
      await expect(dir.writeFileAtomic("kept.json", "{}")).rejects.toThrow(
        "nope",
      );
    });
    spy.mockRestore();
    expect(await fs.promises.readdir(project)).toEqual([]);
  });

  it("fails closed where capability paths are unavailable", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(capabilityPathsSupported()).toBe(false);
      await expect(createRun(project, "nope")).rejects.toThrow(
        /Linux \/proc\/self\/fd capability paths/,
      );
    } finally {
      Object.defineProperty(process, "platform", original);
    }
    expect(fs.existsSync(path.join(project, ".picklab", "runs"))).toBe(false);
  });
});

describe("run storage descriptor cleanup", () => {
  it("holds no descriptor after a successful run lifecycle", async () => {
    const run = await createRun(project, "clean", { evidence: true });
    await appendAction(run, {
      actionId: "a1",
      source: "test",
      tool: "t",
      startedAt: new Date().toISOString(),
      status: "ok",
    });
    await run.captureArtifact("screenshots", "shot.png", async (outPath) => {
      await fs.promises.writeFile(outPath, "pixels");
    });
    await run.addArtifact("screenshot", "shot.png", "screenshots/shot.png");
    await run.finish("completed");
    expect(descriptorsUnder(root)).toEqual([]);
  });

  it("holds no descriptor after a failed run creation", async () => {
    await fs.promises.symlink(outside, path.join(project, ".picklab"));
    await expect(createRun(project, "nope")).rejects.toBeInstanceOf(
      RunStorageAccessError,
    );
    expect(descriptorsUnder(root)).toEqual([]);
  });

  it("holds no descriptor after a capture that throws", async () => {
    const run = await createRun(project, "capture");
    await expect(
      run.captureArtifact("screenshots", "shot.png", async () => {
        throw new Error("tool failed");
      }),
    ).rejects.toThrow("tool failed");
    expect(descriptorsUnder(root)).toEqual([]);
    expect(await fs.promises.readdir(path.join(run.dir, "screenshots"))).toEqual(
      [],
    );
  });

  it("validates artifact path components before creating staging", async () => {
    const run = await createRun(project, "artifact-components");
    const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
    let produced = false;
    try {
      for (const [subdir, name] of [
        ["screenshots", "../escaped.png"],
        ["../screenshots", "shot.png"],
      ] as const) {
        await expect(
          run.captureArtifact(subdir, name, async () => {
            produced = true;
          }),
        ).rejects.toThrow(/Invalid/);
      }
    } finally {
      mkdtemp.mockRestore();
    }
    expect(produced).toBe(false);
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(descriptorsUnder(root)).toEqual([]);
  });

  it("closes the artifact directory when staging creation fails", async () => {
    const run = await createRun(project, "staging-failure");
    const mkdtemp = vi
      .spyOn(fs.promises, "mkdtemp")
      .mockRejectedValue(new Error("staging unavailable"));
    try {
      await expect(
        run.captureArtifact("screenshots", "shot.png", async () => {}),
      ).rejects.toThrow("staging unavailable");
    } finally {
      mkdtemp.mockRestore();
    }
    expect(descriptorsUnder(root)).toEqual([]);
  });

  it("holds no descriptor after bound work throws or the run vanishes", async () => {
    const run = await createRun(project, "bound");
    await expect(
      withBoundRunDir(run.binding, async () => {
        throw new Error("inner");
      }),
    ).rejects.toThrow("inner");
    expect(descriptorsUnder(root)).toEqual([]);

    await fs.promises.rm(run.dir, { recursive: true, force: true });
    await expect(run.finish("completed")).rejects.toBeInstanceOf(
      RunStorageAccessError,
    );
    expect(descriptorsUnder(root)).toEqual([]);
  });

  it("holds no descriptor after evidence begin and append", async () => {
    const { run } = await beginEvidenceRun(project, "desk-fd0000");
    await appendAction(run, {
      actionId: "a1",
      source: "test",
      tool: "t",
      startedAt: new Date().toISOString(),
      status: "ok",
    });
    expect(descriptorsUnder(root)).toEqual([]);
  });

  it("writes into an unlinked run directory fail closed", async () => {
    const run = await createRun(project, "gone");
    await withBoundRunDir(run.binding, async (dir) => {
      // Hold the descriptor while the directory is removed: the capability
      // path still names the same (now unlinked) directory, so the write fails
      // instead of being redirected to a re-created path.
      await fs.promises.rm(run.dir, { recursive: true, force: true });
      await fs.promises.mkdir(run.dir);
      await fs.promises.symlink(
        path.join(outside, "manifest.json"),
        path.join(run.dir, "manifest.json"),
      );
      await expect(dir.writeFileAtomic("manifest.json", "{}")).rejects.toThrow();
    });
    expect(fs.existsSync(path.join(outside, "manifest.json"))).toBe(false);
    expect(descriptorsUnder(root)).toEqual([]);
  });
});

describe("adoption stays inside the verified root", () => {
  it("is not part of the package's public API", () => {
    expect("openRun" in coreIndex).toBe(false);
    expect("adoptRun" in coreIndex).toBe(false);
    expect("adoptRunIn" in coreIndex).toBe(false);
  });

  it("refuses a traversing, absolute, or empty run id", async () => {
    const run = await createRun(project, "adopt");
    for (const runId of [
      "../../../outside",
      "..",
      ".",
      "",
      "a/b",
      path.join(outside, "stolen"),
    ]) {
      await expect(
        adoptRun(project, runId, { ...run.manifest, runId }),
      ).rejects.toBeInstanceOf(RunStorageAccessError);
    }
    expect(await fs.promises.readdir(outside)).toEqual([]);
    expect(descriptorsUnder(root)).toEqual([]);
  });

  it("refuses a run id its manifest does not describe", async () => {
    const run = await createRun(project, "mismatch");
    await expect(
      adoptRun(project, run.runId, { ...run.manifest, runId: "other" }),
    ).rejects.toThrow(/manifest reports/);
  });

  it("writes nothing outside the root for a rejected adoption", async () => {
    const run = await createRun(project, "reject");
    const runsRoot = await openRunsRootDir(project);
    try {
      const escape = path.relative(
        runsRoot.dir,
        path.join(outside, "adopted"),
      );
      await expect(
        adoptRun(project, escape, { ...run.manifest, runId: escape }),
      ).rejects.toBeInstanceOf(RunStorageAccessError);
    } finally {
      await runsRoot.close();
    }
    expect(await fs.promises.readdir(outside)).toEqual([]);
  });
});
