import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  getSession,
  updateSession,
  readProcessIdentity,
  identityIsAlive,
  listProcessGroupMembers,
} from "@pickforge/lab-core";
import {
  prepareViewerLaunch,
  writeViewerLaunchRecord,
  readViewerLaunchRecord,
  removeViewerLaunch,
  sessionViewerDir,
  stopSessionViewer,
  connectSessionVncReadOnly,
  withViewerDir,
  readViewerPrivateFile,
  writeViewerPrivateFile,
  type ViewerLaunchRecord,
} from "../src/viewer-state.js";
import { withSessionVncLock, teardownDesktopSession } from "../src/session.js";
import { teardownBrowserSession } from "../../browser/src/session.js";

let testRoot: string;
let registryEnv: NodeJS.ProcessEnv;
let sessionId: string;
const children: ChildProcess[] = [];
const servers: net.Server[] = [];
const survivors: { pid: number; startTicks: number }[] = [];

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pickforge-viewer-state-test-"));
  registryEnv = { ...process.env, PICKFORGE_HOME: testRoot };
  sessionId = (
    await createSession(
      {
        type: "desktop",
        status: "running",
        projectDir: testRoot,
        desktop: { display: ":991" },
      },
      registryEnv,
    )
  ).id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const identity of survivors.splice(0)) {
    if (identityIsAlive(identity.pid, identity.startTicks)) {
      process.kill(identity.pid, "SIGKILL");
    }
  }
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, "exit");
    }
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fs.rm(testRoot, { recursive: true, force: true });
});

async function browser(): Promise<{
  pid: number;
  startTicks: number;
}> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  children.push(child);
  await once(child, "spawn");
  return readProcessIdentity(child.pid!)!;
}

async function viewerProcessGroup(
  launchRecord: ViewerLaunchRecord,
  memberArguments: string[][],
  mode: "term" | "kill" = "term",
  exitFile?: string,
): Promise<{
  leader: ChildProcess;
  leaderIdentity: { pid: number; startTicks: number };
  members: { pid: number; startTicks: number }[];
  trace: string;
}> {
  const trace = path.join(testRoot, "viewer-signals.jsonl");
  const childScript = `
const fileSystem = require('node:fs');
process.on('SIGTERM', () => {
  fileSystem.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({
    pid: process.pid,
    profileExists: fileSystem.existsSync(${JSON.stringify(launchRecord.profileDir)}),
  }) + '\\n');
  if (${JSON.stringify(mode)} === 'term') {
    process.exit(0);
  }
});
process.stdout.write('ready');
const exitFile = ${JSON.stringify(exitFile) ?? "undefined"};
if (exitFile !== undefined) {
  setInterval(() => {
    if (fileSystem.existsSync(exitFile)) process.exit(0);
  }, 20);
}
setInterval(() => {}, 1000);
`;
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `
const { spawn } = require('node:child_process');
const argumentsByMember = ${JSON.stringify(memberArguments)};
Promise.all(argumentsByMember.map((args) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}, '--', ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.stdout.once('data', () => resolve(child.pid));
}))).then((pids) => process.stdout.write(JSON.stringify(pids)));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  children.push(leader);
  const [ready] = await once(leader.stdout!, "data");
  const members = (JSON.parse(ready.toString()) as number[]).map(
    (pid) => readProcessIdentity(pid)!,
  );
  survivors.push(...members);
  return {
    leader,
    leaderIdentity: readProcessIdentity(leader.pid!)!,
    members,
    trace,
  };
}

async function exitGroupLeader(leader: ChildProcess): Promise<void> {
  const exited = once(leader, "exit");
  leader.kill("SIGTERM");
  await exited;
}

async function record(): Promise<ViewerLaunchRecord> {
  const launch = await prepareViewerLaunch(sessionId, registryEnv);
  return {
    launchId: launch.launchId,
    sessionId: sessionId,
    createdAt: new Date().toISOString(),
    browser: { kind: "chromium", binary: process.execPath },
    profileDir: launch.profileDir,
    thumbnail: { width: 320, height: 200 },
    expanded: { width: 1280, height: 800 },
  };
}

async function vnc(): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.end("RFB");
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  const identity = await browser();
  await updateSession(
    sessionId,
    {
      desktop: {
        display: ":991",
        vncPid: identity.pid,
        vncStartTimeTicks: identity.startTicks,
        vncPort: port,
        vncViewOnly: true,
      },
    },
    registryEnv,
  );
  return port;
}

describe("private viewer state", () => {
  it("follows a linked registry root while refusing viewer descendants that are links", async () => {
    const sessions = path.join(testRoot, "sessions");
    const target = path.join(testRoot, "linked-sessions");
    await fs.rename(sessions, target);
    await fs.symlink(target, sessions);
    const launchRecord = await record();
    await writeViewerLaunchRecord(launchRecord, registryEnv);
    expect(
      await readViewerLaunchRecord(
        sessionId,
        launchRecord.launchId,
        registryEnv,
      ),
    ).toEqual(launchRecord);
    await fs.rm(launchRecord.profileDir, { recursive: true });
    const foreign = path.join(testRoot, "foreign-profile");
    await fs.mkdir(foreign, { mode: 0o700 });
    await fs.symlink(foreign, launchRecord.profileDir);
    await expect(
      writeViewerLaunchRecord(launchRecord, registryEnv),
    ).rejects.toThrow();
    expect(
      await readViewerLaunchRecord(
        sessionId,
        launchRecord.launchId,
        registryEnv,
      ),
    ).toBeUndefined();
  });
  it.each(["invalid-json", "unsafe-mode", "symlink"] as const)(
    "skips an unprunable %s launch and names it during teardown",
    async (condition) => {
      const launchRecord = await record();
      const launchDirectory = path.dirname(launchRecord.profileDir);
      if (condition === "invalid-json") {
        await fs.writeFile(
          path.join(launchDirectory, "launch.json"),
          "{broken",
          { mode: 0o600 },
        );
      } else if (condition === "unsafe-mode") {
        await fs.chmod(launchDirectory, 0o755);
      } else {
        await fs.rm(launchDirectory, { recursive: true });
        const foreign = path.join(testRoot, "foreign-launch");
        await fs.mkdir(foreign, { mode: 0o700 });
        await fs.symlink(foreign, launchDirectory);
      }
      const stale = new Date(Date.now() - 700_000);
      await fs.lutimes(launchDirectory, stale, stale);
      const next = await prepareViewerLaunch(sessionId, registryEnv);
      expect(await fs.lstat(next.profileDir)).toBeDefined();
      expect(await fs.lstat(launchDirectory)).toBeDefined();
      const failures = await stopSessionViewer(
        sessionId,
        undefined,
        registryEnv,
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]!.message).toContain(launchRecord.launchId);
      expect(
        await fs.lstat(sessionViewerDir(sessionId, registryEnv)),
      ).toBeDefined();
    },
  );
  it("creates random private profiles and atomic private records", async () => {
    const launchRecord = await record();
    expect(launchRecord.launchId).toMatch(/^[0-9a-f]{32}$/);
    for (const directory of [
      sessionViewerDir(sessionId, registryEnv),
      path.dirname(path.dirname(launchRecord.profileDir)),
      path.dirname(launchRecord.profileDir),
      launchRecord.profileDir,
    ]) {
      const stat = await fs.lstat(directory);
      expect(stat.mode & 0o777).toBe(0o700);
      expect(stat.uid).toBe(process.getuid?.());
    }
    await writeViewerLaunchRecord(launchRecord, registryEnv);
    await writeViewerLaunchRecord(
      { ...launchRecord, expanded: { width: 900, height: 600 } },
      registryEnv,
    );
    expect(
      (
        await readViewerLaunchRecord(
          sessionId,
          launchRecord.launchId,
          registryEnv,
        )
      )?.expanded.width,
    ).toBe(900);
    expect(
      (
        await fs.stat(
          path.join(path.dirname(launchRecord.profileDir), "launch.json"),
        )
      ).mode & 0o777,
    ).toBe(0o600);
    await removeViewerLaunch(sessionId, launchRecord.launchId, registryEnv);
    expect(
      await readViewerLaunchRecord(
        sessionId,
        launchRecord.launchId,
        registryEnv,
      ),
    ).toBeUndefined();
    expect(() => sessionViewerDir("../../escape", registryEnv)).toThrow();
    await expect(
      connectSessionVncReadOnly("../escape", registryEnv),
    ).rejects.toThrow("Invalid session id");
    expect(
      await readViewerLaunchRecord(sessionId, "../escape", registryEnv),
    ).toBeUndefined();
  });
  it.each([
    { launchId: "bad" },
    { sessionId: "desk-abcdef" },
    { thumbnail: { width: 0, height: 1 } },
    { thumbnail: null },
    { thumbnail: { width: 1, height: 0 } },
    { expanded: { width: 2.5, height: -1 } },
    { expanded: undefined },
    { pid: -1 },
    { pid: 1, startTicks: -1 },
    { startTicks: 1 },
    { browser: { kind: "other", binary: "/bin/browser" } },
    { browser: { kind: "chromium", binary: "relative" } },
    { profileDir: "/tmp/foreign" },
    { createdAt: "bad" },
    { hyprland: { hyprctl: "relative", instance: "ok" } },
    { hyprland: null },
  ])("rejects an invalid launch record %j", async (patch) => {
    const launchRecord = await record();
    await expect(
      writeViewerLaunchRecord(
        { ...launchRecord, ...patch } as ViewerLaunchRecord,
        registryEnv,
      ),
    ).rejects.toThrow();
    await fs.writeFile(
      path.join(path.dirname(launchRecord.profileDir), "launch.json"),
      JSON.stringify({ ...launchRecord, ...patch }),
      { mode: 0o600 },
    );
    expect(
      await readViewerLaunchRecord(
        sessionId,
        launchRecord.launchId,
        registryEnv,
      ),
    ).toBeUndefined();
  });
  it.each(["bad-instance!", "../escape", "null", ""])(
    'rejects invalid compositor instance "%s"',
    async (instance) => {
      const launchRecord = await record();
      launchRecord.hyprland = {
        hyprctl: "/bin/hyprctl",
        instance,
        xdgRuntimeDir: "/run/user/1000",
        ruleName: `pickforge-viewer-${launchRecord.launchId}`,
        classPattern: "^viewer$",
      };
      if (instance === "null") {
        launchRecord.hyprland.classPattern = "x\nx";
      }
      await expect(
        writeViewerLaunchRecord(launchRecord, registryEnv),
      ).rejects.toThrow();
    },
  );
  it("validates rule name, class length and valid Hyprland metadata", async () => {
    const launchRecord = await record();
    launchRecord.hyprland = {
      hyprctl: "/bin/hyprctl",
      instance: "safe_1",
      xdgRuntimeDir: "/run/user/1000",
      ruleName: `pickforge-viewer-${launchRecord.launchId}`,
      classPattern: "^viewer$",
    };
    await writeViewerLaunchRecord(launchRecord, registryEnv);
    expect(
      await readViewerLaunchRecord(
        sessionId,
        launchRecord.launchId,
        registryEnv,
      ),
    ).toEqual(launchRecord);
    for (const hyprland of [
      { ...launchRecord.hyprland, ruleName: "foreign" },
      { ...launchRecord.hyprland, classPattern: "x".repeat(513) },
      { ...launchRecord.hyprland, xdgRuntimeDir: "relative" },
      { ...launchRecord.hyprland, classPattern: undefined },
    ]) {
      await expect(
        writeViewerLaunchRecord(
          { ...launchRecord, hyprland } as ViewerLaunchRecord,
          registryEnv,
        ),
      ).rejects.toThrow();
    }
  });
  it("refuses viewer, profile and record symlinks", async () => {
    const launchRecord = await record();
    const target = path.join(testRoot, "target");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.rm(launchRecord.profileDir, { recursive: true });
    await fs.symlink(target, launchRecord.profileDir);
    await expect(
      writeViewerLaunchRecord(launchRecord, registryEnv),
    ).rejects.toThrow();
    expect(
      await readViewerLaunchRecord(
        sessionId,
        launchRecord.launchId,
        registryEnv,
      ),
    ).toBeUndefined();
    const launches = path.dirname(path.dirname(launchRecord.profileDir));
    const second = await record();
    const recordPath = path.join(
      path.dirname(second.profileDir),
      "launch.json",
    );
    await fs.symlink(path.join(testRoot, "sentinel"), recordPath);
    await expect(
      writeViewerLaunchRecord(second, registryEnv),
    ).rejects.toThrow();
    expect(
      await readViewerLaunchRecord(sessionId, second.launchId, registryEnv),
    ).toBeUndefined();
    await fs.rm(launches, { recursive: true });
    await fs.rm(sessionViewerDir(sessionId, registryEnv), { recursive: true });
    await fs.symlink(target, sessionViewerDir(sessionId, registryEnv));
    await expect(prepareViewerLaunch(sessionId, registryEnv)).rejects.toThrow();
    expect(await fs.readdir(target)).toEqual([]);
  });
  it("rejects unsafe modes, wrong owners and private file symlinks", async () => {
    await prepareViewerLaunch(sessionId, registryEnv);
    await fs.chmod(sessionViewerDir(sessionId, registryEnv), 0o755);
    await expect(prepareViewerLaunch(sessionId, registryEnv)).rejects.toThrow();
    await fs.chmod(sessionViewerDir(sessionId, registryEnv), 0o700);
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    await expect(prepareViewerLaunch(sessionId, registryEnv)).rejects.toThrow();
    vi.restoreAllMocks();
    await withViewerDir(sessionId, registryEnv, false, async (directory) => {
      await writeViewerPrivateFile(directory, "token", "secret");
      expect(await readViewerPrivateFile(directory, "token")).toBe("secret");
      await fs.chmod(directory.resolve("token"), 0o644);
      await expect(readViewerPrivateFile(directory, "token")).rejects.toThrow();
      await expect(
        writeViewerPrivateFile(directory, "token", "new"),
      ).rejects.toThrow();
      await directory.unlinkChild("token");
      await fs.symlink(
        path.join(testRoot, "foreign"),
        directory.resolve("token"),
      );
      await expect(readViewerPrivateFile(directory, "token")).rejects.toThrow();
      await expect(
        writeViewerPrivateFile(directory, "token", "new"),
      ).rejects.toThrow();
    });
  });
  it("prunes dead browsers and stale launches but retains live and recent launches", async () => {
    const live = await record();
    Object.assign(live, await browser());
    await writeViewerLaunchRecord(live, registryEnv);
    const dead = await record();
    dead.pid = 99999999;
    dead.startTicks = 1;
    await writeViewerLaunchRecord(dead, registryEnv);
    const stale = await record();
    stale.createdAt = new Date(Date.now() - 700000).toISOString();
    await writeViewerLaunchRecord(stale, registryEnv);
    const bare = await prepareViewerLaunch(sessionId, registryEnv);
    const old = new Date(Date.now() - 700000);
    await fs.utimes(bare.launchDir, old, old);
    const recent = await record();
    await writeViewerLaunchRecord(recent, registryEnv);
    await prepareViewerLaunch(sessionId, registryEnv);
    expect(
      await readViewerLaunchRecord(sessionId, dead.launchId, registryEnv),
    ).toBeUndefined();
    expect(
      await readViewerLaunchRecord(sessionId, stale.launchId, registryEnv),
    ).toBeUndefined();
    await expect(fs.lstat(bare.launchDir)).rejects.toThrow();
    expect(
      await readViewerLaunchRecord(sessionId, live.launchId, registryEnv),
    ).toEqual(live);
    expect(
      await readViewerLaunchRecord(sessionId, recent.launchId, registryEnv),
    ).toEqual(recent);
    await expect(
      removeViewerLaunch(sessionId, live.launchId, registryEnv),
    ).rejects.toThrow(/alive/);
  });
});

describe("read-only VNC connection", () => {
  it("connects to the recorded loopback endpoint and excludes takeover until connected", async () => {
    const port = await vnc();
    let release!: () => void;
    const held = withSessionVncLock(
      sessionId,
      registryEnv,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    let done = false;
    const connecting = connectSessionVncReadOnly(sessionId, registryEnv).then(
      (socket) => {
        done = true;
        return socket;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false);
    release();
    await held;
    const socket = await connecting;
    expect(socket.remoteAddress).toBe("127.0.0.1");
    expect(socket.remotePort).toBe(port);
    socket.destroy();
  });
  it("holds the VNC lock from the record check until TCP connect completes", async () => {
    const port = await vnc();
    const socket = new net.Socket();
    const connect = vi.spyOn(net, "connect").mockReturnValue(socket);
    const connecting = connectSessionVncReadOnly(sessionId, registryEnv);
    await vi.waitFor(() =>
      expect(connect).toHaveBeenCalledWith({ host: "127.0.0.1", port }),
    );
    let swapped = false;
    const takeover = withSessionVncLock(sessionId, registryEnv, async () => {
      swapped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(swapped).toBe(false);
    socket.emit("connect");
    expect(await connecting).toBe(socket);
    await takeover;
    expect(swapped).toBe(true);
    socket.destroy();
  });
  it("bounds a stalled TCP connect and rejects an absent session record", async () => {
    await vnc();
    const socket = new net.Socket();
    vi.spyOn(net, "connect").mockReturnValue(socket);
    await expect(
      connectSessionVncReadOnly(sessionId, registryEnv),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(socket.destroyed).toBe(true);
    await fs.unlink(path.join(testRoot, "sessions", `${sessionId}.json`));
    await expect(
      connectSessionVncReadOnly(sessionId, registryEnv),
    ).rejects.toMatchObject({ reason: "session-ended" });
  });
  it.each([
    [{ status: "stopped" }, "session-ended"],
    [{ desktop: undefined }, "unavailable"],
    [
      {
        desktop: {
          display: ":991",
          vncPid: process.pid,
          vncPort: 5900,
          vncViewOnly: true,
        },
      },
      "unavailable",
    ],
  ])("rejects unusable session %j", async (patch, reason) => {
    await updateSession(
      sessionId,
      patch as Parameters<typeof updateSession>[1],
      registryEnv,
    );
    await expect(
      connectSessionVncReadOnly(sessionId, registryEnv),
    ).rejects.toMatchObject({ reason });
  });
  it("rejects writable, reused identity, invalid port and failed connect", async () => {
    await vnc();
    const desktop = (await getSession(sessionId, registryEnv))!.desktop!;
    for (const [patch, reason] of [
      [{ vncViewOnly: false }, "writable"],
      [{ vncViewOnly: undefined }, "writable"],
      [{ vncStartTimeTicks: desktop.vncStartTimeTicks! + 1 }, "unavailable"],
      [{ vncPid: 0 }, "unavailable"],
      [{ vncPort: 0 }, "unavailable"],
      [{ vncPort: 65536 }, "unavailable"],
      [{ vncPort: 1 }, "unavailable"],
    ] as const) {
      await updateSession(
        sessionId,
        { desktop: { ...desktop, ...patch } },
        registryEnv,
      );
      await expect(
        connectSessionVncReadOnly(sessionId, registryEnv),
      ).rejects.toMatchObject({ reason });
    }
  });
});

// Teardown tests wait on fixed 1 s product budgets: launch removal, launch
// pruning, and the SIGTERM grace before SIGKILL. The kill case spends about
// 3 s in them and took 4.5 s on an idle host, so vitest's 5 s default timed
// it out under concurrent suites (#263).
const TEARDOWN_TIMEOUT_MS = 20_000;

describe("viewer teardown", { timeout: TEARDOWN_TIMEOUT_MS }, () => {
  it.each(["term", "kill"] as const)(
    "stops surviving browser children with %s after their group leader exits",
    async (mode) => {
      const launchRecord = await record();
      const group = await viewerProcessGroup(
        launchRecord,
        [[`--user-data-dir=${launchRecord.profileDir}`]],
        mode,
      );
      const childIdentity = group.members[0]!;
      const leaderIdentity = group.leaderIdentity;
      Object.assign(launchRecord, leaderIdentity);
      await writeViewerLaunchRecord(launchRecord, registryEnv);
      await exitGroupLeader(group.leader);
      const signal = vi.spyOn(process, "kill");
      expect(listProcessGroupMembers(leaderIdentity.pid)).toContain(
        childIdentity.pid,
      );
      await expect(
        removeViewerLaunch(sessionId, launchRecord.launchId, registryEnv),
      ).rejects.toThrow(/alive/);
      await prepareViewerLaunch(sessionId, registryEnv);
      expect(await fs.lstat(launchRecord.profileDir)).toBeDefined();
      expect(
        await stopSessionViewer(sessionId, undefined, registryEnv),
      ).toEqual([]);
      expect(identityIsAlive(childIdentity.pid, childIdentity.startTicks)).toBe(
        false,
      );
      expect(listProcessGroupMembers(leaderIdentity.pid)).toEqual([]);
      expect(JSON.parse(await fs.readFile(group.trace, "utf8"))).toEqual({
        pid: childIdentity.pid,
        profileExists: true,
      });
      expect(signal).toHaveBeenCalledWith(childIdentity.pid, "SIGTERM");
      expect(signal.mock.calls.some(([pid]) => pid < 0)).toBe(false);
      await expect(fs.lstat(launchRecord.profileDir)).rejects.toThrow();
    },
  );
  it.each(["remove", "prune"] as const)(
    "%s treats a reused live group leader as gone without signalling it",
    async (operation) => {
      const launchRecord = await record();
      const identity = await browser();
      Object.assign(launchRecord, {
        pid: identity.pid,
        startTicks: identity.startTicks + 1,
      });
      await writeViewerLaunchRecord(launchRecord, registryEnv);
      expect(listProcessGroupMembers(identity.pid)).toEqual([identity.pid]);
      const signal = vi.spyOn(process, "kill");
      if (operation === "remove") {
        await removeViewerLaunch(sessionId, launchRecord.launchId, registryEnv);
      } else {
        await prepareViewerLaunch(sessionId, registryEnv);
      }
      await expect(fs.lstat(launchRecord.profileDir)).rejects.toThrow();
      expect(identityIsAlive(identity.pid, identity.startTicks)).toBe(true);
      expect(signal.mock.calls.filter(([, sent]) => sent !== 0)).toEqual([]);
    },
  );
  it.each(["browser", "bridge"] as const)(
    "ignores a reused live %s leader without blocking teardown",
    async (owner) => {
      const launchRecord = await record();
      const identity = await browser();
      const stale = { pid: identity.pid, startTicks: identity.startTicks + 1 };
      if (owner === "browser") {
        Object.assign(launchRecord, stale);
        await writeViewerLaunchRecord(launchRecord, registryEnv);
      }
      const desktop =
        owner === "bridge"
          ? {
              display: ":991",
              viewerBridgePid: stale.pid,
              viewerBridgeStartTimeTicks: stale.startTicks,
            }
          : undefined;
      const signal = vi.spyOn(process, "kill");
      expect(await stopSessionViewer(sessionId, desktop, registryEnv)).toEqual(
        [],
      );
      expect(identityIsAlive(identity.pid, identity.startTicks)).toBe(true);
      expect(signal.mock.calls.filter(([, sent]) => sent !== 0)).toEqual([]);
      await expect(fs.lstat(launchRecord.profileDir)).rejects.toThrow();
    },
  );
  it.each(["browser", "bridge"] as const)(
    "never signals children of an exited reused %s leader",
    async (owner) => {
      const launchRecord = await record();
      const group = await viewerProcessGroup(
        launchRecord,
        owner === "bridge"
          ? [[`--user-data-dir=${launchRecord.profileDir}`]]
          : [[]],
      );
      const stale = {
        pid: group.leaderIdentity.pid,
        startTicks: group.leaderIdentity.startTicks + 1,
      };
      if (owner === "browser") {
        Object.assign(launchRecord, stale);
        await writeViewerLaunchRecord(launchRecord, registryEnv);
      }
      await exitGroupLeader(group.leader);
      const desktop =
        owner === "bridge"
          ? {
              display: ":991",
              viewerBridgePid: stale.pid,
              viewerBridgeStartTimeTicks: stale.startTicks,
            }
          : undefined;
      const signal = vi.spyOn(process, "kill");
      const failures = await stopSessionViewer(sessionId, desktop, registryEnv);
      expect(signal.mock.calls.filter(([, sent]) => sent !== 0)).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.message).toContain(String(group.members[0]!.pid));
      if (owner === "browser") {
        expect(failures[0]!.message).toContain(launchRecord.launchId);
        const removal = removeViewerLaunch(
          sessionId,
          launchRecord.launchId,
          registryEnv,
        );
        await expect(removal).rejects.toThrow(String(group.members[0]!.pid));
        await expect(removal).rejects.toThrow(launchRecord.launchId);
      }
      expect(
        identityIsAlive(group.members[0]!.pid, group.members[0]!.startTicks),
      ).toBe(true);
      expect(await fs.lstat(launchRecord.profileDir)).toBeDefined();
      await expect(fs.lstat(group.trace)).rejects.toThrow();
    },
  );
  it("stops an orphan with the exact Firefox profile argument", async () => {
    const launchRecord = await record();
    const group = await viewerProcessGroup(launchRecord, [
      ["--profile", launchRecord.profileDir],
    ]);
    Object.assign(launchRecord, group.leaderIdentity);
    await writeViewerLaunchRecord(launchRecord, registryEnv);
    await exitGroupLeader(group.leader);
    expect(await stopSessionViewer(sessionId, undefined, registryEnv)).toEqual(
      [],
    );
    expect(
      identityIsAlive(group.members[0]!.pid, group.members[0]!.startTicks),
    ).toBe(false);
    await expect(fs.lstat(launchRecord.profileDir)).rejects.toThrow();
  });
  it("uses a matching live leader as evidence to stop its group", async () => {
    const launchRecord = await record();
    const group = await viewerProcessGroup(launchRecord, [[]]);
    Object.assign(launchRecord, group.leaderIdentity);
    await writeViewerLaunchRecord(launchRecord, registryEnv);
    const signal = vi.spyOn(process, "kill");
    expect(await stopSessionViewer(sessionId, undefined, registryEnv)).toEqual(
      [],
    );
    expect(signal).toHaveBeenCalledWith(-group.leaderIdentity.pid, "SIGTERM");
    expect(
      identityIsAlive(group.members[0]!.pid, group.members[0]!.startTicks),
    ).toBe(false);
    await expect(fs.lstat(launchRecord.profileDir)).rejects.toThrow();
  });
  it("waits for an unverified orphan to exit without signalling it", async () => {
    const launchRecord = await record();
    const exitFile = path.join(testRoot, "orphan-exit");
    const group = await viewerProcessGroup(
      launchRecord,
      [[]],
      "term",
      exitFile,
    );
    Object.assign(launchRecord, group.leaderIdentity);
    await writeViewerLaunchRecord(launchRecord, registryEnv);
    await exitGroupLeader(group.leader);
    expect(
      identityIsAlive(group.members[0]!.pid, group.members[0]!.startTicks),
    ).toBe(true);
    const signal = vi.spyOn(process, "kill");
    const timer = setTimeout(() => {
      void fs.writeFile(exitFile, "exit");
    }, 100);
    try {
      expect(
        await stopSessionViewer(sessionId, undefined, registryEnv),
      ).toEqual([]);
    } finally {
      clearTimeout(timer);
    }
    expect(signal.mock.calls.filter(([, sent]) => sent !== 0)).toEqual([]);
    expect(
      identityIsAlive(group.members[0]!.pid, group.members[0]!.startTicks),
    ).toBe(false);
    await expect(fs.lstat(group.trace)).rejects.toThrow();
    await expect(fs.lstat(launchRecord.profileDir)).rejects.toThrow();
  });
  it("signals only profile-proven members of a mixed orphaned group", async () => {
    const launchRecord = await record();
    const group = await viewerProcessGroup(launchRecord, [
      [`--user-data-dir=${launchRecord.profileDir}`],
      [`--user-data-dir=${launchRecord.profileDir}-other`],
      [`--user-data-dir=${launchRecord.profileDir}/child`],
    ]);
    Object.assign(launchRecord, group.leaderIdentity);
    await writeViewerLaunchRecord(launchRecord, registryEnv);
    await exitGroupLeader(group.leader);
    const signal = vi.spyOn(process, "kill");
    const failures = await stopSessionViewer(sessionId, undefined, registryEnv);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain(launchRecord.launchId);
    expect(
      identityIsAlive(group.members[0]!.pid, group.members[0]!.startTicks),
    ).toBe(false);
    for (const member of group.members.slice(1)) {
      expect(identityIsAlive(member.pid, member.startTicks)).toBe(true);
      expect(failures[0]!.message).toContain(String(member.pid));
      expect(signal.mock.calls.some(([pid]) => pid === member.pid)).toBe(false);
    }
    expect(signal.mock.calls.some(([pid]) => pid < 0)).toBe(false);
    expect(await fs.lstat(launchRecord.profileDir)).toBeDefined();
    expect(JSON.parse(await fs.readFile(group.trace, "utf8"))).toEqual({
      pid: group.members[0]!.pid,
      profileExists: true,
    });
  });
  it.each(["desktop", "browser"] as const)(
    "stops owned viewers and bridge during %s teardown",
    async (type) => {
      if (type === "browser") {
        sessionId = (
          await createSession(
            {
              type,
              status: "running",
              projectDir: testRoot,
              desktop: { display: ":991" },
            },
            registryEnv,
          )
        ).id;
      }
      const launchRecord = await record();
      Object.assign(launchRecord, await browser());
      await writeViewerLaunchRecord(launchRecord, registryEnv);
      const bridge = await browser();
      const trace = path.join(testRoot, "vnc-order.json");
      const vncChild = spawn(
        process.execPath,
        [
          "-e",
          `
const fileSystem = require('node:fs');
const isAlive = (pid) => {
  try {
    const stat = fileSystem.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 1).trim()[0];
    return state !== 'Z';
  } catch {
    return false;
  }
};
process.on('SIGTERM', () => {
  fileSystem.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({
    browser: isAlive(${launchRecord.pid}),
    bridge: isAlive(${bridge.pid}),
  }));
  process.exit(0);
});
process.stdout.write('ready');
setInterval(() => {}, 1000);
`,
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      children.push(vncChild);
      await once(vncChild.stdout!, "data");
      const vncIdentity = readProcessIdentity(vncChild.pid!)!;
      await updateSession(
        sessionId,
        {
          desktop: {
            display: ":991",
            vncPid: vncIdentity.pid,
            vncStartTimeTicks: vncIdentity.startTicks,
            viewerBridgePid: bridge.pid,
            viewerBridgeStartTimeTicks: bridge.startTicks,
            viewerBridgePort: 12345,
          },
        },
        registryEnv,
      );
      const finalize = vi.fn(async () => {});
      if (type === "desktop") {
        await teardownDesktopSession(sessionId, registryEnv, finalize);
      } else {
        await teardownBrowserSession(sessionId, registryEnv, finalize);
      }
      expect(identityIsAlive(launchRecord.pid!, launchRecord.startTicks)).toBe(
        false,
      );
      expect(identityIsAlive(bridge.pid, bridge.startTicks)).toBe(false);
      expect(JSON.parse(await fs.readFile(trace, "utf8"))).toEqual({
        browser: false,
        bridge: false,
      });
      await expect(
        fs.lstat(sessionViewerDir(sessionId, registryEnv)),
      ).rejects.toThrow();
      expect(finalize).toHaveBeenCalledOnce();
    },
  );
  it("leaves sessions without viewers alone and refuses unknown live identities", async () => {
    expect(await stopSessionViewer(sessionId, undefined, registryEnv)).toEqual(
      [],
    );
    const launchRecord = await record();
    const live = await browser();
    launchRecord.pid = live.pid;
    await writeViewerLaunchRecord(launchRecord, registryEnv);
    expect(
      await stopSessionViewer(sessionId, undefined, registryEnv),
    ).toHaveLength(1);
    expect(identityIsAlive(live.pid, live.startTicks)).toBe(true);
    expect(await fs.lstat(launchRecord.profileDir)).toBeDefined();
    launchRecord.startTicks = live.startTicks + 1;
    await writeViewerLaunchRecord(launchRecord, registryEnv);
    expect(await stopSessionViewer(sessionId, undefined, registryEnv)).toEqual(
      [],
    );
    expect(identityIsAlive(live.pid, live.startTicks)).toBe(true);
    await expect(fs.lstat(launchRecord.profileDir)).rejects.toThrow();
  });
  it.each(["desktop", "browser"] as const)(
    "aggregates viewer cleanup failure during %s teardown",
    async (type) => {
      if (type === "browser") {
        sessionId = (
          await createSession(
            {
              type,
              status: "running",
              projectDir: testRoot,
              desktop: { display: ":991" },
            },
            registryEnv,
          )
        ).id;
      }
      const launchRecord = await record();
      launchRecord.pid = (await browser()).pid;
      await writeViewerLaunchRecord(launchRecord, registryEnv);
      const finalize = vi.fn(async () => {});
      const teardown =
        type === "browser" ? teardownBrowserSession : teardownDesktopSession;
      await expect(
        teardown(sessionId, registryEnv, finalize),
      ).rejects.toThrow();
      expect(finalize).not.toHaveBeenCalled();
      expect((await getSession(sessionId, registryEnv))?.status).toBe("error");
      expect(await fs.lstat(launchRecord.profileDir)).toBeDefined();
    },
  );
});
