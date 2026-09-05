import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DirHandle, RunStorageAccessError } from "../src/dir-handle.js";
import { createRun } from "../src/run.js";
import {
  claimProjectStateLayout,
  classifyEntry,
  layoutMarkerContent,
  LAYOUT_KIND,
  LAYOUT_MARKER,
  LAYOUT_VERSION,
  manualAction,
  readProjectStateLayout,
  StateLayoutError,
  TMP_PREFIX,
  type StateEntryOwner,
} from "../src/state-layout.js";
import { projectId } from "../src/storage.js";

// Project-state ownership between the TypeScript lab and the Rust integration
// CLI (#104). The Rust half of these guarantees lives in
// `crates/pickforge-cli/tests/state_layout.rs` and
// `crates/pickforge-cli/tests/evidence_layout.rs`; the cross-tool proof, with
// both real binaries racing each other, is
// `scripts/state-ownership-smoke.sh`.

let root: string;
let project: string;
let home: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pickforge-state-layout-"),
  );
  project = path.join(root, "project");
  home = path.join(root, "home");
  await fs.promises.mkdir(project);
  vi.stubEnv("PICKFORGE_HOME", home);
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "home");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function stateDirPath(): Promise<string> {
  return path.join(home, "projects", await projectId(project));
}

/** An open handle on the project state directory, creating it if needed. */
async function openStateDir(): Promise<DirHandle> {
  const dir = await stateDirPath();
  await fs.promises.mkdir(dir, { recursive: true });
  return DirHandle.open(dir);
}

async function withStateDir<T>(fn: (dir: DirHandle) => Promise<T>): Promise<T> {
  const handle = await openStateDir();
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

/** Entry names directly inside the project state directory. */
async function entries(): Promise<string[]> {
  return (await fs.promises.readdir(await stateDirPath())).sort();
}

describe("the shared ownership fixture", () => {
  // `test/fixtures/state-layout.json` is the one table both implementations
  // check: `crates/pickforge-cli/tests/state_layout.rs` reads the same file.
  // Changing one implementation's table without the fixture fails both suites,
  // so the two tools cannot silently diverge.
  const fixture = JSON.parse(
    fs.readFileSync(
      fileURLToPath(
        new URL("../../../test/fixtures/state-layout.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as {
    layoutKind: string;
    layoutVersion: number;
    markerContent: string;
    ownership: { entry: string; owner: StateEntryOwner }[];
  };

  it("pins the marker bytes both tools write", () => {
    expect(fixture.layoutKind).toBe(LAYOUT_KIND);
    expect(fixture.layoutVersion).toBe(LAYOUT_VERSION);
    expect(fixture.markerContent).toBe(layoutMarkerContent());
  });

  it.each(fixture.ownership)("classifies $entry as $owner", ({ entry, owner }) => {
    expect(classifyEntry(entry)).toBe(owner);
  });
});

describe("the manual action", () => {
  it("is shell-quoted and never clobbers", () => {
    const action = manualAction("/tmp/a b/it's here", "is not owned");
    expect(action).toContain(
      `\`mv -n -- '/tmp/a b/it'\\''s here' '/tmp/a b/it'\\''s here.bak'\``,
    );
  });

  it("skips a destination that already exists", async () => {
    const entry = path.join(root, "notes.txt");
    await fs.promises.writeFile(entry, "x");
    await fs.promises.writeFile(`${entry}.bak`, "x");
    expect(manualAction(entry, "is not owned")).toContain(`${entry}.bak-2'`);
  });

  it("offers no command for a name that cannot be a safe shell word", () => {
    const action = manualAction("/tmp/we\nird", "is not owned");
    expect(action).not.toContain("mv -n");
    expect(action).toContain("Move it aside yourself");
  });
});

describe("claiming a project state directory", () => {
  it("writes the marker once and reports the winner", async () => {
    await withStateDir(async (dir) => {
      expect(await claimProjectStateLayout(dir)).toBe(true);
      expect(await claimProjectStateLayout(dir)).toBe(false);
    });
    const marker = path.join(await stateDirPath(), LAYOUT_MARKER);
    expect(await fs.promises.readFile(marker, "utf8")).toBe(
      layoutMarkerContent(),
    );
  });

  it("leaves no transient entry behind", async () => {
    await withStateDir((dir) => claimProjectStateLayout(dir));
    expect(await entries()).toEqual([LAYOUT_MARKER]);
  });

  // Concurrent first use must not let any caller observe a half-written
  // marker: the loser of the race reads complete content or nothing.
  it("produces exactly one winner under concurrency", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    const handles = await Promise.all(
      Array.from({ length: 16 }, () => DirHandle.open(dir)),
    );
    try {
      const claimed = await Promise.all(
        handles.map((handle) => claimProjectStateLayout(handle)),
      );
      expect(claimed.filter(Boolean)).toHaveLength(1);
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
    }
    expect(
      await fs.promises.readFile(path.join(dir, LAYOUT_MARKER), "utf8"),
    ).toBe(layoutMarkerContent());
  });

  it("adopts a directory an earlier release wrote, without touching it", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(path.join(dir, "runs", "20260101-000000-old"), {
      recursive: true,
    });
    // An alpha.1/alpha.2 receipt written by the Rust CLI.
    const receipt = '{"schemaVersion":1,"projectPath":"/x","projectId":"y"}\n';
    await fs.promises.writeFile(path.join(dir, "project.json"), receipt);

    await withStateDir(async (handle) => {
      expect(await readProjectStateLayout(handle)).toBeUndefined();
      expect(await claimProjectStateLayout(handle)).toBe(true);
      expect(await readProjectStateLayout(handle)).toBe(LAYOUT_VERSION);
    });

    expect(
      await fs.promises.readFile(path.join(dir, "project.json"), "utf8"),
    ).toBe(receipt);
    expect(fs.existsSync(path.join(dir, "runs", "20260101-000000-old"))).toBe(
      true,
    );
  });

  it("refuses a newer layout version with an upgrade instruction", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, LAYOUT_MARKER),
      '{"layout":"pickforge-project-state","layoutVersion":99}\n',
    );
    await expect(
      withStateDir((handle) => claimProjectStateLayout(handle)),
    ).rejects.toThrow(/layout version 99.*Upgrade Pickforge/s);
  });

  it("refuses a stray layout.json rather than adopting it", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, LAYOUT_MARKER),
      '{"layout":"something-else"}\n',
    );
    await expect(
      withStateDir((handle) => claimProjectStateLayout(handle)),
    ).rejects.toThrow(StateLayoutError);
  });
});

describe("the marker's shape", () => {
  it("refuses a symlinked marker even when it points at valid bytes", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    const outside = path.join(root, "outside.json");
    await fs.promises.writeFile(outside, layoutMarkerContent());
    await fs.promises.symlink(outside, path.join(dir, LAYOUT_MARKER));

    await expect(
      withStateDir((handle) => readProjectStateLayout(handle)),
    ).rejects.toThrow(/is a symbolic link/);
    await expect(
      withStateDir((handle) => claimProjectStateLayout(handle)),
    ).rejects.toThrow(/is a symbolic link/);
    // Nothing was written through the link.
    expect(await fs.promises.readFile(outside, "utf8")).toBe(
      layoutMarkerContent(),
    );
    expect((await fs.promises.lstat(path.join(dir, LAYOUT_MARKER))).isSymbolicLink()).toBe(
      true,
    );
  });

  it("refuses a marker that has a second name", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    const marker = path.join(dir, LAYOUT_MARKER);
    await fs.promises.writeFile(marker, layoutMarkerContent());
    await fs.promises.link(marker, path.join(root, "elsewhere"));

    await expect(
      withStateDir((handle) => claimProjectStateLayout(handle)),
    ).rejects.toThrow(/hard link/);
  });

  it("refuses a marker that is not a regular file", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(path.join(dir, LAYOUT_MARKER), { recursive: true });

    await expect(
      withStateDir((handle) => readProjectStateLayout(handle)),
    ).rejects.toThrow(/is not a regular file/);
  });
});

describe("a marker that could block a reader", () => {
  // Every case here is about a marker a *blocking* open would never come back
  // from, so "refused" is only half the guarantee: the other half is that the
  // answer arrives at all. Each assertion races the call against a timeout, so
  // a regression fails the test instead of hanging the suite.
  // Below vitest's own 5 s test timeout, so a regression is reported as the
  // block it is rather than as a generic slow test.
  const CALL_TIMEOUT_MS = 3_000;

  async function withinTimeout<T>(what: string, work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${what} blocked for ${CALL_TIMEOUT_MS} ms`)),
            CALL_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Create a FIFO with `mkfifo(1)`; Node has no binding for it. */
  async function mkfifo(target: string): Promise<void> {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      execFile("mkfifo", ["--", target], (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  it("refuses a FIFO marker instead of blocking on it", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    await mkfifo(path.join(dir, LAYOUT_MARKER));

    await expect(
      withinTimeout(
        "readProjectStateLayout on a FIFO marker",
        withStateDir((handle) => readProjectStateLayout(handle)),
      ),
    ).rejects.toThrow(/is not a regular file.*named pipe/s);
    await expect(
      withinTimeout(
        "claimProjectStateLayout on a FIFO marker",
        withStateDir((handle) => claimProjectStateLayout(handle)),
      ),
    ).rejects.toThrow(StateLayoutError);
    // The FIFO is the user's: refused, never replaced or removed.
    expect(await entries()).toEqual([LAYOUT_MARKER]);
  });

  it("refuses a socket marker instead of blocking on it", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    const net = await import("node:net");
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(path.join(dir, LAYOUT_MARKER), resolve),
    );
    try {
      await expect(
        withinTimeout(
          "readProjectStateLayout on a socket marker",
          withStateDir((handle) => readProjectStateLayout(handle)),
        ),
      ).rejects.toThrow(/is not a regular file.*socket/s);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a FIFO run tree instead of blocking on it", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    await mkfifo(path.join(dir, "runs"));

    await expect(
      withinTimeout(
        "claimProjectStateLayout beside a FIFO run tree",
        withStateDir((handle) => claimProjectStateLayout(handle)),
      ),
    ).rejects.toThrow(/runs is not a directory.*named pipe/s);
    expect(fs.existsSync(path.join(dir, LAYOUT_MARKER))).toBe(false);
  });
});

describe("the publication window", () => {
  // A marker is multiply linked for as long as its publisher holds the staging
  // entry. That window is waited out; a second name that is *not* a
  // publication in flight is a planted hard link and is refused (#104 R6).
  it("waits out a publisher that is slower than the old fixed window", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    const staging = path.join(dir, `${TMP_PREFIX}layout-slowpublisher`);
    await fs.promises.writeFile(staging, layoutMarkerContent());
    await fs.promises.link(staging, path.join(dir, LAYOUT_MARKER));

    // 400 ms — twice the old 40 × 5 ms window — between `link(2)` and the
    // unlink of the staging entry.
    const publisher = new Promise<void>((resolve) => {
      setTimeout(() => {
        fs.promises.unlink(staging).then(resolve, resolve);
      }, 400);
    });

    expect(
      await withStateDir((handle) => readProjectStateLayout(handle)),
    ).toBe(LAYOUT_VERSION);
    await publisher;
  });

  it("refuses a planted hard link without waiting for a publisher", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    const marker = path.join(dir, LAYOUT_MARKER);
    await fs.promises.writeFile(marker, layoutMarkerContent());
    await fs.promises.link(marker, path.join(root, "elsewhere"));

    const started = Date.now();
    await expect(
      withStateDir((handle) => readProjectStateLayout(handle)),
    ).rejects.toThrow(/hard link/);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("owned entries must have the shape their owner writes", () => {
  it("refuses a symlinked run tree before the marker is stamped", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    const outside = path.join(root, "outside-runs");
    await fs.promises.mkdir(outside);
    await fs.promises.symlink(outside, path.join(dir, "runs"));

    await expect(
      withStateDir((handle) => claimProjectStateLayout(handle)),
    ).rejects.toThrow(/runs is not a directory.*symbolic link.*mv -n --/s);
    // Nothing stamped, nothing written through the link.
    expect(fs.existsSync(path.join(dir, LAYOUT_MARKER))).toBe(false);
    expect(await fs.promises.readdir(outside)).toEqual([]);
  });

  // The lab's own run creation goes through the same claim, so a symlinked
  // `runs` stops a run before any marker certifies the directory.
  it("stops a lab run from adopting a directory with a symlinked run tree", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.symlink(root, path.join(dir, "runs"));

    await expect(createRun(project, "blocked")).rejects.toThrow(
      /runs is not a directory/,
    );
    expect(fs.existsSync(path.join(dir, LAYOUT_MARKER))).toBe(false);
  });

  it("refuses a symlinked receipt before the marker is stamped", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    const outside = path.join(root, "outside.json");
    await fs.promises.writeFile(outside, "{}\n");
    await fs.promises.symlink(outside, path.join(dir, "project.json"));

    await expect(
      withStateDir((handle) => claimProjectStateLayout(handle)),
    ).rejects.toThrow(/project\.json is not a regular file.*symbolic link/s);
    expect(fs.existsSync(path.join(dir, LAYOUT_MARKER))).toBe(false);
    expect(await fs.promises.readFile(outside, "utf8")).toBe("{}\n");
  });

  // The shape rule must not cost a legitimate upgrade: this is exactly what an
  // alpha.1/alpha.2 directory holds.
  it("still adopts a real legacy directory in place", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(path.join(dir, "runs", "20260101-000000-old"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(dir, "project.json"),
      '{"schemaVersion":1}\n',
    );
    await fs.promises.writeFile(
      path.join(dir, "project.json.pickforge-backup-20260101"),
      '{"schemaVersion":1}\n',
    );
    await fs.promises.writeFile(
      path.join(dir, `${TMP_PREFIX}crash`),
      "remnant\n",
    );

    expect(await withStateDir((handle) => claimProjectStateLayout(handle))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(dir, "runs", "20260101-000000-old"))).toBe(
      true,
    );
  });
});

describe("a name that is not valid UTF-8", () => {
  // Node decodes such a name with U+FFFD, so the string does not address the
  // file. The lab used to print an `mv -n --` whose source path could not
  // match the real bytes; it now describes the entry, exactly as the Rust CLI
  // does (#104 R5).
  it("is described, never offered as a command", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      Buffer.concat([
        Buffer.from(`${dir}/bad-`, "utf8"),
        Buffer.from([0xff]),
        Buffer.from("-name", "utf8"),
      ]),
      "x",
    );

    const error = await withStateDir((handle) =>
      claimProjectStateLayout(handle).then(
        () => undefined,
        (thrown: Error) => thrown,
      ),
    );
    expect(error?.message).toMatch(/not valid UTF-8/);
    expect(error?.message).not.toContain("mv -n");
    expect(error?.message).toContain("Move it aside yourself");
    expect(fs.existsSync(path.join(dir, LAYOUT_MARKER))).toBe(false);
  });

  it("never renders a replacement character as a shell command", () => {
    const action = manualAction("/tmp/bad-\ufffd-name", "is not owned");
    expect(action).not.toContain("mv -n");
    expect(action).toContain("Move it aside yourself");
  });
});

describe("the modes of directories the lab creates", () => {
  // The Rust CLI creates every project-state directory `0700`; the lab used to
  // create them with the process umask (#104 R4). Newly created directories
  // only: an existing directory's permissions are never rewritten.
  it("creates the state, projects, project, and runs directories 0700", async () => {
    await createRun(project, "modes");
    const dir = await stateDirPath();
    for (const target of [
      home,
      path.join(home, "projects"),
      dir,
      path.join(dir, "runs"),
    ]) {
      expect((await fs.promises.stat(target)).mode & 0o777).toBe(0o700);
    }
  });

  it("does not change the mode of a directory that already exists", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });
    await fs.promises.chmod(dir, 0o755);
    await fs.promises.chmod(path.join(home, "projects"), 0o755);

    await createRun(project, "existing");

    expect((await fs.promises.stat(dir)).mode & 0o777).toBe(0o755);
    expect(
      (await fs.promises.stat(path.join(home, "projects"))).mode & 0o777,
    ).toBe(0o755);
  });
});

describe("staging entries", () => {
  // The pre-fix claim derived its temp name from the pid and a counter, so a
  // crash remnant plus pid reuse made every new process take the `EEXIST`
  // path, delete the pre-existing entry, and continue with *no* marker.
  it("never adopts or deletes an entry it did not create", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    // Every name the pre-fix claim could have derived from this pid, so the
    // test does not depend on where its internal counter happens to be.
    const stale = Array.from(
      { length: 256 },
      (_, index) => `${TMP_PREFIX}layout-${process.pid}-${index + 1}`,
    );
    for (const name of stale) {
      await fs.promises.writeFile(path.join(dir, name), "crash remnant\n");
    }
    const planted = path.join(dir, `${TMP_PREFIX}layout-planted`);
    await fs.promises.symlink(path.join(root, "outside"), planted);

    expect(await withStateDir((handle) => claimProjectStateLayout(handle))).toBe(
      true,
    );

    expect(
      await fs.promises.readFile(path.join(dir, LAYOUT_MARKER), "utf8"),
    ).toBe(layoutMarkerContent());
    for (const name of stale) {
      expect(await fs.promises.readFile(path.join(dir, name), "utf8")).toBe(
        "crash remnant\n",
      );
    }
    expect((await fs.promises.lstat(planted)).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(root, "outside"))).toBe(false);
    expect(await entries()).toEqual(
      [...stale, `${TMP_PREFIX}layout-planted`, LAYOUT_MARKER].sort(),
    );
  });

  it("removes only the staging entry this claim created", async () => {
    await withStateDir((handle) => claimProjectStateLayout(handle));
    expect(await entries()).toEqual([LAYOUT_MARKER]);
  });
});

describe("the winning marker", () => {
  // Losing the publication race is only safe if the winner's marker is really
  // there: a claim must never continue into an unclaimed directory.
  it("must exist and validate when publication reports EEXIST", async () => {
    await expect(
      withStateDir(async (handle) => {
        vi.spyOn(handle, "linkChild").mockRejectedValue(
          Object.assign(new Error("exists"), { code: "EEXIST" }),
        );
        return claimProjectStateLayout(handle);
      }),
    ).rejects.toThrow(RunStorageAccessError);
    expect(await entries()).toEqual([]);
  });

  it("reports a publication failure as itself, not as a lost race", async () => {
    await expect(
      withStateDir(async (handle) => {
        vi.spyOn(handle, "linkChild").mockRejectedValue(
          Object.assign(new Error("no space"), { code: "ENOSPC" }),
        );
        return claimProjectStateLayout(handle);
      }),
    ).rejects.toThrow(/could not be written/);
    expect(await entries()).toEqual([]);
  });
});

describe("the direct-entry rule", () => {
  it("refuses a foreign entry before a first adoption", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "notes.txt"), "not ours\n");

    await expect(
      withStateDir((handle) => claimProjectStateLayout(handle)),
    ).rejects.toThrow(/notes\.txt is not owned by Pickforge.*mv -n --/s);
    expect(await entries()).toEqual(["notes.txt"]);
  });

  // Enforced in production, not only in this suite: the lab's own run creation
  // goes through the same claim.
  it("stops a lab run from adopting a directory holding unowned state", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "notes.txt"), "not ours\n");

    await expect(createRun(project, "blocked")).rejects.toThrow(
      /notes\.txt is not owned by Pickforge/,
    );
    expect(await entries()).toEqual(["notes.txt"]);
  });

  it("does not re-police a directory that is already claimed", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    await withStateDir((handle) => claimProjectStateLayout(handle));
    await fs.promises.writeFile(path.join(dir, "notes.txt"), "added later\n");

    expect(await withStateDir((handle) => claimProjectStateLayout(handle))).toBe(
      false,
    );
    const run = await createRun(project, "later");
    await run.finish("completed");
  });
});

describe("run storage claims the layout", () => {
  it("stamps the marker on the lab's first run", async () => {
    await createRun(project, "first");
    const dir = await stateDirPath();
    expect(
      await fs.promises.readFile(path.join(dir, LAYOUT_MARKER), "utf8"),
    ).toBe(layoutMarkerContent());
  });

  // The lab-first order from #104: an integration receipt written afterwards
  // must find its own state directory already claimed and consistent.
  it("coexists with an integration receipt written before or after a run", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    const receipt = '{"schemaVersion":1,"projectPath":"/x","projectId":"y"}\n';
    await fs.promises.writeFile(path.join(dir, "project.json"), receipt);

    const run = await createRun(project, "after-init");
    await run.finish("completed");

    expect(
      await fs.promises.readFile(path.join(dir, "project.json"), "utf8"),
    ).toBe(receipt);
    expect(await entries()).toEqual([LAYOUT_MARKER, "project.json", "runs"]);
  });

  it("fails closed under a newer layout without creating any run", async () => {
    const dir = await stateDirPath();
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, LAYOUT_MARKER),
      '{"layout":"pickforge-project-state","layoutVersion":99}\n',
    );
    await expect(createRun(project, "blocked")).rejects.toThrow(
      /layout version 99/,
    );
    expect(fs.existsSync(path.join(dir, "runs"))).toBe(false);
  });

  // `project-local` and `custom` roots are the lab's alone, so they carry no
  // marker: stamping one there would imply a shared owner that does not exist.
  it("does not claim a layout in project-local mode", async () => {
    vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
    await createRun(project, "local");
    expect(fs.existsSync(path.join(project, ".picklab", LAYOUT_MARKER))).toBe(
      false,
    );
  });
});
