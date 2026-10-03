import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendAction, readActions, type EvidenceAction } from "../src/evidence.js";
import { createRun } from "../src/run.js";

let project: string;
beforeEach(async () => {
  const base = path.join(process.cwd(), "node_modules/.cache");
  await fs.promises.mkdir(base, { recursive: true });
  project = await fs.promises.mkdtemp(path.join(base, "export-cap-"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.promises.rm(project, { recursive: true, force: true });
});
const action = (id: string, artifacts?: string[]): EvidenceAction => ({
  actionId: id, source: "cli", tool: "desktop_click", status: "ok", startedAt: "2026-10-03T12:00:00Z", artifacts,
});

it("ignores oversized top-level exports across cached snapshots and fresh scans", async () => {
  const run = await createRun(project, "cap", { evidence: true });
  const options = { maxBytes: 2048 };
  expect((await appendAction(run, action("seed"), options)).outcome).toBe("appended");
  const directory = path.join(run.dir, "exports", "first");
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, "frame.png"), Buffer.alloc(4096));
  const screenshot = path.join(run.dir, "screenshots", "next.png");
  await fs.promises.writeFile(screenshot, Buffer.alloc(32));
  for (const id of ["next", "after-export-growth"]) {
    const result = await appendAction(run, action(id, ["screenshots/next.png"]), options);
    expect(result.outcome).toBe("appended");
    const journalBytes = (await fs.promises.stat(path.join(run.dir, "actions.jsonl"))).size;
    expect(result.usedBytes).toBe(journalBytes + 32);
    await fs.promises.writeFile(path.join(directory, `${id}.mp4`), Buffer.alloc(8192));
  }
  expect((await readActions(run.dir)).map(record => record.actionId)).toEqual(["seed", "next", "after-export-growth"]);
});

it.each(["logs/payload.bin", "screenshots/exports/payload.bin", "exports"])("counts the same-sized non-export artifact %s", async relative => {
  const run = await createRun(project, "cap", { evidence: true });
  const options = { maxBytes: 2048 };
  await appendAction(run, action("seed"), options);
  const file = path.join(run.dir, relative);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, Buffer.alloc(4096));
  const result = await appendAction(run, action("next", [relative]), options);
  expect(result.outcome).toBe("capped");
  expect(result.usedBytes).toBeGreaterThanOrEqual(4096);
});
