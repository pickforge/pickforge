import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendAction,
  beginEvidenceRun,
  isTruncationRecord,
  readActions,
  resolveActivePointer,
} from "../src/evidence.js";

// These tests spawn genuine separate OS processes (via `bun`, the repo's test
// runtime) so the journal's O_APPEND atomicity and the wx pointer protocol are
// proven under real concurrency, not just in-process Promise.all. `bun` runs the
// TypeScript workers directly; the Node 20.19 CI floor cannot strip TS types, so
// the workers cannot be plain `node -e` scripts that import the source.
const BUN = /[\\/]bun$/.test(process.execPath) ? process.execPath : "bun";

const appendWorker = fileURLToPath(
  new URL("./workers/evidence-append-worker.ts", import.meta.url),
);
const beginWorker = fileURLToPath(
  new URL("./workers/evidence-begin-worker.ts", import.meta.url),
);
const truncateWorker = fileURLToPath(
  new URL("./workers/evidence-truncate-worker.ts", import.meta.url),
);
const crashWorker = fileURLToPath(
  new URL("./workers/evidence-marker-crash-worker.ts", import.meta.url),
);

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(BUN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let project: string;

// Pin storage to `project-local` (the layout these concurrency tests assert
// against and spawn separate `bun` worker processes into via inherited
// `process.env`) rather than the new `home` default.
beforeEach(async () => {
  project = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-evc-"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.promises.rm(project, { recursive: true, force: true });
});

describe("real separate-process concurrency", () => {
  it(
    "loses zero actions across concurrent appender processes",
    async () => {
      const { run: handle } = await beginEvidenceRun(project, "desk-append0");
      const workerCount = 4;
      const perWorker = 150;

      const results = await Promise.all(
        Array.from({ length: workerCount }, (_unused, worker) =>
          run([appendWorker, handle.dir, `w${worker}`, String(perWorker)]),
        ),
      );
      for (const result of results) {
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
      }

      // readActions throws on any torn or interleaved line, so a clean parse of
      // exactly workerCount * perWorker records proves atomic appends.
      const records = await readActions(handle.dir);
      expect(records).toHaveLength(workerCount * perWorker);
      const ids = new Set(records.map((r) => r.actionId));
      expect(ids.size).toBe(workerCount * perWorker);
      for (let worker = 0; worker < workerCount; worker += 1) {
        for (let index = 0; index < perWorker; index += 1) {
          expect(ids.has(`w${worker}-${index}`)).toBe(true);
        }
      }
    },
    30000,
  );

  it(
    "races separate begin processes to one run with no orphan dirs",
    async () => {
      const sessionId = "desk-procrace";
      const racerCount = 8;
      // Each racer holds alive for the race window so the single winner (the
      // run's owner) stays live while the losers resolve and adopt its pointer.
      // A run whose owner has exited is a recoverable orphan by design, so
      // without overlapping lifetimes the losers would each recover a fresh run
      // instead of adopting — which is correct behavior, not a claim-race bug.
      const holdMs = 1500;
      const results = await Promise.all(
        Array.from({ length: racerCount }, () =>
          run([beginWorker, project, sessionId, String(holdMs)]),
        ),
      );

      const parsed = results.map((result) => {
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        return JSON.parse(result.stdout.trim()) as {
          runId: string;
          adopted: boolean;
        };
      });

      const winners = parsed.filter((p) => !p.adopted);
      const adopters = parsed.filter((p) => p.adopted);
      expect(winners).toHaveLength(1);
      expect(adopters).toHaveLength(racerCount - 1);
      const runId = winners[0]!.runId;
      for (const p of parsed) expect(p.runId).toBe(runId);

      // Exactly one run directory exists — no orphan runs from the losers.
      const runDirs = (
        await fs.promises.readdir(path.join(project, ".picklab", "runs"))
      ).filter((entry) => !entry.startsWith("."));
      expect(runDirs).toEqual([runId]);

      // Every racer process has now exited, so the recorded owner is dead: the
      // pointer resolves as stale (recoverable) while still naming the single
      // winning run — no orphan, and a fresh begin would recover cleanly.
      const resolution = await resolveActivePointer(project, sessionId);
      expect(resolution.status).toBe("stale");
      if (resolution.status !== "stale") throw new Error("expected stale");
      expect(resolution.pointer?.runId).toBe(runId);
    },
    30000,
  );

  it(
    "writes exactly one truncation marker across concurrent processes",
    async () => {
      const { run: handle } = await beginEvidenceRun(project, "desk-trunc0");
      const maxBytes = 4096;
      // Push the run over its cap on disk before the workers start, so every
      // worker's first append is already in the truncation path and they
      // genuinely contend on the one-time marker sentinel across processes.
      await fs.promises.writeFile(
        path.join(handle.dir, "screenshots", "big.bin"),
        Buffer.alloc(maxBytes + 1000),
      );
      const workerCount = 4;
      const perWorker = 50;
      const results = await Promise.all(
        Array.from({ length: workerCount }, (_unused, worker) =>
          run([
            truncateWorker,
            handle.dir,
            `t${worker}`,
            String(perWorker),
            String(maxBytes),
          ]),
        ),
      );
      for (const result of results) {
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
      }

      const records = await readActions(handle.dir);
      // Exactly one marker despite 4 processes each racing to write it.
      expect(records.filter((r) => isTruncationRecord(r))).toHaveLength(1);
      // Every worker's metadata-only action after the cap is still recorded.
      const ids = new Set(records.map((r) => r.actionId));
      for (let worker = 0; worker < workerCount; worker += 1) {
        for (let index = 0; index < perWorker; index += 1) {
          expect(ids.has(`t${worker}-${index}`)).toBe(true);
        }
      }
    },
    30000,
  );

  it(
    "recovers the marker after a process crashes mid-claim",
    async () => {
      const { run: handle } = await beginEvidenceRun(project, "desk-crash0");
      const maxBytes = 4096;
      await fs.promises.writeFile(
        path.join(handle.dir, "screenshots", "big.bin"),
        Buffer.alloc(maxBytes + 1000),
      );

      // A worker crosses the cap, stamps the marker claim, then exits abruptly
      // (code 42) before appending the marker — the P3 crash window.
      const crashed = await run([crashWorker, handle.dir, String(maxBytes)]);
      expect(crashed.code).toBe(42);
      // It left an uncommitted claim and no marker: unrecovered, this would gate
      // truncation forever.
      const before = await readActions(handle.dir);
      expect(before.some((r) => isTruncationRecord(r))).toBe(false);

      // A later append sees the dead owner, reclaims the stale claim, and writes
      // the marker exactly once.
      const recovered = await appendAction(
        handle.dir,
        {
          actionId: "after",
          source: "test",
          tool: "truncate",
          startedAt: new Date().toISOString(),
          status: "ok",
        },
        { maxBytes, maxLineBytes: 4096 },
      );
      expect(recovered.outcome).toBe("truncated");
      const records = await readActions(handle.dir);
      expect(records.filter((r) => isTruncationRecord(r))).toHaveLength(1);
    },
    30000,
  );
});
