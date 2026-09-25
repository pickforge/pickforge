import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const identityState = vi.hoisted(() => ({ miss: false }));
const memberState = vi.hoisted(() => ({
  onSeen: undefined as (() => void) | undefined,
}));

vi.mock("@pickforge/lab-core", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@pickforge/lab-core")
  >();
  return {
    ...actual,
    readProcessIdentity: (pid: number) =>
      identityState.miss ? undefined : actual.readProcessIdentity(pid),
    listProcessGroupMembers: (pgid: number) => {
      const members = actual.listProcessGroupMembers(pgid);
      if (members.some((pid) => pid !== pgid)) memberState.onSeen?.();
      return members;
    },
  };
});

import { spawnSync } from "node:child_process";
import {
  createContainmentScope,
  destroyContainmentScope,
  isProcessGroupAlive,
} from "@pickforge/lab-core";
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

  it("still joins and spawns when the caller's NODE_OPTIONS would hijack the supervisor", async () => {
    const die = path.join(root, "die.cjs");
    writeExecutable(die, "process.exit(99);\n");
    const hostile = `--require ${die}`;
    // Control: the injection really does take over a plain node process, so a
    // supervisor that inherited it could never reach its join.
    expect(
      spawnSync(process.execPath, ["-e", "0"], {
        env: { ...process.env, NODE_OPTIONS: hostile },
      }).status,
    ).toBe(99);

    const scope = createContainmentScope({ id: "desk-node-options", useCgroup: false });
    const command = path.join(root, "node-options-app");
    const dump = `${command}.env`;
    writeExecutable(
      command,
      `#!/bin/sh\necho $$ > '${command}.pid'\nenv > '${dump}'\nexec /bin/sleep 30\n`,
    );
    try {
      const app = await launchApp({
        display: DISPLAY,
        command,
        env: {
          NODE_OPTIONS: hostile,
          NODE_PATH: root,
          BUN_OPTIONS: `--preload ${die}`,
        },
        logDir: path.join(root, "node-options-logs"),
        containment: scope,
      });
      liveGroups.add(app.pid);
      expect(app.containment).toBe("marker");
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(dump) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const appEnv = fs.readFileSync(dump, "utf8").split("\n");
      expect(appEnv.some((line) => line.startsWith("NODE_OPTIONS="))).toBe(false);
      expect(appEnv.some((line) => line.startsWith("NODE_PATH="))).toBe(false);
      expect(appEnv.some((line) => line.startsWith("BUN_OPTIONS="))).toBe(false);
      expect(appEnv).toContain(`PICKFORGE_CONTAINMENT_TOKEN=${scope.token}`);
      readStartedGroup(`${command}.pid`);
    } finally {
      await destroyContainmentScope(scope, { termTimeoutMs: 500, killTimeoutMs: 500 });
    }
  });

  it("does not count supervisor startup against the launch grace window", async () => {
    // A supervisor whose own startup outlasts the grace window (#191). The
    // wrapper delays with a builtin, so nothing but the app ever joins the
    // group, and then becomes the real Node by exec, keeping the leader pid.
    const fifo = path.join(root, "slow-supervisor.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const realNode = process.execPath;
    const slowNode = path.join(root, "slow-node");
    writeExecutable(
      slowNode,
      `#!/bin/bash\nread -t 1 _ <>'${fifo}'\nexec '${realNode}' "$@"\n`,
    );
    const command = path.join(root, "exits-at-once");
    writeExecutable(command, "#!/bin/sh\nexit 0\n");
    const scope = createContainmentScope({ id: "desk-slow-supervisor", useCgroup: false });
    const startedAt = Date.now();
    process.execPath = slowNode;
    try {
      await expect(
        launchApp({
          display: DISPLAY,
          command,
          logDir: path.join(root, "slow-supervisor-logs"),
          containment: scope,
        }),
      ).rejects.toThrow(
        /exited immediately.*still held by the session's marker containment/,
      );
      // The launch really did wait through the delayed supervisor start.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
    } finally {
      process.execPath = realNode;
      await destroyContainmentScope(scope, { termTimeoutMs: 500, killTimeoutMs: 500 });
    }
  });

  it("does not count supervisor exit against the launch grace window", async () => {
    // A supervisor that outlives the app by more than the grace window, as a
    // loaded host can make it by delaying its exit poll (#203). The hold runs
    // inside process.exit, after the app is gone, so the group stays alive
    // with the supervisor as its only member. The app exits only once the
    // launcher has seen it, so the grace window has really opened.
    const hold = path.join(root, "hold-exit.cjs");
    writeExecutable(
      hold,
      'process.on("exit", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000));\n',
    );
    const realNode = process.execPath;
    const lingeringNode = path.join(root, "lingering-node");
    writeExecutable(
      lingeringNode,
      `#!/bin/sh\nexec '${realNode}' --require '${hold}' "$@"\n`,
    );
    const fifo = path.join(root, "release-app.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const release = fs.openSync(fifo, "r+");
    memberState.onSeen = () => {
      memberState.onSeen = undefined;
      fs.writeSync(release, "\n");
    };
    const command = path.join(root, "exits-once-seen");
    writeExecutable(command, `#!/bin/sh\nread _ < '${fifo}'\n`);
    const scope = createContainmentScope({ id: "desk-lingering-supervisor", useCgroup: false });
    process.execPath = lingeringNode;
    try {
      await expect(
        launchApp({
          display: DISPLAY,
          command,
          logDir: path.join(root, "lingering-supervisor-logs"),
          containment: scope,
        }),
      ).rejects.toThrow(
        /exited immediately.*still held by the session's marker containment/,
      );
    } finally {
      process.execPath = realNode;
      memberState.onSeen = undefined;
      fs.closeSync(release);
      await destroyContainmentScope(scope, { termTimeoutMs: 500, killTimeoutMs: 500 });
    }
  }, 10_000);

  it("keeps an app that leaves its group after launch running", async () => {
    // The app leaves a worker in its group and calls setsid() at once, so the
    // launcher may only ever see the worker. Once the worker exits, only the
    // supervisor is left in the group while the app is still running. That
    // is a launched app, not one that exited immediately.
    const fifo = path.join(root, "release-setsid.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const release = fs.openSync(fifo, "r+");
    memberState.onSeen = () => {
      memberState.onSeen = undefined;
      fs.writeSync(release, "\n");
    };
    const command = path.join(root, "leaves-group");
    const pidFile = `${command}.pid`;
    writeExecutable(
      command,
      `#!/bin/sh\necho $$ > '${pidFile}'\n(read _ < '${fifo}') &\nexec setsid /bin/sleep 30\n`,
    );
    const scope = createContainmentScope({ id: "desk-leaves-group", useCgroup: false });
    try {
      const app = await launchApp({
        display: DISPLAY,
        command,
        logDir: path.join(root, "leaves-group-logs"),
        containment: scope,
      });
      liveGroups.add(app.pid);
      const pid = readStartedGroup(pidFile);
      expect(isProcessGroupAlive(pid)).toBe(true);
    } finally {
      memberState.onSeen = undefined;
      fs.closeSync(release);
      await destroyContainmentScope(scope, { termTimeoutMs: 500, killTimeoutMs: 500 });
    }
  });

  it("fails the launch and stops a supervisor that never spawns the app", async () => {
    // A supervisor stuck before its spawn must not be reported as a launched
    // app once the bounded wait expires; the failure path stops its group.
    const fifo = path.join(root, "stuck-supervisor.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const realNode = process.execPath;
    const stuckNode = path.join(root, "stuck-node");
    writeExecutable(
      stuckNode,
      `#!/bin/bash\necho $$ > '${stuckNode}.pid'\nread _ <>'${fifo}'\nexec '${realNode}' "$@"\n`,
    );
    const command = path.join(root, "never-started");
    writeExecutable(command, `#!/bin/sh\ntouch '${command}.ran'\nexec /bin/sleep 30\n`);
    const scope = createContainmentScope({ id: "desk-stuck-supervisor", useCgroup: false });
    process.execPath = stuckNode;
    try {
      await expect(
        launchApp({
          display: DISPLAY,
          command,
          logDir: path.join(root, "stuck-supervisor-logs"),
          containment: scope,
        }),
      ).rejects.toThrow(/containment supervisor did not start .*never-started/);
      expect(fs.existsSync(`${command}.ran`)).toBe(false);
      await expectGroupGone(readStartedGroup(`${stuckNode}.pid`));
    } finally {
      process.execPath = realNode;
      await destroyContainmentScope(scope, { termTimeoutMs: 500, killTimeoutMs: 500 });
    }
  }, 20_000);

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
