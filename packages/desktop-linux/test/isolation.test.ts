import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  REAPER_CLEANUP_PENDING_META_KEY,
  getSession,
  isPidAlive,
  listContainedProcesses,
  updateSession,
  type EnvLike,
} from "@pickforge/lab-core";
import {
  createDesktopSession,
  destroyDesktopSession,
  findOnPath,
  launchApp,
  desktopSessionLogDir,
  ensureDesktopSessionIsolation,
  type DesktopSessionHandle,
} from "../src/index.js";

/**
 * End-to-end isolation and containment for a real desktop session
 * (pickforge/pickforge#85, #86, #57): a daemonising app is held and killed with
 * the session, the session's runtime dir and D-Bus endpoints are its own, and
 * teardown leaves nothing behind.
 */
const hasXvfb = findOnPath("Xvfb") !== null;
const describeWithXvfb = hasXvfb ? describe : describe.skip;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-isolation-"));
const projectDir = path.join(tmpRoot, "project");
fs.mkdirSync(projectDir, { recursive: true });
const env: EnvLike = {
  ...process.env,
  PICKFORGE_HOME: path.join(tmpRoot, "state"),
};

const sessions = new Set<string>();
const strays = new Set<number>();

function writeExecutable(name: string, body: string): string {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function readPidFile(pidFile: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function createSessionHandle(): Promise<DesktopSessionHandle> {
  const handle = await createDesktopSession({
    projectDir,
    registryEnv: env,
    env,
  });
  sessions.add(handle.id);
  return handle;
}

afterEach(async () => {
  for (const id of sessions) {
    await destroyDesktopSession(id, env).catch(() => {});
  }
  sessions.clear();
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  strays.clear();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describeWithXvfb("desktop session runtime isolation", () => {
  it("gives the session its own private runtime dir and D-Bus endpoints", async () => {
    const handle = await createSessionHandle();
    const sessionDir = desktopSessionLogDir(handle.id, env);

    expect(handle.runtimeDir).toBe(path.join(sessionDir, "runtime"));
    expect(fs.statSync(handle.runtimeDir).mode & 0o777).toBe(0o700);
    expect(handle.runtimeDir).not.toBe(process.env.XDG_RUNTIME_DIR);
  }, 60_000);

  it("hands a launched app the session runtime dir, not the caller's", async () => {
    const handle = await createSessionHandle();
    const dump = path.join(tmpRoot, "app-env.txt");
    const command = writeExecutable(
      "dump-env.sh",
      `env > "${dump}"\nexec /bin/sleep 300`,
    );

    const isolation = await ensureDesktopSessionIsolation(handle.id, env);
    const app = await launchApp({
      display: handle.display,
      command,
      logDir: desktopSessionLogDir(handle.id, env),
      env,
      ...isolation,
    });
    strays.add(app.pid);
    expect(await waitUntil(() => fs.existsSync(dump))).toBe(true);

    const appEnv = new Map(
      fs
        .readFileSync(dump, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)] as const;
        }),
    );
    expect(appEnv.get("XDG_RUNTIME_DIR")).toBe(handle.runtimeDir);
    expect(appEnv.get("DBUS_SESSION_BUS_ADDRESS")).toBe(
      `unix:path=${path.join(handle.runtimeDir, "bus")}`,
    );
    expect(appEnv.get("DBUS_SYSTEM_BUS_ADDRESS")).toBe(
      `unix:path=${path.join(handle.runtimeDir, "system_bus_socket")}`,
    );
    expect(appEnv.get("DISPLAY")).toBe(handle.display);
    expect(appEnv.get("PICKFORGE_CONTAINMENT_TOKEN")).toBe(
      handle.containment.token,
    );
  }, 60_000);
});

describeWithXvfb("desktop session containment", () => {
  it("holds and kills a daemonising app that escaped its process group", async () => {
    const handle = await createSessionHandle();
    const pidFile = path.join(tmpRoot, "daemon-escapee.pid");
    const command = writeExecutable(
      "daemonise.sh",
      // Double fork + setsid: the classic GUI-app daemonisation that leaves the
      // process group Pickforge signals. The launcher then exits, exactly as a
      // real daemonising app does.
      `setsid /bin/sh -c 'echo $$ > "${pidFile}"; exec /bin/sleep 300' &\n` +
        "exit 0",
    );

    const isolation = await ensureDesktopSessionIsolation(handle.id, env);
    // The launch itself reports failure: the foreground process is gone. What
    // matters is that the descendant it left behind is still owned by us.
    await expect(
      launchApp({
        display: handle.display,
        command,
        logDir: desktopSessionLogDir(handle.id, env),
        env,
        ...isolation,
      }),
    ).rejects.toThrow(/exited immediately/);

    expect(await waitUntil(() => readPidFile(pidFile) !== undefined)).toBe(true);
    const escapee = readPidFile(pidFile) as number;
    strays.add(escapee);
    expect(isPidAlive(escapee)).toBe(true);
    expect(listContainedProcesses(handle.containment.token)).toContain(escapee);

    await destroyDesktopSession(handle.id, env);
    sessions.delete(handle.id);

    expect(isPidAlive(escapee)).toBe(false);
    expect(listContainedProcesses(handle.containment.token)).toEqual([]);
    expect(fs.existsSync(handle.runtimeDir)).toBe(false);
  }, 90_000);

  it("tells the operator the escapee is still contained, not loose", async () => {
    const handle = await createSessionHandle();
    const command = writeExecutable("exits-at-once.sh", "exit 0");
    const isolation = await ensureDesktopSessionIsolation(handle.id, env);

    await expect(
      launchApp({
        display: handle.display,
        command,
        logDir: desktopSessionLogDir(handle.id, env),
        env,
        ...isolation,
      }),
    ).rejects.toThrow(/still held by the session's (cgroup|marker) containment/);
  }, 60_000);

  it("reports the containment mechanism it actually achieved", async () => {
    const handle = await createSessionHandle();
    const isolation = await ensureDesktopSessionIsolation(handle.id, env);
    const app = await launchApp({
      display: handle.display,
      command: "/bin/sleep",
      args: ["300"],
      logDir: desktopSessionLogDir(handle.id, env),
      env,
      ...isolation,
    });
    strays.add(app.pid);

    expect(app.containment).toBe(handle.containment.mechanism);
    expect(["cgroup", "marker"]).toContain(app.containment);
  }, 60_000);

  it("stops a plain app and removes the runtime dir on destroy", async () => {
    const handle = await createSessionHandle();
    const isolation = await ensureDesktopSessionIsolation(handle.id, env);
    const app = await launchApp({
      display: handle.display,
      command: "/bin/sleep",
      args: ["300"],
      logDir: desktopSessionLogDir(handle.id, env),
      env,
      ...isolation,
    });
    strays.add(app.pid);
    expect(await waitUntil(() => isPidAlive(app.pid))).toBe(true);

    await destroyDesktopSession(handle.id, env);
    sessions.delete(handle.id);

    expect(await waitUntil(() => !isPidAlive(app.pid), 5_000)).toBe(true);
    expect(isPidAlive(handle.xvfbPid)).toBe(false);
    expect(fs.existsSync(handle.runtimeDir)).toBe(false);
  }, 90_000);

  it("never touches the caller's real runtime dir", async () => {
    const realRuntimeDir = process.env.XDG_RUNTIME_DIR;
    const handle = await createSessionHandle();
    const before =
      realRuntimeDir === undefined ? [] : fs.readdirSync(realRuntimeDir).sort();

    const isolation = await ensureDesktopSessionIsolation(handle.id, env);
    const app = await launchApp({
      display: handle.display,
      command: "/bin/sleep",
      args: ["300"],
      logDir: desktopSessionLogDir(handle.id, env),
      env,
      ...isolation,
    });
    strays.add(app.pid);
    await destroyDesktopSession(handle.id, env);
    sessions.delete(handle.id);

    if (realRuntimeDir !== undefined) {
      expect(fs.readdirSync(realRuntimeDir).sort()).toEqual(before);
    }
  }, 90_000);
});

describeWithXvfb("desktop teardown failure reporting", () => {
  it("fails loudly and keeps the runtime dir when containment is unconfirmed", async () => {
    const handle = await createSessionHandle();
    const record = await getSession(handle.id, env);
    const unkillable = fs.mkdtempSync(path.join(tmpRoot, "unkillable-cgroup-"));
    // Read-only, so `cgroup.kill` cannot be written: the cleanup cannot be
    // confirmed, and teardown must say so rather than report success.
    fs.chmodSync(unkillable, 0o500);
    await updateSession(
      handle.id,
      {
        desktop: {
          ...record?.desktop,
          display: handle.display,
          containment: {
            token: "f".repeat(64),
            mechanism: "cgroup",
            cgroupDir: unkillable,
          },
        },
      },
      env,
    );

    await expect(destroyDesktopSession(handle.id, env)).rejects.toThrow(
      /Failed to stop/,
    );
    const after = await getSession(handle.id, env);
    expect(after?.status).toBe("error");
    expect(after?.meta?.[REAPER_CLEANUP_PENDING_META_KEY]).toBe(true);
    // Nothing was deleted while processes could not be confirmed gone.
    expect(fs.existsSync(handle.runtimeDir)).toBe(true);

    fs.chmodSync(unkillable, 0o700);
    await updateSession(
      handle.id,
      { desktop: { display: handle.display, xvfbPid: handle.xvfbPid } },
      env,
    );
  }, 90_000);
});
