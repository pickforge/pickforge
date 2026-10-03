import fs from "node:fs/promises";
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

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(process.cwd(), ".viewer-state-test-"));
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

describe("viewer teardown", () => {
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
