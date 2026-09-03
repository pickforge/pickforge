import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { scheduler } from "node:timers/promises";
import {
  createSession,
  destroySessionRecord,
  getSession,
  isPidAlive,
  readProcessIdentity,
  stopPid,
  updateSession,
} from "@pickforge/lab-core";
import {
  desktopSessionLogDir,
  destroyDesktopSession,
  ensureSessionVnc,
  getDesktopSessionStatus,
  withSessionVncLock,
  type EnsuredSessionVnc,
} from "../src/session.js";
import {
  buildVncViewerArgs,
  detectVncViewer,
  openVncViewer,
} from "../src/viewer.js";
import { startVnc } from "../src/vnc.js";

let root: string;
let binDir: string;
let home: string;
const spawnedPids: number[] = [];
let syntheticDisplayNumber: number;

function syntheticDisplay(): string {
  return `:${syntheticDisplayNumber}`;
}

function syntheticVncPort(): number {
  return 5_900 + syntheticDisplayNumber;
}

async function executable(name: string, source: string): Promise<string> {
  const file = path.join(binDir, name);
  await fs.promises.writeFile(file, `#!${process.execPath}\n${source}`, "utf8");
  await fs.promises.chmod(file, 0o755);
  return file;
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-viewer-"));
  binDir = path.join(root, "bin");
  home = path.join(root, "home");
  await fs.promises.mkdir(binDir, { recursive: true });
  const reservation = net.createServer();
  const listening = once(reservation, "listening");
  reservation.listen(0, "127.0.0.1");
  await listening;
  const address = reservation.address();
  if (address === null || typeof address === "string" || address.port <= 5_900) {
    throw new Error("could not reserve a synthetic VNC port");
  }
  syntheticDisplayNumber = address.port - 5_900;
  const closed = once(reservation, "close");
  reservation.close();
  await closed;
});

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    if (isPidAlive(pid)) await stopPid(pid, { timeoutMs: 500 }).catch(() => {});
  }
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe("VNC viewer command", () => {
  it("detects clients in preference order and builds exact argv", async () => {
    const fallback = await executable("vncviewer", "process.exit(0);\n");
    expect(detectVncViewer({ PATH: binDir })).toEqual({
      name: "vncviewer",
      binary: fallback,
    });
    const preferred = await executable("remote-viewer", "process.exit(0);\n");
    expect(detectVncViewer({ PATH: binDir })).toEqual({
      name: "remote-viewer",
      binary: preferred,
    });
    expect(buildVncViewerArgs("remote-viewer", 5992)).toEqual([
      "vnc://127.0.0.1:5992",
    ]);
    expect(buildVncViewerArgs("vncviewer", 5992)).toEqual([
      "127.0.0.1::5992",
    ]);
  });

  it("returns endpoint and install/SSH guidance without opening in headless mode", async () => {
    const marker = path.join(root, "opened");
    await executable(
      "remote-viewer",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "opened");\n`,
    );
    const result = await openVncViewer({
      port: 5992,
      env: { PATH: binDir, DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
    });
    expect(result.opened).toBe(false);
    expect(result.endpoint).toBe("vnc://127.0.0.1:5992");
    expect(result.guidance).toMatch(/Install virt-viewer or TigerVNC/);
    expect(result.guidance).toContain("ssh -N -L 5992:127.0.0.1:5992");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("passes the endpoint as one argv item with shell disabled semantics", async () => {
    const argsPath = path.join(root, "args.json");
    await executable(
      "remote-viewer",
      `require("node:fs").writeFileSync(process.env.ARGS_PATH, JSON.stringify(process.argv.slice(2)));\n`,
    );
    const result = await openVncViewer({
      port: 5993,
      env: { PATH: binDir, DISPLAY: ":0", ARGS_PATH: argsPath },
    });
    expect(result.opened).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await fs.promises.readFile(argsPath, "utf8"))).toEqual([
      "vnc://127.0.0.1:5993",
    ]);
  });

  it("returns client guidance when a graphical host has no supported viewer", async () => {
    const result = await openVncViewer({
      port: 5994,
      env: { PATH: binDir, DISPLAY: ":0" },
    });

    expect(result).toMatchObject({
      opened: false,
      endpoint: "vnc://127.0.0.1:5994",
    });
    expect(result.guidance).toContain("No supported VNC viewer was found");
  });

  it("returns after viewer spawn when exit waiting is disabled", async () => {
    await executable("remote-viewer", "process.exit(0);\n");
    const result = await openVncViewer({
      port: 5995,
      env: { PATH: binDir, DISPLAY: ":0" },
      waitForExit: false,
    });

    expect(result).toMatchObject({
      opened: true,
      endpoint: "vnc://127.0.0.1:5995",
      viewer: "remote-viewer",
    });
    expect(result.exitCode).toBeUndefined();
    expect(result.signal).toBeUndefined();
  });

  it("rejects invalid viewer ports", () => {
    expect(() => buildVncViewerArgs("remote-viewer", 0)).toThrow(/Invalid port/);
    expect(() => buildVncViewerArgs("vncviewer", 65_536)).toThrow(
      /Invalid port/,
    );
  });
});

describe("ensureSessionVnc", () => {
  it("breaks one stale lock across concurrent callers and starts read-only VNC once", async () => {
    const startsPath = path.join(root, "starts.log");
    await executable(
      "x11vnc",
      `const fs = require("node:fs");\nconst net = require("node:net");\nconst args = process.argv.slice(2);\nconst port = Number(args[args.indexOf("-rfbport") + 1]);\nfs.appendFileSync(process.env.STARTS_PATH, JSON.stringify(args) + "\\n");\nconst server = net.createServer((socket) => socket.end());\nserver.listen(port, "127.0.0.1");\nprocess.on("SIGTERM", () => server.close(() => process.exit(0)));\n`,
    );
    await executable("remote-viewer", "process.exit(0);\n");
    const registryEnv = { PICKLAB_HOME: home };
    const record = await createSession(
      {
        type: "desktop",
        projectDir: root,
        status: "running",
        desktop: { display: syntheticDisplay() },
      },
      registryEnv,
    );
    const lockPath = path.join(
      home,
      "sessions",
      `${record.id}.ensure-vnc.lock`,
    );
    await fs.promises.writeFile(
      lockPath,
      JSON.stringify({ pid: 4_194_304, token: "stale-owner" }),
    );
    await fs.promises.writeFile(
      `${lockPath}.stale-owner`,
      JSON.stringify({ pid: 4_194_304, token: "stale-owner" }),
    );

    const results = await Promise.all([
      ensureSessionVnc(record.id, {
        registryEnv,
        env: { PATH: binDir, STARTS_PATH: startsPath },
      }),
      ensureSessionVnc(record.id, {
        registryEnv,
        env: { PATH: binDir, STARTS_PATH: startsPath },
      }),
    ]);
    const first = results.find((result) => !result.reused);
    const second = results.find((result) => result.reused);
    if (first === undefined || second === undefined) {
      throw new Error("expected one VNC start and one reuse");
    }
    spawnedPids.push(first.pid);
    expect(first.port).toBe(syntheticVncPort());
    expect(second).toEqual({ ...first, reused: true });
    expect(
      (await fs.promises.readFile(startsPath, "utf8")).trim().split("\n"),
    ).toHaveLength(1);
    const stored = await getSession(record.id, registryEnv);
    expect(stored?.desktop).toMatchObject({
      vncPid: first.pid,
      vncStartTimeTicks: expect.any(Number),
      vncPort: syntheticVncPort(),
      vncViewOnly: true,
    });
    expect(fs.existsSync(lockPath)).toBe(false);

    await openVncViewer({
      port: first.port,
      env: { PATH: binDir, DISPLAY: ":0" },
    });
    expect(isPidAlive(first.pid)).toBe(true);
    expect((await getSession(record.id, registryEnv))?.status).toBe("running");

    await stopPid(first.pid, { timeoutMs: 500 });
    spawnedPids.splice(spawnedPids.indexOf(first.pid), 1);
    await destroySessionRecord(record.id, registryEnv);
  });

  it("refuses to reuse an active writable VNC server", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "require('node:net').createServer().listen(0)"],
      { stdio: "ignore" },
    );
    if (child.pid === undefined) throw new Error("helper process has no pid");
    spawnedPids.push(child.pid);
    const childIdentity = readProcessIdentity(child.pid);
    if (childIdentity === undefined) {
      throw new Error("helper process identity missing");
    }
    const registryEnv = { PICKLAB_HOME: home };
    const record = await createSession(
      { type: "desktop", projectDir: root },
      registryEnv,
    );
    await updateSession(
      record.id,
      {
        status: "running",
        desktop: {
          display: syntheticDisplay(),
          vncPid: child.pid,
          vncStartTimeTicks: childIdentity.startTicks,
          vncPort: syntheticVncPort(),
          vncViewOnly: false,
        },
      },
      registryEnv,
    );

    await expect(
      ensureSessionVnc(record.id, { registryEnv, env: { PATH: binDir } }),
    ).rejects.toThrow(/server-enforced read-only/);
    expect(isPidAlive(child.pid)).toBe(true);
    await destroySessionRecord(record.id, registryEnv);
  });


  it("refuses missing and reused VNC process identities without signaling", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "require('node:net').createServer().listen(0)"],
      { stdio: "ignore" },
    );
    const pid = child.pid;
    if (pid === undefined) throw new Error("helper process has no pid");
    spawnedPids.push(pid);
    const identity = readProcessIdentity(pid);
    if (identity === undefined) throw new Error("helper identity missing");
    const registryEnv = { PICKLAB_HOME: home };
    const record = await createSession(
      {
        type: "desktop",
        projectDir: root,
        status: "running",
        desktop: {
          display: syntheticDisplay(),
          vncPid: pid,
          vncPort: syntheticVncPort(),
          vncViewOnly: true,
        },
      },
      registryEnv,
    );

    expect(
      (await getDesktopSessionStatus(record.id, registryEnv)).vncAlive,
    ).toBe(false);
    await expect(
      ensureSessionVnc(record.id, { registryEnv, env: { PATH: binDir } }),
    ).rejects.toThrow(/process identity is unavailable/);
    expect(isPidAlive(pid)).toBe(true);

    await updateSession(
      record.id,
      {
        desktop: {
          display: syntheticDisplay(),
          vncPid: pid,
          vncStartTimeTicks: identity.startTicks + 1,
          vncPort: syntheticVncPort(),
          vncViewOnly: true,
        },
      },
      registryEnv,
    );
    expect(
      (await getDesktopSessionStatus(record.id, registryEnv)).vncAlive,
    ).toBe(false);
    await expect(
      ensureSessionVnc(record.id, { registryEnv, env: { PATH: binDir } }),
    ).rejects.toThrow(/process identity does not match/);
    expect(isPidAlive(pid)).toBe(true);
    const destroyError = await destroyDesktopSession(
      record.id,
      registryEnv,
    ).catch((error: unknown) => error);
    if (!(destroyError instanceof AggregateError)) {
      throw new Error("expected aggregate destroy failure");
    }
    expect(destroyError.errors.map((error) => String(error))).toEqual(
      expect.arrayContaining([expect.stringMatching(/identity does not match/)]),
    );
    expect(isPidAlive(pid)).toBe(true);
    await destroySessionRecord(record.id, registryEnv);
  });

  it("refuses to record VNC when another process owns the endpoint", async () => {
    const server = net.createServer((socket) => socket.end());
    const listening = once(server, "listening");
    server.listen(syntheticVncPort(), "127.0.0.1");
    await listening;
    await executable("x11vnc", "process.exit(99);\n");
    const registryEnv = { PICKLAB_HOME: home };
    const record = await createSession(
      {
        type: "desktop",
        projectDir: root,
        status: "running",
        desktop: { display: syntheticDisplay() },
      },
      registryEnv,
    );

    await expect(
      ensureSessionVnc(record.id, { registryEnv, env: { PATH: binDir } }),
    ).rejects.toThrow(/already in use; refusing to claim ownership/);
    expect((await getSession(record.id, registryEnv))?.desktop).toEqual({
      display: syntheticDisplay(),
    });

    const closed = once(server, "close");
    server.close();
    await closed;
    await destroySessionRecord(record.id, registryEnv);
  });

  it("does not start VNC after a destroy mutation owns the session lock", async () => {
    const marker = path.join(root, "unexpected-vnc-start");
    await executable(
      "x11vnc",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");\nprocess.exit(1);\n`,
    );
    const registryEnv = { PICKLAB_HOME: home };
    const record = await createSession(
      {
        type: "desktop",
        projectDir: root,
        status: "running",
        desktop: { display: syntheticDisplay() },
      },
      registryEnv,
    );
    let pendingEnsure: Promise<EnsuredSessionVnc> | undefined;

    await withSessionVncLock(record.id, registryEnv, async () => {
      pendingEnsure = ensureSessionVnc(record.id, {
        registryEnv,
        env: { PATH: binDir },
      });
      await scheduler.yield();
      await scheduler.yield();
      await fs.promises.rm(desktopSessionLogDir(record.id, registryEnv), {
        recursive: true,
        force: true,
      });
      await destroySessionRecord(record.id, registryEnv);
    });

    if (pendingEnsure === undefined) throw new Error("ensure was not started");
    await expect(pendingEnsure).rejects.toThrow(/Session not found/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(await getSession(record.id, registryEnv)).toBeUndefined();
  });

  it("lets a queued destroy stop VNC created by the lock owner", async () => {
    await executable(
      "x11vnc",
      `const net = require("node:net");\nconst args = process.argv.slice(2);\nconst port = Number(args[args.indexOf("-rfbport") + 1]);\nconst server = net.createServer((socket) => socket.end());\nserver.listen(port, "127.0.0.1");\nprocess.on("SIGTERM", () => server.close(() => process.exit(0)));\n`,
    );
    const registryEnv = { PICKLAB_HOME: home };
    const record = await createSession(
      {
        type: "desktop",
        projectDir: root,
        status: "running",
        desktop: { display: syntheticDisplay() },
      },
      registryEnv,
    );
    let pendingDestroy: Promise<void> | undefined;
    let vncPid: number | undefined;

    await withSessionVncLock(record.id, registryEnv, async () => {
      const vnc = await startVnc({
        display: syntheticDisplay(),
        logDir: desktopSessionLogDir(record.id, registryEnv),
        env: { PATH: binDir },
        viewOnly: true,
      });
      vncPid = vnc.pid;
      spawnedPids.push(vnc.pid);
      await updateSession(
        record.id,
        {
          desktop: {
            display: syntheticDisplay(),
            vncPid: vnc.pid,
            vncStartTimeTicks: vnc.startTimeTicks,
            vncPort: vnc.port,
            vncViewOnly: true,
          },
        },
        registryEnv,
      );
      pendingDestroy = destroyDesktopSession(record.id, registryEnv);
      await scheduler.yield();
      await scheduler.yield();
    });

    if (pendingDestroy === undefined || vncPid === undefined) {
      throw new Error("destroy race was not started");
    }
    await pendingDestroy;
    expect(isPidAlive(vncPid)).toBe(false);
    spawnedPids.splice(spawnedPids.indexOf(vncPid), 1);
    expect(await getSession(record.id, registryEnv)).toBeUndefined();
  });
});
