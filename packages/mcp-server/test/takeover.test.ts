import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHumanLease, releaseHumanLease } from "@pickforge/lab-core";
import {
  connectLab,
  makeLabDirs,
  parseToolJson,
  writeDesktopSessionRecord,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

let dirs: LabDirs;
let lab: ConnectedLab;

afterEach(async () => {
  await lab?.close();
  if (dirs !== undefined) {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

describe("takeover_status", () => {
  it("reports agent-active, then human-active, then stale", async () => {
    dirs = makeLabDirs();
    const env = { PICKFORGE_HOME: dirs.home };
    lab = await connectLab({ projectDir: dirs.projectDir, env });
    const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);

    const idle = parseToolJson(
      await lab.client.callTool({ name: "takeover_status", arguments: { session: id } }),
    );
    expect(idle.ok).toBe(true);
    expect(idle.active).toBe(false);
    expect(idle.lease).toBeUndefined();

    const lease = await acquireHumanLease(id, env);
    const active = parseToolJson(
      await lab.client.callTool({ name: "takeover_status", arguments: { session: id } }),
    );
    expect(active.active).toBe(true);
    expect(active.lease).toMatchObject({ leaseId: lease.leaseId, ownerPid: lease.ownerPid });

    await releaseHumanLease(id, lease.leaseId, env);
    const stalePath = path.join(dirs.home, "sessions", id, "human.lease.json");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(
      stalePath,
      `${JSON.stringify({
        leaseId: "dead",
        sessionId: id,
        ownerPid: 999_999,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ttlMs: 30_000,
        heartbeatMs: 5_000,
      })}\n`,
    );
    const stale = parseToolJson(
      await lab.client.callTool({ name: "takeover_status", arguments: { session: id } }),
    );
    expect(stale.active).toBe(false);
    expect(stale.stale).toBe(true);
  });
});

describe("desktop input tools fail closed under human control", () => {
  it("rejects desktop_click with a stable busy error while a lease is held, without touching xdotool", async () => {
    dirs = makeLabDirs();
    const env = { PICKFORGE_HOME: dirs.home };
    lab = await connectLab({ projectDir: dirs.projectDir, env });
    const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);

    const lease = await acquireHumanLease(id, env);
    const result = parseToolJson(
      await lab.client.callTool({
        name: "desktop_click",
        arguments: { session: id, x: 1, y: 1 },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("human control is active");
    await releaseHumanLease(id, lease.leaseId, env);
  });

  it("rejects desktop_type and desktop_key the same way", async () => {
    dirs = makeLabDirs();
    const env = { PICKFORGE_HOME: dirs.home };
    lab = await connectLab({ projectDir: dirs.projectDir, env });
    const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
    await acquireHumanLease(id, env);

    const typed = parseToolJson(
      await lab.client.callTool({
        name: "desktop_type",
        arguments: { session: id, text: "hello" },
      }),
    );
    expect(typed.ok).toBe(false);
    expect(typed.errors.join("\n")).toContain("human control is active");

    const keyed = parseToolJson(
      await lab.client.callTool({
        name: "desktop_key",
        arguments: { session: id, key: "Return" },
      }),
    );
    expect(keyed.ok).toBe(false);
    expect(keyed.errors.join("\n")).toContain("human control is active");
  });

  it("rejects desktop_launch too (a new client can grab focus on the shared display)", async () => {
    dirs = makeLabDirs();
    const env = { PICKFORGE_HOME: dirs.home };
    lab = await connectLab({ projectDir: dirs.projectDir, env });
    const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
    const lease = await acquireHumanLease(id, env);

    const launched = parseToolJson(
      await lab.client.callTool({
        name: "desktop_launch",
        arguments: { session: id, command: "xterm" },
      }),
    );
    expect(launched.ok).toBe(false);
    expect(launched.errors.join("\n")).toContain("human control is active");

    await releaseHumanLease(id, lease.leaseId, env);
  });

  it("leaves desktop_screenshot ungated (read-only, no input delivered)", async () => {
    dirs = makeLabDirs();
    const env = { PICKFORGE_HOME: dirs.home };
    lab = await connectLab({ projectDir: dirs.projectDir, env });
    const id = writeDesktopSessionRecord(dirs.home, dirs.projectDir);
    await acquireHumanLease(id, env);

    const result = parseToolJson(
      await lab.client.callTool({ name: "desktop_screenshot", arguments: { session: id } }),
    );
    // Not gated: it fails only because there is no real display/screenshot
    // tool in this test environment, never because of the human lease.
    expect(result.errors.join("\n")).not.toContain("human control is active");
  });
});
