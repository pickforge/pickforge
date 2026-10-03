import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, getSession, updateSession, readProcessIdentity, identityIsAlive } from "@pickforge/lab-core";
import {
  prepareViewerLaunch, writeViewerLaunchRecord, readViewerLaunchRecord, removeViewerLaunch,
  sessionViewerDir, stopSessionViewer, connectSessionVncReadOnly, withViewerDir,
  readViewerPrivateFile, writeViewerPrivateFile, type ViewerLaunchRecord,
} from "../src/viewer-state.js";
import { withSessionVncLock, teardownDesktopSession } from "../src/session.js";
import { teardownBrowserSession } from "../../browser/src/session.js";

let root: string;
let env: NodeJS.ProcessEnv;
let id: string;
const children: ChildProcess[] = [];
const servers: net.Server[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(process.cwd(), ".viewer-state-test-"));
  env = { ...process.env, PICKFORGE_HOME: root };
  id = (await createSession({ type: "desktop", status: "running", projectDir: root, desktop: { display: ":991" } }, env)).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) { child.kill("SIGKILL"); if (child.exitCode === null && child.signalCode === null) await once(child, "exit"); }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

async function browser(): Promise<{ pid: number; startTicks: number }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  children.push(child); await once(child, "spawn");
  return readProcessIdentity(child.pid!)!;
}
async function record(): Promise<ViewerLaunchRecord> {
  const launch = await prepareViewerLaunch(id, env);
  return { launchId: launch.launchId, sessionId: id, createdAt: new Date().toISOString(),
    browser: { kind: "chromium", binary: process.execPath }, profileDir: launch.profileDir,
    thumbnail: { width: 320, height: 200 }, expanded: { width: 1280, height: 800 } };
}
async function vnc(): Promise<number> {
  const server = net.createServer(socket => { socket.on("error", () => {}); socket.end("RFB"); });
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  const identity = await browser();
  await updateSession(id, { desktop: { display: ":991", vncPid: identity.pid,
    vncStartTimeTicks: identity.startTicks, vncPort: port, vncViewOnly: true } }, env);
  return port;
}

describe("private viewer state", () => {
  it("creates random private profiles and atomic private records", async () => {
    const r = await record();
    expect(r.launchId).toMatch(/^[0-9a-f]{32}$/);
    for (const dir of [sessionViewerDir(id, env), path.dirname(path.dirname(r.profileDir)), path.dirname(r.profileDir), r.profileDir]) {
      const stat = await fs.lstat(dir); expect(stat.mode & 0o777).toBe(0o700); expect(stat.uid).toBe(process.getuid?.());
    }
    await writeViewerLaunchRecord(r, env);
    await writeViewerLaunchRecord({ ...r, expanded: { width: 900, height: 600 } }, env);
    expect((await readViewerLaunchRecord(id, r.launchId, env))?.expanded.width).toBe(900);
    expect((await fs.stat(path.join(path.dirname(r.profileDir), "launch.json"))).mode & 0o777).toBe(0o600);
    await removeViewerLaunch(id, r.launchId, env);
    expect(await readViewerLaunchRecord(id, r.launchId, env)).toBeUndefined();
    expect(() => sessionViewerDir("../../escape", env)).toThrow();
    await expect(connectSessionVncReadOnly("../escape", env)).rejects.toThrow("Invalid session id");
    expect(await readViewerLaunchRecord(id, "../escape", env)).toBeUndefined();
  });

  it.each([
    { launchId: "bad" }, { sessionId: "desk-abcdef" }, { thumbnail: { width: 0, height: 1 } },
    { expanded: { width: 2.5, height: -1 } }, { pid: -1 }, { startTicks: 1 },
    { browser: { kind: "other", binary: "/bin/browser" } }, { profileDir: "/tmp/foreign" }, { createdAt: "bad" },
    { hyprland: { hyprctl: "relative", instance: "ok" } },
  ])("rejects an invalid launch record %j", async patch => {
    const r = await record();
    await expect(writeViewerLaunchRecord({ ...r, ...patch } as ViewerLaunchRecord, env)).rejects.toThrow();
    await fs.writeFile(path.join(path.dirname(r.profileDir), "launch.json"), JSON.stringify({ ...r, ...patch }), { mode: 0o600 });
    expect(await readViewerLaunchRecord(id, r.launchId, env)).toBeUndefined();
  });

  it.each(["bad-instance!", "../escape", "null", ""])('rejects invalid compositor instance "%s"', async instance => {
    const r = await record();
    r.hyprland = { hyprctl: "/bin/hyprctl", instance, xdgRuntimeDir: "/run/user/1000", ruleName: `pickforge-viewer-${r.launchId}`, classPattern: "^viewer$" };
    if (instance === "null") r.hyprland.classPattern = "x\nx";
    await expect(writeViewerLaunchRecord(r, env)).rejects.toThrow();
  });

  it("validates rule name, class length and valid Hyprland metadata", async () => {
    const r = await record();
    r.hyprland = { hyprctl: "/bin/hyprctl", instance: "safe_1", xdgRuntimeDir: "/run/user/1000", ruleName: `pickforge-viewer-${r.launchId}`, classPattern: "^viewer$" };
    await writeViewerLaunchRecord(r, env); expect(await readViewerLaunchRecord(id, r.launchId, env)).toEqual(r);
    for (const h of [{ ...r.hyprland, ruleName: "foreign" }, { ...r.hyprland, classPattern: "x".repeat(513) }]) {
      await expect(writeViewerLaunchRecord({ ...r, hyprland: h }, env)).rejects.toThrow();
    }
  });

  it("refuses viewer, profile and record symlinks", async () => {
    const r = await record();
    const target = path.join(root, "target"); await fs.mkdir(target, { mode: 0o700 });
    await fs.rm(r.profileDir, { recursive: true }); await fs.symlink(target, r.profileDir);
    await expect(writeViewerLaunchRecord(r, env)).rejects.toThrow();
    expect(await readViewerLaunchRecord(id, r.launchId, env)).toBeUndefined();
    const launches = path.dirname(path.dirname(r.profileDir));
    const second = await record();
    const json = path.join(path.dirname(second.profileDir), "launch.json");
    await fs.symlink(path.join(root, "sentinel"), json);
    await expect(writeViewerLaunchRecord(second, env)).rejects.toThrow();
    expect(await readViewerLaunchRecord(id, second.launchId, env)).toBeUndefined();
    await fs.rm(launches, { recursive: true });
    await fs.rm(sessionViewerDir(id, env), { recursive: true });
    await fs.symlink(target, sessionViewerDir(id, env));
    await expect(prepareViewerLaunch(id, env)).rejects.toThrow();
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("rejects unsafe modes, wrong owners and private file symlinks", async () => {
    await prepareViewerLaunch(id, env);
    await fs.chmod(sessionViewerDir(id, env), 0o755);
    await expect(prepareViewerLaunch(id, env)).rejects.toThrow();
    await fs.chmod(sessionViewerDir(id, env), 0o700);
    const uid = process.getuid!(); vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    await expect(prepareViewerLaunch(id, env)).rejects.toThrow(); vi.restoreAllMocks();
    await withViewerDir(id, env, false, async dir => {
      await writeViewerPrivateFile(dir, "token", "secret");
      expect(await readViewerPrivateFile(dir, "token")).toBe("secret");
      await fs.chmod(dir.resolve("token"), 0o644);
      await expect(readViewerPrivateFile(dir, "token")).rejects.toThrow();
      await expect(writeViewerPrivateFile(dir, "token", "new")).rejects.toThrow();
      await dir.unlinkChild("token"); await fs.symlink(path.join(root, "foreign"), dir.resolve("token"));
      await expect(readViewerPrivateFile(dir, "token")).rejects.toThrow();
      await expect(writeViewerPrivateFile(dir, "token", "new")).rejects.toThrow();
    });
  });

  it("prunes dead browsers and stale launches but retains live and recent launches", async () => {
    const live = await record(); Object.assign(live, await browser()); await writeViewerLaunchRecord(live, env);
    const dead = await record(); dead.pid = 99999999; dead.startTicks = 1; await writeViewerLaunchRecord(dead, env);
    const stale = await record(); stale.createdAt = new Date(Date.now() - 700_000).toISOString(); await writeViewerLaunchRecord(stale, env);
    const bare = await prepareViewerLaunch(id, env); const old = new Date(Date.now() - 700_000); await fs.utimes(bare.launchDir, old, old);
    const recent = await record(); await writeViewerLaunchRecord(recent, env);
    await prepareViewerLaunch(id, env);
    expect(await readViewerLaunchRecord(id, dead.launchId, env)).toBeUndefined();
    expect(await readViewerLaunchRecord(id, stale.launchId, env)).toBeUndefined();
    await expect(fs.lstat(bare.launchDir)).rejects.toThrow();
    expect(await readViewerLaunchRecord(id, live.launchId, env)).toEqual(live);
    expect(await readViewerLaunchRecord(id, recent.launchId, env)).toEqual(recent);
    await expect(removeViewerLaunch(id, live.launchId, env)).rejects.toThrow(/alive/);
  });
});

describe("read-only VNC connection", () => {
  it("connects to the recorded loopback endpoint and excludes takeover until connected", async () => {
    const port = await vnc();
    let release!: () => void;
    const held = withSessionVncLock(id, env, () => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    let done = false;
    const connecting = connectSessionVncReadOnly(id, env).then(socket => { done = true; return socket; });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(done).toBe(false);
    release(); await held;
    const socket = await connecting; expect(socket.remoteAddress).toBe("127.0.0.1"); expect(socket.remotePort).toBe(port); socket.destroy();
  });
  it("holds the VNC lock from the record check until TCP connect completes", async () => {
    const port = await vnc();
    const socket = new net.Socket();
    const connect = vi.spyOn(net, "connect").mockReturnValue(socket);
    const connecting = connectSessionVncReadOnly(id, env);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith({ host: "127.0.0.1", port }));
    let swapped = false;
    const takeover = withSessionVncLock(id, env, async () => { swapped = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(swapped).toBe(false);
    socket.emit("connect"); expect(await connecting).toBe(socket); await takeover; expect(swapped).toBe(true);
    socket.destroy();
  });
  it("bounds a stalled TCP connect and rejects an absent session record", async () => {
    await vnc(); const socket = new net.Socket(); vi.spyOn(net, "connect").mockReturnValue(socket);
    await expect(connectSessionVncReadOnly(id, env)).rejects.toMatchObject({ reason: "unavailable" });
    expect(socket.destroyed).toBe(true);
    await fs.unlink(path.join(root, "sessions", `${id}.json`));
    await expect(connectSessionVncReadOnly(id, env)).rejects.toMatchObject({ reason: "session-ended" });
  });
  it.each([
    [{ status: "stopped" }, "session-ended"], [{ desktop: undefined }, "unavailable"],
    [{ desktop: { display: ":991", vncPid: process.pid, vncPort: 5900, vncViewOnly: true } }, "unavailable"],
  ])("rejects unusable session %j", async (patch, reason) => {
    await updateSession(id, patch as Parameters<typeof updateSession>[1], env);
    await expect(connectSessionVncReadOnly(id, env)).rejects.toMatchObject({ reason });
  });
  it("rejects writable, reused identity, invalid port and failed connect", async () => {
    await vnc(); const d = (await getSession(id, env))!.desktop!;
    for (const [patch, reason] of [[{ vncViewOnly: false }, "writable"], [{ vncViewOnly: undefined }, "writable"],
      [{ vncStartTimeTicks: d.vncStartTimeTicks! + 1 }, "unavailable"], [{ vncPort: 65536 }, "unavailable"], [{ vncPort: 1 }, "unavailable"]] as const) {
      await updateSession(id, { desktop: { ...d, ...patch } }, env);
      await expect(connectSessionVncReadOnly(id, env)).rejects.toMatchObject({ reason });
    }
  });
});

describe("viewer teardown", () => {
  it.each(["desktop", "browser"] as const)("stops owned viewers and bridge during %s teardown", async type => {
    if (type === "browser") id = (await createSession({ type, status: "running", projectDir: root, desktop: { display: ":991" } }, env)).id;
    const r = await record(); Object.assign(r, await browser()); await writeViewerLaunchRecord(r, env);
    const bridge = await browser();
    const trace = path.join(root, "vnc-order.json");
    const vncChild = spawn(process.execPath, ["-e", `
      const fs = require('node:fs');
      const alive = pid => {
        try { const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return stat.slice(stat.lastIndexOf(')') + 1).trim()[0] !== 'Z'; }
        catch { return false; }
      };
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ browser: alive(${r.pid}), bridge: alive(${bridge.pid}) }));
        process.exit(0);
      });
      process.stdout.write('ready'); setInterval(() => {}, 1000);
    `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    children.push(vncChild); await once(vncChild.stdout!, "data");
    const vncIdentity = readProcessIdentity(vncChild.pid!)!;
    await updateSession(id, { desktop: { display: ":991", vncPid: vncIdentity.pid, vncStartTimeTicks: vncIdentity.startTicks,
      viewerBridgePid: bridge.pid, viewerBridgeStartTimeTicks: bridge.startTicks, viewerBridgePort: 12345 } }, env);
    const finalize = vi.fn(async () => {});
    if (type === "desktop") await teardownDesktopSession(id, env, finalize);
    else await teardownBrowserSession(id, env, finalize);
    expect(identityIsAlive(r.pid!, r.startTicks)).toBe(false); expect(identityIsAlive(bridge.pid, bridge.startTicks)).toBe(false);
    expect(JSON.parse(await fs.readFile(trace, "utf8"))).toEqual({ browser: false, bridge: false });
    await expect(fs.lstat(sessionViewerDir(id, env))).rejects.toThrow(); expect(finalize).toHaveBeenCalledOnce();
  });
  it("leaves sessions without viewers alone and refuses unknown live identities", async () => {
    expect(await stopSessionViewer(id, undefined, env)).toEqual([]);
    const r = await record(); const live = await browser(); r.pid = live.pid; await writeViewerLaunchRecord(r, env);
    expect(await stopSessionViewer(id, undefined, env)).toHaveLength(1);
    expect(identityIsAlive(live.pid, live.startTicks)).toBe(true);
    expect(await fs.lstat(r.profileDir)).toBeDefined();
    r.startTicks = live.startTicks + 1; await writeViewerLaunchRecord(r, env);
    expect(await stopSessionViewer(id, undefined, env)).toEqual([]);
    expect(identityIsAlive(live.pid, live.startTicks)).toBe(true);
  });
  it.each(["desktop", "browser"] as const)("aggregates viewer cleanup failure during %s teardown", async type => {
    if (type === "browser") id = (await createSession({ type, status: "running", projectDir: root, desktop: { display: ":991" } }, env)).id;
    const r = await record(); r.pid = (await browser()).pid; await writeViewerLaunchRecord(r, env);
    const finalize = vi.fn(async () => {});
    const teardown = type === "browser" ? teardownBrowserSession : teardownDesktopSession;
    await expect(teardown(id, env, finalize)).rejects.toThrow();
    expect(finalize).not.toHaveBeenCalled(); expect((await getSession(id, env))?.status).toBe("error");
    expect(await fs.lstat(r.profileDir)).toBeDefined();
  });
});
