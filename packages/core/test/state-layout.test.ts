import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DirHandle } from "../src/dir-handle.js";
import { createRun } from "../src/run.js";
import {
  claimProjectStateLayout,
  classifyEntry,
  layoutMarkerContent,
  LAYOUT_MARKER,
  LAYOUT_VERSION,
  readProjectStateLayout,
  StateLayoutError,
  type StateEntryOwner,
} from "../src/state-layout.js";
import { projectId } from "../src/storage.js";

// Project-state ownership between the TypeScript lab and the Rust integration
// CLI (#104). The Rust half of these guarantees lives in
// `crates/pickforge-cli/tests/state_layout.rs`; the cross-tool proof is
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

describe("the ownership table", () => {
  // Mirrors `entry_ownership_matches_the_documented_table` in
  // `crates/pickforge-cli/tests/state_layout.rs`. Changing one side without
  // the other splits ownership between the two tools.
  const rows: [string, StateEntryOwner][] = [
    ["layout.json", "shared"],
    ["project.json", "integration"],
    ["project.json.pickforge-backup-20260101", "integration"],
    [".pickforge-tmp-abcd", "transient"],
    [".pickforge-tmp-layout-1-2", "transient"],
    ["runs", "lab"],
    ["sessions", "foreign"],
    ["config.json", "foreign"],
    ["notes.txt", "foreign"],
    ["", "foreign"],
    ["runs2", "foreign"],
    ["project.json.bak", "foreign"],
  ];

  it.each(rows)("classifies %j as %s", (name, owner) => {
    expect(classifyEntry(name)).toBe(owner);
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
    const entries = await fs.promises.readdir(await stateDirPath());
    expect(entries).toEqual([LAYOUT_MARKER]);
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
    expect(await fs.promises.readFile(path.join(dir, LAYOUT_MARKER), "utf8")).toBe(
      layoutMarkerContent(),
    );
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

    expect(await fs.promises.readFile(path.join(dir, "project.json"), "utf8")).toBe(
      receipt,
    );
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

describe("run storage claims the layout", () => {
  it("stamps the marker on the lab's first run", async () => {
    await createRun(project, "first");
    const dir = await stateDirPath();
    expect(await fs.promises.readFile(path.join(dir, LAYOUT_MARKER), "utf8")).toBe(
      layoutMarkerContent(),
    );
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

    expect(await fs.promises.readFile(path.join(dir, "project.json"), "utf8")).toBe(
      receipt,
    );
    const entries = (await fs.promises.readdir(dir)).sort();
    expect(entries).toEqual([LAYOUT_MARKER, "project.json", "runs"]);
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
    expect(
      fs.existsSync(path.join(project, ".picklab", LAYOUT_MARKER)),
    ).toBe(false);
  });
});
