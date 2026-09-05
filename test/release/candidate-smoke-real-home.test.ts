import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalProjectPath, deriveProjectId } from "../../packages/core/src/storage.js";

const SMOKE = path.resolve(import.meta.dirname, "../../scripts/candidate-smoke.sh");
const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-real-home-snapshot-"));
  roots.push(root);
  return root;
}

function capture(root: string, output: string): void {
  execFileSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
source "$1"
REAL_HOME="$2/home"
PROJECT="$2/work/project"
mkdir -p "$REAL_HOME" "$2/work"
set_real_home_paths
assert_real_home_project_paths_absent
capture_real_home "$3"`,
      "snapshot-test",
      SMOKE,
      root,
      output,
    ],
    { stdio: "pipe" },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("candidate smoke real-home snapshot", () => {
  it("ignores unrelated populated state and records only bounded release targets", async () => {
    const root = makeRoot();
    const unrelated = path.join(root, "home/.pickforge/unrelated/runs/old");
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(unrelated, "large.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
    const output = path.join(root, "snapshot.txt");

    capture(root, output);

    const snapshot = fs.readFileSync(output, "utf8");
    const project = path.join(root, "work/project");
    const projectId = deriveProjectId(await canonicalProjectPath(project));
    expect(snapshot).not.toContain("unrelated");
    expect(snapshot.trim().split("\n")).toHaveLength(8);
    expect(snapshot).toContain(".claude.json absent");
    expect(snapshot).toContain(`.pickforge/pickforge/projects/${projectId} absent`);
  });

  it("detects a change to an exact harness config", () => {
    const root = makeRoot();
    const config = path.join(root, "home/.codex/config.toml");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, "before = true\n");
    const before = path.join(root, "before.txt");
    const after = path.join(root, "after.txt");

    capture(root, before);
    fs.writeFileSync(config, "after = true\n");
    capture(root, after);

    expect(fs.readFileSync(after, "utf8")).not.toBe(fs.readFileSync(before, "utf8"));
  });
});
