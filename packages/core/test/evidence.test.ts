import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  activePointerPath,
  appendAction,
  beginEvidenceRun,
  clearActivePointer,
  finalizeActiveEvidenceRun,
  isEvidenceRun,
  isEvidenceTruncated,
  isTruncationRecord,
  pruneFinalizedEvidenceRuns,
  readActions,
  resolveActivePointer,
  type EvidenceAction,
  type EvidenceRecord,
} from "../src/evidence.js";
import { createRun, listRuns, RunHandle } from "../src/run.js";

let project: string;

// This file exercises the concurrency/security invariants of the run
// catalog and claim protocol directly against `.picklab/runs`, so it pins
// storage to `project-local` (the pre-#34 layout it was written against)
// rather than the new `home` default. `home`-mode default behavior itself is
// covered by storage.test.ts and run-catalog.test.ts.
beforeEach(async () => {
  project = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-evi-"));
  vi.stubEnv("PICKFORGE_STORAGE_MODE", "project-local");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.promises.rm(project, { recursive: true, force: true });
});

function runsRoot(): string {
  return path.join(project, ".picklab", "runs");
}

function action(overrides: Partial<EvidenceAction> = {}): EvidenceAction {
  return {
    actionId: overrides.actionId ?? "a1",
    source: overrides.source ?? "mcp",
    tool: overrides.tool ?? "desktop_click",
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    status: overrides.status ?? "ok",
    ...overrides,
  };
}

describe("manifest evidence fields", () => {
  it("stamps evidence manifests and creates an empty journal", async () => {
    const run = await createRun(project, "evi", { evidence: true });
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(run.dir, "manifest.json"), "utf8"),
    );
    expect(manifest.evidenceVersion).toBe(1);
    expect(manifest.actionLog).toBe("actions.jsonl");
    expect(fs.existsSync(path.join(run.dir, "actions.jsonl"))).toBe(true);
    expect(await fs.promises.readFile(path.join(run.dir, "actions.jsonl"), "utf8")).toBe("");
    expect(isEvidenceRun(manifest)).toBe(true);
  });

  it("leaves plain runs unchanged and non-evidence", async () => {
    const run = await createRun(project, "plain");
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(run.dir, "manifest.json"), "utf8"),
    );
    expect(manifest.evidenceVersion).toBeUndefined();
    expect(manifest.actionLog).toBeUndefined();
    expect(fs.existsSync(path.join(run.dir, "actions.jsonl"))).toBe(false);
    expect(isEvidenceRun(manifest)).toBe(false);
  });

  it("lists legacy and evidence manifests together (backward compatible)", async () => {
    await createRun(project, "legacy", { now: new Date("2026-06-09T08:00:00Z") });
    await beginEvidenceRun(project, "desk-aaaaaa", {
      slug: "evi",
      now: new Date("2026-06-09T09:00:00Z"),
    });
    const runs = await listRuns(project);
    expect(runs.map((r) => r.slug)).toEqual(["evi", "legacy"]);
    const legacy = runs.find((r) => r.slug === "legacy");
    expect(legacy?.evidenceVersion).toBeUndefined();
    expect(legacy?.artifacts).toEqual([]);
  });
});

describe("beginEvidenceRun and the active pointer", () => {
  it("creates a run, journal, and published pointer", async () => {
    const { run, adopted } = await beginEvidenceRun(project, "desk-abc123");
    expect(adopted).toBe(false);
    expect(run.manifest.evidenceVersion).toBe(1);
    const resolution = await resolveActivePointer(project, "desk-abc123");
    expect(resolution.status).toBe("active");
    if (resolution.status !== "active") throw new Error("expected active");
    expect(resolution.pointer.runId).toBe(run.runId);
    expect(resolution.pointer.sessionId).toBe("desk-abc123");
    expect(resolution.manifest.status).toBe("running");
  });

  it("adopts the existing active run for the same session", async () => {
    const first = await beginEvidenceRun(project, "desk-abc123");
    const second = await beginEvidenceRun(project, "desk-abc123");
    expect(second.adopted).toBe(true);
    expect(second.run.runId).toBe(first.run.runId);
    const dirs = await fs.promises.readdir(runsRoot());
    const runDirs = dirs.filter((d) => !d.startsWith("."));
    expect(runDirs).toHaveLength(1);
  });

  it("keeps distinct sessions on distinct runs and pointers", async () => {
    const a = await beginEvidenceRun(project, "desk-aaaaaa");
    const b = await beginEvidenceRun(project, "andr-bbbbbb");
    expect(a.run.runId).not.toBe(b.run.runId);
    expect(fs.existsSync(await activePointerPath(project, "desk-aaaaaa"))).toBe(true);
    expect(fs.existsSync(await activePointerPath(project, "andr-bbbbbb"))).toBe(true);
  });

  it("rejects unsafe session ids", async () => {
    for (const bad of ["../escape", "a/b", "..", ".hidden", ""]) {
      await expect(beginEvidenceRun(project, bad)).rejects.toThrow(/session id/i);
    }
  });

  it("races in-process to exactly one run with the rest adopting", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => beginEvidenceRun(project, "desk-race00")),
    );
    const winners = results.filter((r) => !r.adopted);
    const adopters = results.filter((r) => r.adopted);
    expect(winners).toHaveLength(1);
    expect(adopters).toHaveLength(11);
    for (const r of results) {
      expect(r.run.runId).toBe(winners[0]!.run.runId);
    }
    const runDirs = (await fs.promises.readdir(runsRoot())).filter(
      (d) => !d.startsWith("."),
    );
    expect(runDirs).toEqual([winners[0]!.run.runId]);
  });

  it("never lets a slow live winner be stolen by racing peers", async () => {
    // The winner claims the pointer and then blocks in `_afterClaim` — a live
    // owner holding an un-published claim — while peers race it. The peers must
    // recognize the claim's owner is alive and wait, never reclaiming it on a
    // timeout, so the outcome is exactly one run with the peers adopting it.
    let releaseWinner: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let signalClaimed: () => void = () => {};
    const claimed = new Promise<void>((resolve) => {
      signalClaimed = resolve;
    });

    const winnerPromise = beginEvidenceRun(project, "desk-slow00", {
      _afterClaim: async () => {
        signalClaimed();
        await gate; // hold the claim open while peers race it
      },
    });

    // Wait until the winner has stamped its claim, then launch the peers so they
    // genuinely contend with a live-but-slow claimer.
    await claimed;
    const peerPromises = Array.from({ length: 5 }, () =>
      beginEvidenceRun(project, "desk-slow00"),
    );
    // Give the peers time to spin against the live claim without stealing it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseWinner();

    const winner = await winnerPromise;
    const peers = await Promise.all(peerPromises);

    expect(winner.adopted).toBe(false);
    for (const peer of peers) {
      expect(peer.adopted).toBe(true);
      expect(peer.run.runId).toBe(winner.run.runId);
    }
    // Exactly one run directory — no orphan from a stolen-then-recreated claim.
    const runDirs = (await fs.promises.readdir(runsRoot())).filter(
      (d) => !d.startsWith("."),
    );
    expect(runDirs).toEqual([winner.run.runId]);

    const resolution = await resolveActivePointer(project, "desk-slow00");
    expect(resolution.status).toBe("active");
    if (resolution.status !== "active") throw new Error("expected active");
    expect(resolution.pointer.runId).toBe(winner.run.runId);
  });

  it("waits for an in-flight claim before finalizing the published run", async () => {
    const sessionId = "desk-finalize-claim";
    const beginning = beginEvidenceRun(project, sessionId, {
      _afterClaim: async () => {
        await delay(75);
      },
    });
    while (
      (await resolveActivePointer(project, sessionId)).status !== "claiming"
    ) {
      await delay(1);
    }

    const finalized = finalizeActiveEvidenceRun(project, sessionId, "failed");
    const [begun, manifest] = await Promise.all([beginning, finalized]);

    expect(manifest).toMatchObject({
      runId: begun.run.runId,
      status: "failed",
    });
    expect(await resolveActivePointer(project, sessionId)).toEqual({
      status: "absent",
    });
  });
});

describe("pointer resolution and clearing", () => {
  it("reports absent when there is no pointer", async () => {
    expect((await resolveActivePointer(project, "desk-none00")).status).toBe(
      "absent",
    );
  });

  it("treats an empty pointer as a peer mid-claim", async () => {
    await fs.promises.mkdir(runsRoot(), { recursive: true });
    await fs.promises.writeFile(await activePointerPath(project, "desk-claim0"), "");
    expect((await resolveActivePointer(project, "desk-claim0")).status).toBe(
      "claiming",
    );
  });

  it("reports corrupt for unparseable pointer content", async () => {
    await fs.promises.mkdir(runsRoot(), { recursive: true });
    await fs.promises.writeFile(
      await activePointerPath(project, "desk-corr00"),
      "{ not json",
    );
    expect((await resolveActivePointer(project, "desk-corr00")).status).toBe(
      "corrupt",
    );
  });

  it("reports stale when the referenced run is finalized", async () => {
    const { run } = await beginEvidenceRun(project, "desk-fin000");
    await run.finish("completed");
    const resolution = await resolveActivePointer(project, "desk-fin000");
    expect(resolution.status).toBe("stale");
  });

  it("clears only stale/corrupt pointers by default, not active ones", async () => {
    const { run } = await beginEvidenceRun(project, "desk-keep00");
    expect(await clearActivePointer(project, "desk-keep00")).toBe(false);
    expect(fs.existsSync(await activePointerPath(project, "desk-keep00"))).toBe(true);

    await run.finish("failed");
    expect(await clearActivePointer(project, "desk-keep00")).toBe(true);
    expect(fs.existsSync(await activePointerPath(project, "desk-keep00"))).toBe(false);
  });

  it("force-clears an active pointer when asked", async () => {
    await beginEvidenceRun(project, "desk-force0");
    expect(
      await clearActivePointer(project, "desk-force0", { force: true }),
    ).toBe(true);
    expect(fs.existsSync(await activePointerPath(project, "desk-force0"))).toBe(false);
  });

  it("compare-and-clears with expectRaw", async () => {
    await beginEvidenceRun(project, "desk-cas000");
    const pointerPath = await activePointerPath(project, "desk-cas000");
    const raw = await fs.promises.readFile(pointerPath, "utf8");
    expect(
      await clearActivePointer(project, "desk-cas000", { expectRaw: "other" }),
    ).toBe(false);
    expect(fs.existsSync(pointerPath)).toBe(true);
    expect(
      await clearActivePointer(project, "desk-cas000", { expectRaw: raw }),
    ).toBe(true);
    expect(fs.existsSync(pointerPath)).toBe(false);
  });

  it("recovers a stale pointer by starting a fresh run", async () => {
    const first = await beginEvidenceRun(project, "desk-recov0");
    await first.run.finish("completed");
    const second = await beginEvidenceRun(project, "desk-recov0");
    expect(second.adopted).toBe(false);
    expect(second.run.runId).not.toBe(first.run.runId);
    const resolution = await resolveActivePointer(project, "desk-recov0");
    expect(resolution.status).toBe("active");
    if (resolution.status !== "active") throw new Error("expected active");
    expect(resolution.pointer.runId).toBe(second.run.runId);
  });

  it("treats valid-JSON pointers of the wrong shape as corrupt", async () => {
    await fs.promises.mkdir(runsRoot(), { recursive: true });
    for (const [session, content] of [
      ["desk-num000", "123"],
      ["desk-arr000", "[1,2,3]"],
      ["desk-miss00", JSON.stringify({ evidenceVersion: 1 })],
      [
        "desk-badrun",
        JSON.stringify({
          evidenceVersion: 1,
          sessionId: "desk-badrun",
          runId: "../escape",
          ownerPid: 1,
          createdAt: new Date().toISOString(),
        }),
      ],
    ] as const) {
      await fs.promises.writeFile(await activePointerPath(project, session), content);
      expect((await resolveActivePointer(project, session)).status).toBe(
        "corrupt",
      );
    }
  });

  it("treats a well-formed pointer to a missing run as stale", async () => {
    await fs.promises.mkdir(runsRoot(), { recursive: true });
    const raw = JSON.stringify({
      evidenceVersion: 1,
      sessionId: "desk-gone00",
      runId: "20260101-000000-gone",
      ownerPid: 4_194_304,
      createdAt: new Date().toISOString(),
    });
    await fs.promises.writeFile(await activePointerPath(project, "desk-gone00"), raw);
    expect((await resolveActivePointer(project, "desk-gone00")).status).toBe(
      "stale",
    );
  });

  it("treats a pointer to a non-object manifest as stale", async () => {
    const { run } = await beginEvidenceRun(project, "desk-badman");
    await fs.promises.writeFile(path.join(run.dir, "manifest.json"), "123");
    expect((await resolveActivePointer(project, "desk-badman")).status).toBe(
      "stale",
    );
  });

  it("treats a pointer to an unparseable manifest as stale", async () => {
    const { run } = await beginEvidenceRun(project, "desk-badjsn");
    await fs.promises.writeFile(path.join(run.dir, "manifest.json"), "{ broken");
    expect((await resolveActivePointer(project, "desk-badjsn")).status).toBe(
      "stale",
    );
  });

  it("rejects a manifest whose identity differs from its active pointer", async () => {
    const sessionId = "desk-mismatch";
    const { run } = await beginEvidenceRun(project, sessionId);
    const manifestPath = path.join(run.dir, "manifest.json");
    const manifest = JSON.parse(
      await fs.promises.readFile(manifestPath, "utf8"),
    );
    manifest.runId = "../../outside";
    await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    expect((await resolveActivePointer(project, sessionId)).status).toBe(
      "stale",
    );
    await expect(
      finalizeActiveEvidenceRun(project, sessionId),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(await activePointerPath(project, sessionId))).toBe(false);
    expect(fs.existsSync(path.join(project, "outside", "report.html"))).toBe(
      false,
    );
  });

  it("recovers a corrupt pointer by starting a fresh run", async () => {
    await fs.promises.mkdir(runsRoot(), { recursive: true });
    await fs.promises.writeFile(
      await activePointerPath(project, "desk-corr01"),
      "{ garbage",
    );
    const { run, adopted } = await beginEvidenceRun(project, "desk-corr01");
    expect(adopted).toBe(false);
    const resolution = await resolveActivePointer(project, "desk-corr01");
    expect(resolution.status).toBe("active");
    if (resolution.status !== "active") throw new Error("expected active");
    expect(resolution.pointer.runId).toBe(run.runId);
  });

  it("classifies a running run with a dead recorded owner as stale", async () => {
    // A running manifest is not enough: if the process that created it is gone
    // (dead PID, or a PID reused by a different process), the run is orphaned.
    await fs.promises.mkdir(runsRoot(), { recursive: true });
    const run = await createRun(project, "evi", { evidence: true });
    expect(run.manifest.status).toBe("running");
    const raw = `${JSON.stringify({
      evidenceVersion: 1,
      sessionId: "desk-dead00",
      runId: run.runId,
      ownerPid: 4_194_304, // never a live PID in this test env
      ownerStartTicks: 1, // and no /proc match, so identity is provably dead
      createdAt: new Date().toISOString(),
    })}\n`;
    await fs.promises.writeFile(await activePointerPath(project, "desk-dead00"), raw);
    const resolution = await resolveActivePointer(project, "desk-dead00");
    expect(resolution.status).toBe("stale");
    if (resolution.status !== "stale") throw new Error("expected stale");
    expect(resolution.pointer?.runId).toBe(run.runId);
  });

  it("keeps a running run active while its recorded owner is alive", async () => {
    // Sanity counterpart: the current process is the owner and is alive.
    const { run } = await beginEvidenceRun(project, "desk-live01");
    const resolution = await resolveActivePointer(project, "desk-live01");
    expect(resolution.status).toBe("active");
    if (resolution.status !== "active") throw new Error("expected active");
    expect(resolution.pointer.runId).toBe(run.runId);
  });

  it("recovers a fresh run when a running run's owner has died", async () => {
    const first = await beginEvidenceRun(project, "desk-dead01");
    // Simulate the creating process dying: rewrite the pointer's owner identity
    // to a dead/reused one while the manifest is still `running`.
    const pointerPath = await activePointerPath(project, "desk-dead01");
    const pointer = JSON.parse(await fs.promises.readFile(pointerPath, "utf8"));
    pointer.ownerPid = 4_194_304;
    pointer.ownerStartTicks = 1;
    await fs.promises.writeFile(pointerPath, `${JSON.stringify(pointer)}\n`);

    expect((await resolveActivePointer(project, "desk-dead01")).status).toBe(
      "stale",
    );

    const second = await beginEvidenceRun(project, "desk-dead01");
    expect(second.adopted).toBe(false);
    expect(second.run.runId).not.toBe(first.run.runId);
    const resolution = await resolveActivePointer(project, "desk-dead01");
    expect(resolution.status).toBe("active");
    if (resolution.status !== "active") throw new Error("expected active");
    expect(resolution.pointer.runId).toBe(second.run.runId);
  });
});

describe("appendAction and readActions", () => {
  it("appends a full record and reads it back", async () => {
    const { run } = await beginEvidenceRun(project, "desk-app000");
    const result = await appendAction(run.dir, action({ actionId: "x1" }));
    expect(result.outcome).toBe("appended");
    expect(result.bytesWritten).toBeGreaterThan(0);
    const records = await readActions(run.dir);
    expect(records).toHaveLength(1);
    expect(records[0]?.actionId).toBe("x1");
    // The verified full-write byte count matches the on-disk line length.
    const size = (await fs.promises.stat(path.join(run.dir, "actions.jsonl"))).size;
    expect(result.bytesWritten).toBe(size);
  });

  it("does not rewrite the manifest on append", async () => {
    const { run } = await beginEvidenceRun(project, "desk-nomut0");
    const manifestPath = path.join(run.dir, "manifest.json");
    const before = await fs.promises.readFile(manifestPath, "utf8");
    await appendAction(run.dir, action());
    await appendAction(run.dir, action({ actionId: "a2" }));
    const after = await fs.promises.readFile(manifestPath, "utf8");
    expect(after).toBe(before);
  });

  it("rejects a record over the per-line byte bound", async () => {
    const { run } = await beginEvidenceRun(project, "desk-big000");
    const huge = action({ error: "x".repeat(2000) });
    await expect(
      appendAction(run.dir, huge, { maxLineBytes: 256 }),
    ).rejects.toThrow(RangeError);
    // Nothing was written.
    expect(await readActions(run.dir)).toEqual([]);
  });

  it("returns records in append order", async () => {
    const { run } = await beginEvidenceRun(project, "desk-order0");
    for (let i = 0; i < 5; i += 1) {
      await appendAction(run.dir, action({ actionId: `a${i}` }));
    }
    const ids = (await readActions(run.dir)).map((r) => r.actionId);
    expect(ids).toEqual(["a0", "a1", "a2", "a3", "a4"]);
  });

  it("reclaims a journal lock whose owner is dead", async () => {
    const { run } = await beginEvidenceRun(project, "desk-lock00");
    const lockPath = path.join(run.dir, ".evidence-journal.lock");
    await fs.promises.writeFile(
      lockPath,
      `${JSON.stringify({
        evidenceVersion: 1,
        ownerPid: 4_194_304,
        ownerStartTicks: 1,
        claimedAt: new Date().toISOString(),
      })}\n`,
    );

    await appendAction(run.dir, action({ actionId: "recovered" }));

    expect((await readActions(run.dir)).map((r) => r.actionId)).toEqual([
      "recovered",
    ]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("reads an empty or missing journal as no records", async () => {
    const { run } = await beginEvidenceRun(project, "desk-empty0");
    expect(await readActions(run.dir)).toEqual([]);
    const plain = await createRun(project, "plain");
    expect(await readActions(plain.dir)).toEqual([]);
  });

  it("never follows a symlinked action journal", async () => {
    const { run } = await beginEvidenceRun(project, "desk-link00");
    const journal = path.join(run.dir, "actions.jsonl");
    const outside = path.join(project, "outside-actions.jsonl");
    const outsideBody = `${JSON.stringify(action({ actionId: "outside" }))}\n`;
    await fs.promises.writeFile(outside, outsideBody);
    await fs.promises.rm(journal);
    await fs.promises.symlink(outside, journal);

    await expect(readActions(run.dir)).rejects.toThrow();
    await expect(
      appendAction(run.dir, action({ actionId: "blocked" })),
    ).rejects.toThrow();
    expect(await fs.promises.readFile(outside, "utf8")).toBe(outsideBody);
  });
});

describe("readActions corruption handling", () => {
  async function journalOf(session: string): Promise<{ runDir: string; journal: string }> {
    const { run } = await beginEvidenceRun(project, session);
    return { runDir: run.dir, journal: path.join(run.dir, "actions.jsonl") };
  }

  it("tolerates a torn (unterminated) final line", async () => {
    const { runDir, journal } = await journalOf("desk-torn00");
    const good = `${JSON.stringify(action({ actionId: "ok1" }))}\n`;
    const torn = JSON.stringify(action({ actionId: "half" })).slice(0, 12);
    await fs.promises.writeFile(journal, good + torn);
    const records = await readActions(runDir);
    expect(records.map((r) => r.actionId)).toEqual(["ok1"]);
  });

  it("repairs a torn final line before the next append", async () => {
    const { runDir, journal } = await journalOf("desk-torn01");
    const good = `${JSON.stringify(action({ actionId: "ok1" }))}\n`;
    const torn = '{"partial":"TORN';
    await fs.promises.writeFile(journal, good + torn);

    await appendAction(runDir, action({ actionId: "ok2" }));

    const records = await readActions(runDir);
    expect(records.map((r) => r.actionId)).toEqual(["ok1", "ok2"]);
    expect(await fs.promises.readFile(journal, "utf8")).not.toContain("TORN");
  });

  it("rejects corruption before the final line", async () => {
    const { runDir, journal } = await journalOf("desk-badmid");
    const good = `${JSON.stringify(action({ actionId: "ok1" }))}\n`;
    await fs.promises.writeFile(journal, good + "{ broken\n" + good);
    await expect(readActions(runDir)).rejects.toThrow(/corrupt/i);
  });

  it("rejects a blank line in the middle", async () => {
    const { runDir, journal } = await journalOf("desk-blank0");
    const good = `${JSON.stringify(action({ actionId: "ok1" }))}\n`;
    await fs.promises.writeFile(journal, good + "\n" + good);
    await expect(readActions(runDir)).rejects.toThrow(/blank/i);
  });

  it("rejects a record that is valid JSON but not an evidence record", async () => {
    const { runDir, journal } = await journalOf("desk-shape0");
    await fs.promises.writeFile(journal, "[1,2,3]\n");
    await expect(readActions(runDir)).rejects.toThrow(/corrupt/i);
  });
});

describe("evidence cap and truncation", () => {
  it("writes exactly one truncation marker and keeps metadata afterward", async () => {
    const { run } = await beginEvidenceRun(project, "desk-cap000");
    expect(await isEvidenceTruncated(run.dir)).toBe(false);
    const maxBytes = 400;
    const outcomes: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const result = await appendAction(
        run.dir,
        action({ actionId: `m${i}`, target: { i } }),
        { maxBytes, maxLineBytes: 1024 },
      );
      outcomes.push(result.outcome);
    }
    expect(outcomes.filter((o) => o === "truncated")).toHaveLength(1);
    expect(await isEvidenceTruncated(run.dir)).toBe(true);

    const records = await readActions(run.dir);
    const markers = records.filter(
      (r): r is Extract<EvidenceRecord, { evidenceTruncated: true }> =>
        isTruncationRecord(r),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.reason).toBe("evidence-cap");
    // Metadata-only actions after the cap are still recorded.
    const afterMarker = records.slice(records.indexOf(markers[0]!) + 1);
    expect(afterMarker.length).toBeGreaterThan(0);
    expect(afterMarker.every((r) => !isTruncationRecord(r))).toBe(true);
  });

  it("drops artifact-carrying actions after the cap but keeps metadata-only", async () => {
    const { run } = await beginEvidenceRun(project, "desk-cap001");
    const maxBytes = 200;
    // Cross the cap first.
    await appendAction(run.dir, action({ actionId: "seed", target: { p: "x".repeat(180) } }), {
      maxBytes,
      maxLineBytes: 4096,
    });
    expect(await isEvidenceTruncated(run.dir)).toBe(true);

    const heavy = await appendAction(
      run.dir,
      action({ actionId: "heavy", artifacts: ["screenshots/a.png"] }),
      { maxBytes, maxLineBytes: 4096 },
    );
    expect(heavy.outcome).toBe("capped");
    expect(heavy.bytesWritten).toBe(0);

    const meta = await appendAction(run.dir, action({ actionId: "meta" }), {
      maxBytes,
      maxLineBytes: 4096,
    });
    expect(meta.outcome).toBe("appended");

    const ids = (await readActions(run.dir))
      .filter((r) => !isTruncationRecord(r))
      .map((r) => r.actionId);
    expect(ids).toContain("meta");
    expect(ids).not.toContain("heavy");
  });

  it("counts externalBytes toward the cap without a giant journal", async () => {
    const { run } = await beginEvidenceRun(project, "desk-cap002");
    const result = await appendAction(run.dir, action({ actionId: "s1" }), {
      maxBytes: 1024,
      externalBytes: 4096,
    });
    // externalBytes alone exceeds the cap on the very first append.
    expect(result.outcome).toBe("truncated");
    expect(await isEvidenceTruncated(run.dir)).toBe(true);
  });

  it("counts cumulative on-disk artifact bytes across appends", async () => {
    // Artifacts written to the run dir between appends must accumulate toward
    // the cap. A per-call-only accounting (the old `externalBytes` model) would
    // forget the first artifact and never trip the cap; on-disk measurement
    // remembers every prior write, so the second append crosses the cap even
    // though its own journal line is tiny and no externalBytes is passed.
    const { run } = await beginEvidenceRun(project, "desk-cumul0");
    const maxBytes = 8192;
    const screenshots = path.join(run.dir, "screenshots");

    await fs.promises.writeFile(
      path.join(screenshots, "a.bin"),
      Buffer.alloc(5000),
    );
    const first = await appendAction(
      run.dir,
      action({ actionId: "a1", artifacts: ["screenshots/a.bin"] }),
      { maxBytes, maxLineBytes: 4096 },
    );
    expect(first.outcome).toBe("appended");
    expect(await isEvidenceTruncated(run.dir)).toBe(false);

    // Second artifact pushes cumulative on-disk bytes over the cap.
    await fs.promises.writeFile(
      path.join(screenshots, "b.bin"),
      Buffer.alloc(5000),
    );
    const second = await appendAction(run.dir, action({ actionId: "a2" }), {
      maxBytes,
      maxLineBytes: 4096,
    });
    expect(second.outcome).toBe("truncated");
    expect(second.usedBytes).toBeGreaterThanOrEqual(maxBytes);
    expect(await isEvidenceTruncated(run.dir)).toBe(true);
  });

  it("drops later artifact-carrying actions once cumulative artifacts cross the cap", async () => {
    const { run } = await beginEvidenceRun(project, "desk-cumul1");
    const maxBytes = 4096;
    const screenshots = path.join(run.dir, "screenshots");
    await fs.promises.writeFile(
      path.join(screenshots, "big.bin"),
      Buffer.alloc(maxBytes + 1000),
    );
    // A metadata-only append observes the over-cap artifact bytes and truncates.
    const meta = await appendAction(run.dir, action({ actionId: "m1" }), {
      maxBytes,
      maxLineBytes: 4096,
    });
    expect(meta.outcome).toBe("truncated");

    // A subsequent artifact-carrying action is dropped; metadata still records.
    const heavy = await appendAction(
      run.dir,
      action({ actionId: "heavy", artifacts: ["screenshots/big.bin"] }),
      { maxBytes, maxLineBytes: 4096 },
    );
    expect(heavy.outcome).toBe("capped");
    expect(heavy.bytesWritten).toBe(0);
    const meta2 = await appendAction(run.dir, action({ actionId: "m2" }), {
      maxBytes,
      maxLineBytes: 4096,
    });
    expect(meta2.outcome).toBe("appended");

    const ids = (await readActions(run.dir))
      .filter((r) => !isTruncationRecord(r))
      .map((r) => r.actionId);
    expect(ids).toContain("m2");
    expect(ids).not.toContain("heavy");
  });

  it("never follows a symlink when measuring evidence bytes", async () => {
    const { run } = await beginEvidenceRun(project, "desk-msym00");
    // A symlink inside the run dir must be skipped, not followed or counted.
    await fs.promises.symlink(
      "/etc/hostname",
      path.join(run.dir, "screenshots", "link"),
    );
    const result = await appendAction(run.dir, action({ actionId: "a1" }), {
      maxBytes: 100_000,
      maxLineBytes: 4096,
    });
    expect(result.outcome).toBe("appended");
    expect(await isEvidenceTruncated(run.dir)).toBe(false);
  });

  it("reuses the cached artifact total across metadata-only appends instead of rescanning every file", async () => {
    const { run } = await beginEvidenceRun(project, "desk-cache00");
    const screenshots = path.join(run.dir, "screenshots");
    // Seed a large number of on-disk artifacts up front.
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        fs.promises.writeFile(
          path.join(screenshots, `seed-${i}.bin`),
          Buffer.alloc(1024),
        ),
      ),
    );
    // First append after the artifacts land always does a full scan, seeding
    // the cache with the correct total.
    const seeded = await appendAction(run.dir, action({ actionId: "seed" }), {
      maxBytes: 1_000_000,
    });
    expect(seeded.usedBytes).toBeGreaterThanOrEqual(40 * 1024);

    const lstatSpy = vi.spyOn(fs.promises, "lstat");
    lstatSpy.mockClear();
    for (let i = 0; i < 10; i += 1) {
      await appendAction(run.dir, action({ actionId: `meta-${i}` }), {
        maxBytes: 1_000_000,
      });
    }
    const lstatCalls = lstatSpy.mock.calls.length;
    lstatSpy.mockRestore();
    // A full rescan touches every one of the 40 seeded files on every call
    // (400+ lstats across 10 calls). The cache should keep this bounded to
    // roughly the number of directories checked per call, independent of the
    // artifact count.
    expect(lstatCalls).toBeLessThan(40);

    // A new artifact written directly to disk (no appendAction call in
    // between) must still be picked up on the next append: the cache must
    // never permanently undercount.
    await fs.promises.writeFile(
      path.join(screenshots, "late.bin"),
      Buffer.alloc(2048),
    );
    const after = await appendAction(run.dir, action({ actionId: "after" }), {
      maxBytes: 1_000_000,
    });
    expect(after.usedBytes).toBeGreaterThanOrEqual(seeded.usedBytes + 2048);
  });
});

describe("truncation marker durability", () => {
  const SENTINEL = ".evidence-truncated";

  function markers(records: EvidenceRecord[]): EvidenceRecord[] {
    return records.filter((r) => isTruncationRecord(r));
  }

  it("reports a committed action when its marker append fails, then recovers", async () => {
    // The action crosses the cap and lands before the injected marker failure.
    // Returning success prevents a caller retry from duplicating that action; a
    // later append recovers the missing marker.
    const { run } = await beginEvidenceRun(project, "desk-mkfail");
    const maxBytes = 200;
    const result = await appendAction(
      run.dir,
      action({ actionId: "seed", target: { p: "x".repeat(180) } }),
      {
        maxBytes,
        maxLineBytes: 4096,
        _failMarkerAppend: () => {
          throw new Error("injected marker append failure");
        },
      },
    );
    expect(result).toMatchObject({
      outcome: "appended",
      truncationPending: true,
    });

    // The failed marker append cleaned its claim while preserving the action.
    expect(await isEvidenceTruncated(run.dir)).toBe(false);
    expect(fs.existsSync(path.join(run.dir, SENTINEL))).toBe(false);
    const beforeRecovery = await readActions(run.dir);
    expect(markers(beforeRecovery)).toHaveLength(0);
    expect(beforeRecovery.map((record) => record.actionId)).toEqual(["seed"]);

    // A subsequent normal append recovers and writes exactly one marker without
    // duplicating the already-committed seed action.
    const recovered = await appendAction(run.dir, action({ actionId: "after" }), {
      maxBytes,
      maxLineBytes: 4096,
    });
    expect(recovered.outcome).toBe("truncated");
    expect(await isEvidenceTruncated(run.dir)).toBe(true);
    const records = await readActions(run.dir);
    expect(markers(records)).toHaveLength(1);
    expect(records.filter((record) => record.actionId === "seed")).toHaveLength(1);
  });

  it("reclaims an owner-unknown (empty) marker sentinel after a grace", async () => {
    // An empty sentinel models a claimer that died between the `wx` create and
    // its identity stamp: owner-unknown, reclaimed only after a short grace.
    const { run } = await beginEvidenceRun(project, "desk-mkemp0");
    const maxBytes = 200;
    await fs.promises.writeFile(
      path.join(run.dir, "screenshots", "big.bin"),
      Buffer.alloc(maxBytes + 500),
    );
    await fs.promises.writeFile(path.join(run.dir, SENTINEL), "");

    const result = await appendAction(run.dir, action({ actionId: "recover" }), {
      maxBytes,
      maxLineBytes: 4096,
    });
    expect(result.outcome).toBe("truncated");
    expect(await isEvidenceTruncated(run.dir)).toBe(true);
    expect(markers(await readActions(run.dir))).toHaveLength(1);
  });

  it("keeps the marker durable when only the sentinel commit fails", async () => {
    // The marker append succeeds but the atomic sentinel commit (rename) fails.
    // The marker is already durable, so it must appear exactly once and the
    // recoverable claim keeps truncation latched — never a lost or duplicated
    // marker.
    const { run } = await beginEvidenceRun(project, "desk-mkcmt0");
    const maxBytes = 200;
    const realRename = fs.promises.rename.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "rename").mockImplementation((async (
      from: Parameters<typeof fs.promises.rename>[0],
      to: Parameters<typeof fs.promises.rename>[1],
    ) => {
      if (String(to).endsWith(SENTINEL)) {
        const error = new Error("simulated commit failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realRename(from, to);
    }) as typeof fs.promises.rename);
    let result: Awaited<ReturnType<typeof appendAction>> | undefined;
    try {
      result = await appendAction(
        run.dir,
        action({ actionId: "seed", target: { p: "x".repeat(180) } }),
        {
          maxBytes,
          maxLineBytes: 4096,
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(result).toMatchObject({
      outcome: "appended",
      truncationPending: true,
    });
    expect(markers(await readActions(run.dir))).toHaveLength(1);
    expect(await isEvidenceTruncated(run.dir)).toBe(true);

    // The same live owner retries and commits its recoverable sentinel on the
    // next append instead of leaving the claim pending until process exit.
    await appendAction(run.dir, action({ actionId: "after" }), {
      maxBytes,
      maxLineBytes: 4096,
    });
    const sentinel = JSON.parse(
      await fs.promises.readFile(path.join(run.dir, SENTINEL), "utf8"),
    );
    expect(sentinel.committed).toBe(true);
    expect(markers(await readActions(run.dir))).toHaveLength(1);
  });

  it("reclaims a marker claim whose owner is dead and writes the marker", async () => {
    // A crashed writer leaves an uncommitted claim (dead owner) and no marker.
    // The next append must reclaim it and write the marker exactly once.
    const { run } = await beginEvidenceRun(project, "desk-mkdead");
    const maxBytes = 200;
    await fs.promises.writeFile(
      path.join(run.dir, "screenshots", "big.bin"),
      Buffer.alloc(maxBytes + 500),
    );
    const deadClaim = `${JSON.stringify({
      evidenceVersion: 1,
      ownerPid: 4_194_304, // never a live PID in this env
      ownerStartTicks: 1, // and no /proc match, so the owner is provably dead
      claim: true,
      claimedAt: new Date().toISOString(),
    })}\n`;
    await fs.promises.writeFile(path.join(run.dir, SENTINEL), deadClaim);

    const result = await appendAction(run.dir, action({ actionId: "recover" }), {
      maxBytes,
      maxLineBytes: 4096,
    });
    expect(result.outcome).toBe("truncated");
    expect(await isEvidenceTruncated(run.dir)).toBe(true);
    expect(markers(await readActions(run.dir))).toHaveLength(1);
  });

  it("recovers without duplicating when a dead claim already wrote the marker", async () => {
    // A writer crashed *after* appending the marker but *before* committing its
    // sentinel. The reclaimer must find the existing marker and commit — never
    // append a second one.
    const { run } = await beginEvidenceRun(project, "desk-mkdupe");
    const maxBytes = 200;
    // Cross the cap normally so a real marker sits in the journal.
    await appendAction(
      run.dir,
      action({ actionId: "seed", target: { p: "x".repeat(180) } }),
      { maxBytes, maxLineBytes: 4096 },
    );
    expect(markers(await readActions(run.dir))).toHaveLength(1);
    // Roll the committed sentinel back to an uncommitted, dead-owner claim,
    // modelling the crash-after-append-before-commit window.
    const deadClaim = `${JSON.stringify({
      evidenceVersion: 1,
      ownerPid: 4_194_304,
      ownerStartTicks: 1,
      claim: true,
      claimedAt: new Date().toISOString(),
    })}\n`;
    await fs.promises.writeFile(path.join(run.dir, SENTINEL), deadClaim);

    const result = await appendAction(run.dir, action({ actionId: "after" }), {
      maxBytes,
      maxLineBytes: 4096,
    });
    // No second marker; the reclaimer committed over the existing one.
    expect(result.outcome).toBe("appended");
    expect(await isEvidenceTruncated(run.dir)).toBe(true);
    expect(markers(await readActions(run.dir))).toHaveLength(1);
    const sentinel = JSON.parse(
      await fs.promises.readFile(path.join(run.dir, SENTINEL), "utf8"),
    );
    expect(sentinel.committed).toBe(true);
  });

  it("treats a committed sentinel as done and never writes a second marker", async () => {
    const { run } = await beginEvidenceRun(project, "desk-mkidem");
    const maxBytes = 200;
    await appendAction(
      run.dir,
      action({ actionId: "seed", target: { p: "x".repeat(180) } }),
      { maxBytes, maxLineBytes: 4096 },
    );
    expect(await isEvidenceTruncated(run.dir)).toBe(true);
    const sentinel = JSON.parse(
      await fs.promises.readFile(path.join(run.dir, SENTINEL), "utf8"),
    );
    expect(sentinel.committed).toBe(true);

    for (let i = 0; i < 5; i += 1) {
      const r = await appendAction(run.dir, action({ actionId: `m${i}` }), {
        maxBytes,
        maxLineBytes: 4096,
      });
      expect(r.outcome).toBe("appended");
    }
    expect(markers(await readActions(run.dir))).toHaveLength(1);
  });

  it("never lets a peer steal a live marker claim (exactly one marker)", async () => {
    // The winner holds its stamped marker claim open in `_afterMarkerClaim` while
    // a concurrent peer append races it. The peer must see the live claim and
    // skip, never stealing it, so exactly one marker is written.
    const { run } = await beginEvidenceRun(project, "desk-mklive");
    const maxBytes = 200;
    await fs.promises.writeFile(
      path.join(run.dir, "screenshots", "big.bin"),
      Buffer.alloc(maxBytes + 500),
    );

    let releaseWinner: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let signalClaimed: () => void = () => {};
    const claimed = new Promise<void>((resolve) => {
      signalClaimed = resolve;
    });

    const winner = appendAction(run.dir, action({ actionId: "winner" }), {
      maxBytes,
      maxLineBytes: 4096,
      _afterMarkerClaim: async () => {
        signalClaimed();
        await gate;
      },
    });
    await claimed;
    const peer = appendAction(run.dir, action({ actionId: "peer" }), {
      maxBytes,
      maxLineBytes: 4096,
    });
    // Give the peer time to observe the live claim and skip it without stealing.
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseWinner();

    const [winnerResult, peerResult] = await Promise.all([winner, peer]);
    expect(winnerResult.outcome).toBe("truncated");
    expect(peerResult.outcome).toBe("appended");
    expect(markers(await readActions(run.dir))).toHaveLength(1);
  });
});

describe("begin claim recovery", () => {
  it("reclaims an owner-unknown (empty) claim and starts a run", async () => {
    await fs.promises.mkdir(runsRoot(), { recursive: true });
    await fs.promises.writeFile(await activePointerPath(project, "desk-empt00"), "");
    const { run, adopted } = await beginEvidenceRun(project, "desk-empt00");
    expect(adopted).toBe(false);
    const resolution = await resolveActivePointer(project, "desk-empt00");
    expect(resolution.status).toBe("active");
    if (resolution.status !== "active") throw new Error("expected active");
    expect(resolution.pointer.runId).toBe(run.runId);
  });

  it("reclaims a claim whose owner is provably dead and starts a run", async () => {
    await fs.promises.mkdir(runsRoot(), { recursive: true });
    const claim = `${JSON.stringify({
      evidenceVersion: 1,
      sessionId: "desk-dclm00",
      ownerPid: 4_194_304,
      ownerStartTicks: 1,
      claim: true,
      claimedAt: new Date().toISOString(),
    })}\n`;
    await fs.promises.writeFile(await activePointerPath(project, "desk-dclm00"), claim);
    // A claim record with owner identity resolves as `claiming`.
    const pre = await resolveActivePointer(project, "desk-dclm00");
    expect(pre.status).toBe("claiming");
    if (pre.status !== "claiming") throw new Error("expected claiming");
    expect(pre.claim?.ownerPid).toBe(4_194_304);

    // Because that owner is dead, a fresh begin reclaims it and starts a run.
    const { run, adopted } = await beginEvidenceRun(project, "desk-dclm00");
    expect(adopted).toBe(false);
    const resolution = await resolveActivePointer(project, "desk-dclm00");
    expect(resolution.status).toBe("active");
    if (resolution.status !== "active") throw new Error("expected active");
    expect(resolution.pointer.runId).toBe(run.runId);
  });
});

describe("finalized-run retention", () => {
  async function finalizedEvidenceRun(when: string): Promise<string> {
    const run = await createRun(project, "evi", {
      evidence: true,
      now: new Date(when),
    });
    await run.finish("completed");
    return run.runId;
  }

  it("keeps the newest N finalized evidence runs and prunes older ones", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const minute = String(i).padStart(2, "0");
      ids.push(await finalizedEvidenceRun(`2026-06-09T10:${minute}:00Z`));
    }
    const removed = await pruneFinalizedEvidenceRuns(project, { keep: 20 });
    expect(removed).toHaveLength(5);
    // Oldest five removed.
    expect(removed.sort()).toEqual(ids.slice(0, 5).sort());
    const surviving = (await listRuns(project)).map((r) => r.runId);
    expect(surviving).toHaveLength(20);
    for (const id of ids.slice(0, 5)) {
      expect(fs.existsSync(path.join(runsRoot(), id))).toBe(false);
    }
  });

  it("never prunes running, active-pointer, or legacy runs", async () => {
    // 21 finalized evidence runs so retention (keep 20) wants to drop one.
    const finalized: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const minute = String(i).padStart(2, "0");
      finalized.push(await finalizedEvidenceRun(`2026-06-09T09:${minute}:00Z`));
    }
    // A running evidence run (via active pointer) — newest, must survive.
    const active = await beginEvidenceRun(project, "desk-live00", {
      now: new Date("2026-06-09T11:00:00Z"),
    });
    // A standalone running evidence run without a pointer.
    const running = await createRun(project, "evi", {
      evidence: true,
      now: new Date("2026-06-09T11:30:00Z"),
    });
    // A legacy finalized run with no evidenceVersion.
    const legacy = await createRun(project, "legacy", {
      now: new Date("2026-06-09T08:00:00Z"),
    });
    await legacy.finish("completed");

    const removed = await pruneFinalizedEvidenceRuns(project, { keep: 20 });
    // Exactly one finalized evidence run (the oldest) is dropped.
    expect(removed).toHaveLength(1);
    expect(removed[0]).toBe(finalized[0]);

    expect(fs.existsSync(active.run.dir)).toBe(true);
    expect(fs.existsSync(running.dir)).toBe(true);
    expect(fs.existsSync(legacy.dir)).toBe(true);
  });

  it("returns nothing to prune below the retention limit", async () => {
    await finalizedEvidenceRun("2026-06-09T09:00:00Z");
    expect(await pruneFinalizedEvidenceRuns(project, { keep: 20 })).toEqual([]);
  });

  it("defaults to keeping 20 when no limit is given", async () => {
    for (let i = 0; i < 22; i += 1) {
      const minute = String(i).padStart(2, "0");
      await finalizedEvidenceRun(`2026-06-09T07:${minute}:00Z`);
    }
    const removed = await pruneFinalizedEvidenceRuns(project);
    expect(removed).toHaveLength(2);
    expect((await listRuns(project)).length).toBe(20);
  });

  it("no-ops on a project without a runs directory", async () => {
    expect(await pruneFinalizedEvidenceRuns(project)).toEqual([]);
  });

  it("ignores stray non-pointer files when collecting active runs", async () => {
    await finalizedEvidenceRun("2026-06-09T09:00:00Z");
    await fs.promises.writeFile(path.join(runsRoot(), "notes.txt"), "hello");
    expect(await pruneFinalizedEvidenceRuns(project, { keep: 20 })).toEqual([]);
  });

  it("never deletes a running run named by a spoofed finalized manifest", async () => {
    // A live, running run we must never lose.
    const running = await createRun(project, "evi", {
      evidence: true,
      now: new Date("2026-06-09T12:00:00Z"),
    });
    expect(running.manifest.status).toBe("running");

    // Enough finalized runs to push retention past its keep window.
    const finalized: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const minute = String(i).padStart(2, "0");
      finalized.push(await finalizedEvidenceRun(`2026-06-09T10:${minute}:00Z`));
    }

    // Spoof the oldest finalized run's manifest so it *declares* the running
    // run's id. The old code built the removal path from this declared runId and
    // would delete the running run's directory.
    const victim = finalized[0]!;
    const victimManifestPath = path.join(runsRoot(), victim, "manifest.json");
    const spoofed = JSON.parse(
      await fs.promises.readFile(victimManifestPath, "utf8"),
    );
    spoofed.runId = running.runId;
    await fs.promises.writeFile(
      victimManifestPath,
      `${JSON.stringify(spoofed, null, 2)}\n`,
    );

    const removed = await pruneFinalizedEvidenceRuns(project, { keep: 20 });

    // The running run is untouched, and its id is never in the removal list.
    expect(fs.existsSync(running.dir)).toBe(true);
    expect(removed).not.toContain(running.runId);
    // The spoofed directory (runId != dirName) is not a valid candidate, so it
    // is skipped rather than deleted under a mismatched name.
    expect(fs.existsSync(path.join(runsRoot(), victim))).toBe(true);
    expect(removed).not.toContain(victim);
  });

  it("does not prune a real directory replacement after catalog discovery", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const minute = String(i).padStart(2, "0");
      ids.push(await finalizedEvidenceRun(`2026-06-09T10:${minute}:00Z`));
    }
    const victim = ids[0]!;
    const victimDir = path.join(runsRoot(), victim);
    const replacementManifest = await fs.promises.readFile(
      path.join(victimDir, "manifest.json"),
      "utf8",
    );
    const realReaddir = fs.promises.readdir.bind(fs.promises);
    let rootReads = 0;
    const spy = vi.spyOn(fs.promises, "readdir").mockImplementation((async (
      ...args: Parameters<typeof fs.promises.readdir>
    ) => {
      if (path.resolve(String(args[0])) === runsRoot()) {
        rootReads += 1;
        if (rootReads === 2) {
          await fs.promises.rename(victimDir, `${victimDir}-original`);
          await fs.promises.mkdir(victimDir);
          await fs.promises.writeFile(
            path.join(victimDir, "manifest.json"),
            replacementManifest,
          );
        }
      }
      return (realReaddir as typeof fs.promises.readdir)(...args);
    }) as typeof fs.promises.readdir);

    try {
      expect(await pruneFinalizedEvidenceRuns(project, { keep: 20 })).toEqual(
        [],
      );
      expect(fs.existsSync(victimDir)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("resists fake-inflation manifests that point at a real run", async () => {
    // One real finalized run we intend to keep.
    const real = await finalizedEvidenceRun("2026-06-09T12:00:00Z");

    // Plant many fake finalized run dirs, each declaring the real run's id with
    // newer timestamps. A naive sort+slice would push `real` out of the keep
    // window and target it; binding by directory name defeats this — the fakes
    // (runId != dirName) are not valid candidates at all.
    for (let i = 0; i < 25; i += 1) {
      const dirName = `fake-${String(i).padStart(2, "0")}`;
      const dir = path.join(runsRoot(), dirName);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, "manifest.json"),
        `${JSON.stringify({
          runId: real, // spoof: not this directory's own name
          slug: "evi",
          createdAt: `2026-06-09T13:${String(i).padStart(2, "0")}:00Z`,
          status: "completed",
          artifacts: [],
          evidenceVersion: 1,
          actionLog: "actions.jsonl",
        })}\n`,
      );
    }

    const removed = await pruneFinalizedEvidenceRuns(project, { keep: 20 });
    // The real run survives and is never in the removal list.
    expect(fs.existsSync(path.join(runsRoot(), real))).toBe(true);
    expect(removed).not.toContain(real);
  });

  it("still prunes legitimately old finalized runs alongside spoofed ones", async () => {
    // 22 legit finalized runs; the two oldest should be pruned normally even
    // when a spoofed sibling is present.
    const ids: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      const minute = String(i).padStart(2, "0");
      ids.push(await finalizedEvidenceRun(`2026-06-09T10:${minute}:00Z`));
    }
    // A spoofed dir that must be ignored (not counted, not deleted).
    const spoofDir = path.join(runsRoot(), "spoof-dir");
    await fs.promises.mkdir(spoofDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(spoofDir, "manifest.json"),
      `${JSON.stringify({
        runId: ids[0], // declares another run's id
        slug: "evi",
        createdAt: "2026-06-09T09:00:00Z",
        status: "completed",
        artifacts: [],
        evidenceVersion: 1,
      })}\n`,
    );

    const removed = await pruneFinalizedEvidenceRuns(project, { keep: 20 });
    expect(removed.sort()).toEqual(ids.slice(0, 2).sort());
    expect(fs.existsSync(spoofDir)).toBe(true);
  });

  it("ignores run dirs with a symlinked or invalid manifest", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const minute = String(i).padStart(2, "0");
      ids.push(await finalizedEvidenceRun(`2026-06-09T10:${minute}:00Z`));
    }
    // A dir whose manifest is a symlink is never a valid candidate.
    const symDir = path.join(runsRoot(), "sym-manifest");
    await fs.promises.mkdir(symDir);
    await fs.promises.symlink(
      path.join(runsRoot(), ids[0]!, "manifest.json"),
      path.join(symDir, "manifest.json"),
    );
    // A dir with a non-object manifest is skipped, not counted or deleted.
    const badDir = path.join(runsRoot(), "bad-manifest");
    await fs.promises.mkdir(badDir);
    await fs.promises.writeFile(path.join(badDir, "manifest.json"), "123");

    const removed = await pruneFinalizedEvidenceRuns(project, { keep: 20 });
    expect(removed).toEqual([ids[0]]);
    expect(fs.existsSync(symDir)).toBe(true);
    expect(fs.existsSync(badDir)).toBe(true);
  });

  it("never prunes pre-existing legacy project-local runs through the read-only fallback root", async () => {
    // Reproduces the P0: home mode layers the legacy project-local root
    // under the catalog purely for read discovery. Retention must count and
    // delete only within the resolved primary (home) root — never treat the
    // legacy root's runs as removal candidates just because the merged
    // cross-root list exceeds `keep`.
    const home = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pickforge-lab-evi-prune-home-"),
    );
    const homeEnv = { PICKFORGE_HOME: home };
    try {
      // 15 pre-existing legacy finalized runs (the file-level stub keeps
      // `finalizedEvidenceRun`'s default env at project-local).
      const legacyIds: string[] = [];
      for (let i = 0; i < 15; i += 1) {
        const minute = String(i).padStart(2, "0");
        legacyIds.push(
          await finalizedEvidenceRun(`2026-05-01T09:${minute}:00Z`),
        );
      }
      // 10 new home-mode finalized runs.
      const homeIds: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const minute = String(i).padStart(2, "0");
        const run = await createRun(
          project,
          "evi",
          { evidence: true, now: new Date(`2026-06-09T10:${minute}:00Z`) },
          homeEnv,
        );
        await run.finish("completed");
        homeIds.push(run.runId);
      }

      // 25 total across both roots; `keep: 5` would prune 20 of them if
      // retention were computed over the merged catalog instead of the
      // primary root alone.
      const removed = await pruneFinalizedEvidenceRuns(
        project,
        { keep: 5 },
        homeEnv,
      );

      expect(removed).toHaveLength(5);
      expect(removed.sort()).toEqual(homeIds.slice(0, 5).sort());
      // All 15 legacy runs survive untouched.
      for (const id of legacyIds) {
        expect(fs.existsSync(path.join(runsRoot(), id))).toBe(true);
      }
      // The 5 newest home runs survive; only the 5 oldest home runs are gone.
      const survivingHomeIds = (await listRuns(project, homeEnv))
        .map((r) => r.runId)
        .filter((id) => homeIds.includes(id));
      expect(survivingHomeIds.sort()).toEqual(homeIds.slice(5).sort());
    } finally {
      await fs.promises.rm(home, { recursive: true, force: true });
    }
  });
});

describe("defensive filesystem errors propagate", () => {
  function eacces(): NodeJS.ErrnoException {
    const error = new Error("simulated permission failure") as NodeJS.ErrnoException;
    error.code = "EACCES";
    return error;
  }

  it("rethrows a non-ENOENT error while reading a pointer", async () => {
    await beginEvidenceRun(project, "desk-perm00");
    const spy = vi
      .spyOn(fs.promises, "readFile")
      .mockRejectedValue(eacces());
    try {
      await expect(
        resolveActivePointer(project, "desk-perm00"),
      ).rejects.toThrow(/permission/i);
      await expect(
        clearActivePointer(project, "desk-perm00"),
      ).rejects.toThrow(/permission/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("rethrows a non-ENOENT error while reading a manifest", async () => {
    await beginEvidenceRun(project, "desk-perm01");
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "readFile").mockImplementation((async (
      target: Parameters<typeof fs.promises.readFile>[0],
      options?: Parameters<typeof fs.promises.readFile>[1],
    ) => {
      if (String(target).endsWith("manifest.json")) throw eacces();
      return realReadFile(target, options);
    }) as typeof fs.promises.readFile);
    try {
      await expect(
        resolveActivePointer(project, "desk-perm01"),
      ).rejects.toThrow(/permission/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("rethrows a non-EEXIST error while claiming a pointer", async () => {
    const spy = vi.spyOn(fs.promises, "open").mockRejectedValue(eacces());
    try {
      await expect(beginEvidenceRun(project, "desk-perm02")).rejects.toThrow(
        /permission/i,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("rethrows a non-ENOENT error while probing the truncation sentinel", async () => {
    const { run } = await beginEvidenceRun(project, "desk-perm03");
    const spy = vi.spyOn(fs.promises, "stat").mockRejectedValue(eacces());
    try {
      await expect(isEvidenceTruncated(run.dir)).rejects.toThrow(/permission/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("finalizes the just-created run when pointer publication fails", async () => {
    // Fail only the atomic pointer publish (rename onto the .active pointer),
    // leaving the run creation itself (which renames onto manifest.json) intact.
    const realRename = fs.promises.rename.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "rename").mockImplementation((async (
      from: Parameters<typeof fs.promises.rename>[0],
      to: Parameters<typeof fs.promises.rename>[1],
    ) => {
      if (String(to).includes(".active-")) throw eacces();
      return realRename(from, to);
    }) as typeof fs.promises.rename);
    try {
      await expect(
        beginEvidenceRun(project, "desk-pubfail"),
      ).rejects.toThrow(/permission/i);
    } finally {
      spy.mockRestore();
    }

    // No active pointer is left behind.
    expect(fs.existsSync(await activePointerPath(project, "desk-pubfail"))).toBe(false);
    // The just-created run is finalized (failed), never a permanent running
    // orphan. Exactly one run exists and none are still running.
    const runs = await listRuns(project);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs.filter((r) => r.status === "running")).toHaveLength(0);
  });

  it("recovers cleanly on a fresh begin after a failed publication", async () => {
    const realRename = fs.promises.rename.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "rename").mockImplementation((async (
      from: Parameters<typeof fs.promises.rename>[0],
      to: Parameters<typeof fs.promises.rename>[1],
    ) => {
      if (String(to).includes(".active-")) throw eacces();
      return realRename(from, to);
    }) as typeof fs.promises.rename);
    try {
      await expect(
        beginEvidenceRun(project, "desk-pubfx01"),
      ).rejects.toThrow(/permission/i);
    } finally {
      spy.mockRestore();
    }
    // A subsequent begin succeeds and yields a fresh active run.
    const { run, adopted } = await beginEvidenceRun(project, "desk-pubfx01");
    expect(adopted).toBe(false);
    const resolution = await resolveActivePointer(project, "desk-pubfx01");
    expect(resolution.status).toBe("active");
    if (resolution.status !== "active") throw new Error("expected active");
    expect(resolution.pointer.runId).toBe(run.runId);
  });
});

describe("adopted run handles are usable", () => {
  it("adopts a RunHandle that appends to the shared journal", async () => {
    const first = await beginEvidenceRun(project, "desk-share0");
    const second = await beginEvidenceRun(project, "desk-share0");
    expect(second.run).toBeInstanceOf(RunHandle);
    await appendAction(first.run.dir, action({ actionId: "from-first" }));
    await appendAction(second.run.dir, action({ actionId: "from-second" }));
    const ids = (await readActions(first.run.dir)).map((r) => r.actionId);
    expect(ids).toEqual(["from-first", "from-second"]);
  });
});
