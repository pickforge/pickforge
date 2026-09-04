import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const identityState = vi.hoisted(() => ({ miss: false }));

vi.mock("@pickforge/lab-core", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@pickforge/lab-core")
  >();
  return {
    ...actual,
    readProcessIdentity: (pid: number) =>
      identityState.miss ? undefined : actual.readProcessIdentity(pid),
  };
});

import { isProcessGroupAlive } from "@pickforge/lab-core";
import { execApp, launchApp } from "../src/apps.js";

const DISPLAY = ":219";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-app-wait-"));
const liveGroups = new Set<number>();

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function makeLongRunningCommand(name: string): {
  command: string;
  pidFile: string;
} {
  const command = path.join(root, name);
  const pidFile = `${command}.pid`;
  writeExecutable(
    command,
    `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 30\n`,
  );
  return { command, pidFile };
}

function readStartedGroup(pidFile: string): number {
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  liveGroups.add(pid);
  return pid;
}

async function expectGroupGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (isProcessGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(isProcessGroupAlive(pid)).toBe(false);
  liveGroups.delete(pid);
}

function makeXdotool(name: string, script: string): string {
  const binDir = path.join(root, name);
  writeExecutable(path.join(binDir, "xdotool"), `#!/bin/sh\n${script}\n`);
  return binDir;
}

afterEach(() => {
  identityState.miss = false;
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  liveGroups.clear();
});

describe("app wait cleanup", () => {
  it("stops the process group when window listing throws", async () => {
    const { command, pidFile } = makeLongRunningCommand("list-throws");
    const marker = path.join(root, "list-throws.count");
    const binDir = makeXdotool(
      "list-throws-bin",
      `count=$(cat '${marker}' 2>/dev/null || echo 0)\n` +
        `count=$((count + 1)); echo "$count" > '${marker}'\n` +
        `[ "$count" -eq 1 ] && exit 1\n` +
        `echo 'query failed' >&2\nexit 2`,
    );

    await expect(
      execApp({
        display: DISPLAY,
        command,
        env: { PATH: `${binDir}:/usr/bin:/bin` },
        logDir: path.join(root, "list-throws-logs"),
      }),
    ).rejects.toThrow(/xdotool search failed/);

    await expectGroupGone(readStartedGroup(pidFile));
  });

  it("stops the process group when identity never resolves", async () => {
    identityState.miss = true;
    const { command, pidFile } = makeLongRunningCommand("identity-miss");

    await expect(
      launchApp({
        display: DISPLAY,
        command,
        logDir: path.join(root, "identity-miss-logs"),
      }),
    ).rejects.toThrow(/Could not capture the process identity/);

    await expectGroupGone(readStartedGroup(pidFile));
  });

  it("stops the process group when the window wait times out", async () => {
    const { command, pidFile } = makeLongRunningCommand("window-timeout");
    const binDir = makeXdotool("window-timeout-bin", "exit 1");

    await expect(
      execApp({
        display: DISPLAY,
        command,
        env: { PATH: `${binDir}:/usr/bin:/bin` },
        logDir: path.join(root, "window-timeout-logs"),
        windowTimeoutMs: 0,
      }),
    ).rejects.toThrow(/No new client window appeared/);

    await expectGroupGone(readStartedGroup(pidFile));
  });
});
