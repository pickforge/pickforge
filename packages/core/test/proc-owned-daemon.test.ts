import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isProcessGroupAlive,
  listProcessGroupMembers,
  startDaemon,
  stopOwnedDaemonGroup,
} from "../src/index.js";

/**
 * Group-kill discipline for owned daemons (pickforge/pickforge#57). The Xvfb
 * and browser supervisors share this path: an individual kill would report a
 * daemon as gone while a surviving member of its process group still holds the
 * display or the profile.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-owned-daemon-"));
const logDir = path.join(root, "logs");
const groups = new Set<number>();

function writeExecutable(name: string, body: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

afterEach(() => {
  for (const pid of groups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  groups.clear();
});

describe("stopOwnedDaemonGroup", () => {
  it("kills a child that shares the daemon's process group", async () => {
    const command = writeExecutable(
      "forking-daemon.sh",
      "/bin/sleep 300 &\nexec /bin/sleep 300",
    );
    const daemon = await startDaemon(command, [], {
      logDir,
      name: "forking",
      owned: true,
    });
    groups.add(daemon.pid);
    expect(await waitUntil(() => listProcessGroupMembers(daemon.pid).length >= 2)).toBe(
      true,
    );

    expect(await stopOwnedDaemonGroup(daemon)).toBe(true);
    expect(isProcessGroupAlive(daemon.pid)).toBe(false);
    expect(listProcessGroupMembers(daemon.pid)).toEqual([]);
  }, 20_000);

  it("does not report cleanup when the leader exited but a group member lives", async () => {
    // The exact shape #57 is about: the daemon process is gone, so an
    // individual kill would look successful, while its group is not empty.
    const command = writeExecutable(
      "leader-exits.sh",
      "/bin/sleep 300 &\nexit 0",
    );
    const daemon = await startDaemon(command, [], {
      logDir,
      name: "leader-exits",
      owned: true,
    });
    groups.add(daemon.pid);
    expect(
      await waitUntil(
        () =>
          daemon.child.exitCode !== null &&
          listProcessGroupMembers(daemon.pid).length > 0,
      ),
    ).toBe(true);

    expect(await stopOwnedDaemonGroup(daemon)).toBe(true);
    expect(listProcessGroupMembers(daemon.pid)).toEqual([]);
    expect(isProcessGroupAlive(daemon.pid)).toBe(false);
  }, 20_000);

  it("confirms an already-empty group without signalling anything", async () => {
    const command = writeExecutable("instant.sh", "exit 0");
    const daemon = await startDaemon(command, [], {
      logDir,
      name: "instant",
      owned: true,
    });
    groups.add(daemon.pid);
    expect(await waitUntil(() => daemon.child.exitCode !== null)).toBe(true);

    expect(await stopOwnedDaemonGroup(daemon)).toBe(true);
    expect(isProcessGroupAlive(daemon.pid)).toBe(false);
  }, 20_000);

  it("escalates to SIGKILL for a daemon that ignores SIGTERM", async () => {
    const command = writeExecutable(
      "stubborn.sh",
      "trap '' TERM\nwhile :; do sleep 0.2; done",
    );
    const daemon = await startDaemon(command, [], {
      logDir,
      name: "stubborn",
      owned: true,
    });
    groups.add(daemon.pid);
    expect(await waitUntil(() => isProcessGroupAlive(daemon.pid))).toBe(true);

    expect(await stopOwnedDaemonGroup(daemon)).toBe(true);
    expect(isProcessGroupAlive(daemon.pid)).toBe(false);
  }, 20_000);
});
