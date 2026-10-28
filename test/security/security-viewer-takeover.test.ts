import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, readHumanLease, sessionDataDir, stopPid, type EnvLike } from "@pickforge/lab-core";
import { endHumanTakeover, recoverStaleHumanLease, startHumanTakeover } from "../../packages/desktop-linux/src/takeover.js";
import { startVnc } from "../../packages/desktop-linux/src/vnc.js";
import { freeLoopbackPort, releaseLoopbackPorts } from "../../packages/desktop-linux/test/test-resources.js";

vi.mock("../../packages/desktop-linux/src/stuck-input.js", () => ({ releaseStuckInput: vi.fn(async () => {}) }));

let root: string;
let vncPid: number | undefined;
afterEach(async () => {
  if (vncPid !== undefined) await stopPid(vncPid);
  vncPid = undefined;
  releaseLoopbackPorts();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("viewer transport never starts writable x11vnc", () => {
  it.each(["return", "timeout", "cancelled", "recovery"])("keeps VNC read-only through %s", async (reason) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-viewer-security-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const log = path.join(root, "argv.jsonl");
    fs.writeFileSync(path.join(bin, "x11vnc"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + '\\n');
require('node:net').createServer().listen(Number(args[args.indexOf('-rfbport') + 1]), '127.0.0.1');
`, { mode: 0o755 });
    const env: EnvLike = { ...process.env, PICKFORGE_HOME: path.join(root, "home"), PATH: bin, ARGV_LOG: log };
    const vnc = await startVnc({ display: ":42", port: await freeLoopbackPort(), logDir: root, env, viewOnly: true });
    vncPid = vnc.pid;
    const record = await createSession({ type: "desktop", status: "running", projectDir: root,
      desktop: { display: ":42", homePolicy: "private", vncPid, vncStartTimeTicks: vnc.startTimeTicks, vncPort: vnc.port, vncViewOnly: true },
    }, env);
    const handle = await startHumanTakeover(record.id, { transport: "viewer", registryEnv: env, env });
    if (reason === "recovery") {
      const stale = { ...await readHumanLease(record.id, env), ownerPid: 999_999, ownerStartTicks: undefined, expiresAt: new Date(0).toISOString() };
      fs.writeFileSync(path.join(sessionDataDir(record.id, env), "human.lease.json"), JSON.stringify(stale));
      expect(await recoverStaleHumanLease(record.id, env)).toEqual({ recovered: true });
    } else {
      await endHumanTakeover(handle, { registryEnv: env, env, reason: reason as "return" | "timeout" | "cancelled" });
    }
    const starts = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(starts).toHaveLength(1);
    for (const argv of starts) expect(argv).toContain("-viewonly");
  });
});
