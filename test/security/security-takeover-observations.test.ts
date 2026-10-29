import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acquireHumanLease, releaseHumanLease, type EnvLike } from "@pickforge/lab-core";
import { runDesktopScreenshot, runDesktopWait } from "../../packages/cli/src/commands/desktop.js";
import { connectLab, makeLabDirs, MINI_PNG, writeDesktopSessionRecord, writeScript,
  type ConnectedLab, type LabDirs } from "../../packages/mcp-server/test/helpers.js";

let dirs: LabDirs;
let lab: ConnectedLab | undefined;
let env: EnvLike;
let id: string;
let entered: string;
let resume: string;

beforeEach(() => {
  dirs = makeLabDirs();
  env = { PICKFORGE_HOME: dirs.home, PICKFORGE_STORAGE_MODE: "project-local", PATH: `${dirs.binDir}:${process.env.PATH}` };
  id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
  entered = path.join(dirs.root, "entered");
  resume = path.join(dirs.root, "resume");
  const fixture = path.join(dirs.root, "fixture.png");
  fs.writeFileSync(fixture, MINI_PNG);
  const pause = `echo $$ > "${entered}"\nwhile [ ! -f "${resume}" ]; do /bin/sleep 0.01; done\n`;
  const capture = pause + `for arg in "$@"; do out="$arg"; done\n/bin/cp "${fixture}" "$out"`;
  for (const tool of ["import", "maim", "scrot"]) writeScript(path.join(dirs.binDir, tool), capture);
  writeScript(path.join(dirs.binDir, "xdotool"), `case "$1" in\n search) ${pause}exit 1 ;;\nesac`);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  fs.writeFileSync(resume, "");
  await lab?.close();
  lab = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
  fs.rmSync(dirs.root, { recursive: true, force: true });
});

function observationArgs(kind: string, baseline: string): Record<string, unknown> {
  if (kind === "window") return { window: "Absent" };
  if (kind === "changed") return { baseline };
  return { stableMs: 60_000 };
}

/** True once a process has exited, reaped or not. */
function ended(pid: number): boolean {
  let stat: string;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return true; }
  return stat.includes(") Z ");
}

async function startObservation(transport: string, kind: string, baseline: string): Promise<{ done: Promise<unknown> }> {
  if (transport === "mcp") {
    lab = await connectLab({ projectDir: dirs.projectDir, env });
    const args = kind === "screenshot" ? {} : { timeoutMs: 5_000, ...observationArgs(kind, baseline) };
    return { done: lab.client.callTool({ name: kind === "screenshot" ? "desktop_screenshot" : "desktop_wait",
      arguments: { session: id, ...args } }) };
  }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const opts = { session: id, projectDir: dirs.projectDir, json: true };
  if (kind === "screenshot") return { done: runDesktopScreenshot(opts) };
  const selected = kind === "window" ? { window: "Absent" } : kind === "changed" ? { changedFrom: baseline } : { stable: "60000" };
  return { done: runDesktopWait({ ...opts, timeout: "5000", ...selected }) };
}

it.each([
  ["mcp", "screenshot"], ["cli", "screenshot"],
  ["mcp", "stable"], ["cli", "stable"],
  ["mcp", "changed"], ["cli", "changed"],
  ["mcp", "window"], ["cli", "window"],
])("drains an in-flight %s %s observation before granting control", async (transport, kind) => {
  const baseline = path.join(dirs.projectDir, "baseline.png");
  fs.writeFileSync(baseline, MINI_PNG);
  const operation = await startObservation(transport, kind, baseline);
  let granted = false;
  let sampleEndedAtGrant = false;
  let created!: () => void;
  const published = new Promise<void>((resolve) => { created = resolve; });
  await expect.poll(() => fs.existsSync(entered) && fs.readFileSync(entered, "utf8").trim() !== "").toBe(true);
  const sample = Number(fs.readFileSync(entered, "utf8"));
  const acquisition = acquireHumanLease(id, env, { _afterCreate: async () => { created(); } })
    .then((lease) => { granted = true; sampleEndedAtGrant = ended(sample); return lease; });
  try {
    await published;
    // A wait may cancel its sample when it sees the lease; either way the
    // grant must come after the sample ended, never while it still runs.
    await sleep(40);
  } finally {
    fs.writeFileSync(resume, "");
    const lease = await acquisition;
    try { await operation.done; }
    finally { await releaseHumanLease(id, lease.leaseId, env); }
  }
  // A long wait releases its permit after this sample and refuses the next.
  expect(granted).toBe(true);
  expect(sampleEndedAtGrant).toBe(true);
});
