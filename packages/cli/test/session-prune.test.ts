import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, destroySessionRecord, retainSessionLogs, sessionDataDir } from "@pickforge/lab-core";
import { runSessionPrune } from "../src/commands/session.js";
import { buildProgram } from "../src/program.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-cli-prune-"));
  vi.stubEnv("PICKFORGE_HOME", home);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("session prune command", () => {
  it.each([{}, { allStopped: true, olderThan: "7d" }, { olderThan: "bad" }])("rejects invalid selection %j", async (opts) => {
    expect(await runSessionPrune({ ...opts, json: true })).toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0]).ok).toBe(false);
  });

  it("prunes logs through the registered command and reports JSON", async () => {
    const env = { PICKFORGE_HOME: home };
    const record = await createSession({ type: "desktop", projectDir: home }, env);
    await retainSessionLogs(record, env);
    const dir = sessionDataDir(record.id, env);
    fs.writeFileSync(path.join(dir, "xvfb.log"), "diagnostic");
    await destroySessionRecord(record.id, env);
    await buildProgram().parseAsync(["session", "prune", "--all-stopped", "--json"], { from: "user" });
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({ ok: true, pruned: [record.id] });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("leaves recent logs when an age is supplied", async () => {
    const env = { PICKFORGE_HOME: home };
    const record = await createSession({ type: "desktop", projectDir: home }, env);
    await retainSessionLogs(record, env);
    await destroySessionRecord(record.id, env);
    expect(await runSessionPrune({ olderThan: "7d", json: true })).toBe(0);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0]).pruned).toEqual([]);
  });
});
