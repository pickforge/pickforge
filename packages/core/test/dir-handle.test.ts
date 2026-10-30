import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DirHandle,
  RunStorageAccessError,
  abandonedRemoval,
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

describe("owned file removal", () => {
  const REMOVAL = /\.remove-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  /** Puts new content under `name`, from a file made first, so ext4 cannot reuse the old inode. */
  function replace(name: string, content: string): void {
    fs.writeFileSync(path.join(project, `${name}.new`), content);
    fs.renameSync(path.join(project, `${name}.new`), path.join(project, name));
  }

  async function owned(name: string): Promise<fs.Stats> {
    fs.writeFileSync(path.join(project, name), "checked");
    return fs.promises.lstat(path.join(project, name));
  }

  it("removes the checked file and leaves no other entry", async () => {
    const stat = await owned("app.log");
    await withDirHandle(DirHandle.open(project), (dir) => dir.unlinkOwnedFile("app.log", stat));
    expect(fs.readdirSync(project)).toEqual([]);
  });

  it("removes a file whose name is too long to keep in its removal name", async () => {
    const name = `${"x".repeat(240)}.log`;
    const stat = await owned(name);
    const removal = afterMove(() => {});
    await withDirHandle(DirHandle.open(project), (dir) => dir.unlinkOwnedFile(name, stat));
    expect(removal()).toMatch(new RegExp(`^${REMOVAL.source}`));
    expect(abandonedRemoval(removal()!)).toBeUndefined();
    expect(fs.readdirSync(project)).toEqual([]);
  });

  it("keeps a replacement made at the last step", async () => {
    const stat = await owned("app.log");
    const unlink = DirHandle.prototype.unlinkChild;
    vi.spyOn(DirHandle.prototype, "unlinkChild").mockImplementationOnce(async function (this: DirHandle, name) {
      replace("app.log", "replacement");
      return unlink.call(this, name);
    });
    await withDirHandle(DirHandle.open(project), (dir) => dir.unlinkOwnedFile("app.log", stat));
    expect(fs.readdirSync(project)).toEqual(["app.log"]);
    expect(fs.readFileSync(path.join(project, "app.log"), "utf8")).toBe("replacement");
  });

  it("puts back a replacement made before the move", async () => {
    const stat = await owned("app.log");
    replace("app.log", "replacement");
    await withDirHandle(DirHandle.open(project), async (dir) => {
      await expect(dir.unlinkOwnedFile("app.log", stat)).rejects.toThrow(
        `File to remove was replaced, so it was kept: ${project}/app.log`,
      );
    });
    expect(fs.readdirSync(project)).toEqual(["app.log"]);
    expect(fs.readFileSync(path.join(project, "app.log"), "utf8")).toBe("replacement");
  });

  /** Runs `after` once the first move to a removal name is done, and returns that name. */
  function afterMove(after: () => void): () => string | undefined {
    const rename = fs.promises.rename.bind(fs.promises);
    let removal: string | undefined;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
      await rename(source, target);
      if (removal === undefined && REMOVAL.test(String(target))) {
        removal = path.basename(String(target));
        after();
      }
    });
    return () => removal;
  }

  it("keeps a replacement under its removal name when the name is taken again", async () => {
    const stat = await owned("app.log");
    replace("app.log", "replacement");
    afterMove(() => replace("app.log", "newest"));
    await withDirHandle(DirHandle.open(project), async (dir) => {
      await expect(dir.unlinkOwnedFile("app.log", stat)).rejects.toThrow(
        new RegExp(`^File to remove was replaced, and the replacement was kept as .*/\\.app\\.log${REMOVAL.source}`),
      );
    });
    const names = fs.readdirSync(project).sort();
    expect(names).toEqual([expect.stringMatching(new RegExp(`^\\.app\\.log${REMOVAL.source}`)), "app.log"]);
    expect(fs.readFileSync(path.join(project, names[0]!), "utf8")).toBe("replacement");
    expect(fs.readFileSync(path.join(project, "app.log"), "utf8")).toBe("newest");
  });

  it("reports a file that is already gone, with ENOENT as its cause", async () => {
    const stat = await owned("app.log");
    fs.unlinkSync(path.join(project, "app.log"));
    await withDirHandle(DirHandle.open(project), async (dir) => {
      const error = await dir.unlinkOwnedFile("app.log", stat).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RunStorageAccessError);
      expect((error as Error).message).toBe(`File to remove is gone: ${project}/app.log`);
      expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe("ENOENT");
    });
  });

  it("moves each removal to a fresh name, off entries kept under earlier ones", async () => {
    const left = [`.app.log.remove-${process.pid}-${crypto.randomUUID()}`, `.app.log.remove-${process.pid}-1`];
    for (const name of left) fs.writeFileSync(path.join(project, name), "kept");
    const removals: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      const stat = await owned("app.log");
      const removal = afterMove(() => {});
      await withDirHandle(DirHandle.open(project), (dir) => dir.unlinkOwnedFile("app.log", stat));
      removals.push(removal()!);
      vi.restoreAllMocks();
    }
    expect(removals[0]).not.toBe(removals[1]);
    expect(left).not.toContain(removals[0]);
    expect(fs.readdirSync(project).sort()).toEqual(left.sort());
    for (const name of left) expect(fs.readFileSync(path.join(project, name), "utf8")).toBe("kept");
  });

  it("names a removal abandoned only once its remover stopped", async () => {
    const stat = await owned("app.log");
    const seen: Array<string | undefined> = [];
    vi.spyOn(DirHandle.prototype, "unlinkChild").mockImplementationOnce(async (name) => {
      seen.push(abandonedRemoval(name));
      throw new Error("crash");
    });
    await withDirHandle(DirHandle.open(project), async (dir) => {
      await expect(dir.unlinkOwnedFile("app.log", stat)).rejects.toThrow("crash");
    });
    const [left] = fs.readdirSync(project);
    expect(left).toMatch(new RegExp(`^\\.app\\.log\\.remove-${process.pid}-[0-9a-f-]{36}$`));
    expect(seen).toEqual([undefined]);
    expect(abandonedRemoval(left!)).toBe("app.log");
    const dead = spawnSync("true").pid!;
    const uuid = crypto.randomUUID();
    expect(abandonedRemoval(`.app.log.remove-${dead}-${uuid}`)).toBe("app.log");
    expect(abandonedRemoval(`.app.log.remove-${process.ppid}-${uuid}`)).toBeUndefined();
    for (const name of ["app.log", ".app.log.tmp-1-2", `...remove-1-${uuid}`, `....remove-1-${uuid}`, `.app.log.remove-x-${uuid}`, `.app.log.remove-${dead}-1`]) {
      expect(abandonedRemoval(name)).toBeUndefined();
    }
  });

  it("restores a removal without replacing another entry", async () => {
    fs.writeFileSync(path.join(project, ".a.log.remove-1-1"), "moved");
    fs.writeFileSync(path.join(project, ".b.log.remove-1-2"), "moved");
    fs.writeFileSync(path.join(project, "b.log"), "other");
    fs.writeFileSync(path.join(project, ".c.log.remove-1-3"), "linked");
    fs.linkSync(path.join(project, ".c.log.remove-1-3"), path.join(project, "c.log"));
    fs.mkdirSync(path.join(project, ".d.remove-1-4"));
    fs.writeFileSync(path.join(project, ".d.remove-1-4", "inside"), "kept");
    fs.mkdirSync(path.join(project, "d"));
    fs.mkdirSync(path.join(project, ".e.remove-1-5"));
    await withDirHandle(DirHandle.open(project), async (dir) => {
      expect(await dir.restoreRemoved(".a.log.remove-1-1", "a.log")).toBe(true);
      expect(await dir.restoreRemoved(".b.log.remove-1-2", "b.log")).toBe(false);
      expect(await dir.restoreRemoved(".c.log.remove-1-3", "c.log")).toBe(true);
      // A directory cannot be linked, and renaming it could replace an empty one.
      expect(await dir.restoreRemoved(".d.remove-1-4", "d")).toBe(false);
      expect(await dir.restoreRemoved(".e.remove-1-5", "e")).toBe(false);
    });
    expect(fs.readdirSync(project).sort()).toEqual([".b.log.remove-1-2", ".d.remove-1-4", ".e.remove-1-5", "a.log", "b.log", "c.log", "d"]);
    expect(fs.readFileSync(path.join(project, "a.log"), "utf8")).toBe("moved");
    expect(fs.readFileSync(path.join(project, "b.log"), "utf8")).toBe("other");
    expect(fs.readFileSync(path.join(project, "c.log"), "utf8")).toBe("linked");
    expect(fs.readdirSync(path.join(project, "d"))).toEqual([]);
    expect(fs.readFileSync(path.join(project, ".d.remove-1-4", "inside"), "utf8")).toBe("kept");
  });

  it("accepts a restore that a concurrent restore of the same entry finished first", async () => {
    fs.writeFileSync(path.join(project, ".a.log.remove-1-1"), "moved");
    const link = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, "link").mockImplementationOnce(async (source, target) => {
      fs.linkSync(String(source), String(target));
      fs.unlinkSync(String(source));
      return link(source, target);
    });
    await withDirHandle(DirHandle.open(project), async (dir) => {
      expect(await dir.restoreRemoved(".a.log.remove-1-1", "a.log")).toBe(true);
    });
    expect(fs.readdirSync(project)).toEqual(["a.log"]);
    expect(fs.readFileSync(path.join(project, "a.log"), "utf8")).toBe("moved");
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
