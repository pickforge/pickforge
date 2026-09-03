import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { teardownAndroidSession } from "../../android/src/session.js";
import { teardownBrowserSession } from "../../browser/src/session.js";
import { teardownDesktopSession } from "../../desktop-linux/src/session.js";
import { isPidAlive, readProcessIdentity, stopPid } from "../src/proc.js";
import {
  activePointerPath,
  appendAction,
  beginEvidenceRun,
  readActions,
} from "../src/evidence.js";
import {
  createSession,
  destroySessionRecord,
  getSession,
  isSessionProcessAlive,
  listSessions,
  updateSession,
  type SessionLivenessCheck,
} from "../src/session.js";
import { reapDeadRunningSessions as reapWithTypedRuntime } from "../src/session-lifecycle.js";

let home: string;
let env: { PICKFORGE_HOME: string };

function reapDeadRunningSessions(
  registryEnv: { PICKFORGE_HOME: string },
  isAlive?: SessionLivenessCheck,
) {
  return reapWithTypedRuntime(
    registryEnv,
    {
      desktop: {
        teardown: (id, finalize) =>
          teardownDesktopSession(id, registryEnv, finalize),
      },
      android: {
        teardown: (id, finalize) =>
          teardownAndroidSession(id, registryEnv, {}, finalize),
      },
      browser: {
        teardown: (id, finalize) =>
          teardownBrowserSession(id, registryEnv, finalize),
      },
    },
    isAlive,
  );
}

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-sess-"));
  env = { PICKFORGE_HOME: home };
});

afterEach(async () => {
  await fs.promises.rm(home, { recursive: true, force: true });
});

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

describe("session registry", () => {
  it("creates a session record on disk with a typed id", async () => {
    const session = await createSession(
      { type: "desktop", projectDir: "/proj" },
      env,
    );
    expect(session.id).toMatch(/^desk-[0-9a-f]{8}$/);
    expect(session.status).toBe("starting");
    expect(session.projectDir).toBe("/proj");
    expect(
      fs.existsSync(path.join(home, "sessions", `${session.id}.json`)),
    ).toBe(true);
  });

  it("creates a browser session with the brow prefix and persists both legs", async () => {
    const created = await createSession(
      {
        type: "browser",
        projectDir: "/proj",
        status: "running",
        desktop: { display: ":120", xvfbPid: 4242, width: 1280, height: 800 },
        browser: {
          browserPid: 4243,
          browserStartTimeTicks: 987654,
          binaryPath: "/usr/bin/chromium",
          profileMode: "ephemeral",
          profileDir: "/tmp/pickforge-lab-profile",
          cdpPort: 45123,
        },
      },
      env,
    );
    expect(created.id).toMatch(/^brow-[0-9a-f]{8}$/);
    const loaded = await getSession(created.id, env);
    expect(loaded).toEqual(created);
    expect(loaded?.browser?.profileMode).toBe("ephemeral");
    expect(loaded?.browser?.cdpPort).toBe(45123);
    expect(loaded?.desktop?.width).toBe(1280);
    expect(loaded?.desktop?.height).toBe(800);
  });

  it("persists desktop width and height while staying compatible without them", async () => {
    const withGeometry = await createSession(
      {
        type: "desktop",
        projectDir: "/proj",
        status: "running",
        desktop: { display: ":99", xvfbPid: 1, width: 1600, height: 900 },
      },
      env,
    );
    const loadedGeometry = await getSession(withGeometry.id, env);
    expect(loadedGeometry?.desktop?.width).toBe(1600);
    expect(loadedGeometry?.desktop?.height).toBe(900);

    const legacy = await createSession(
      {
        type: "desktop",
        projectDir: "/proj",
        status: "running",
        desktop: { display: ":98", xvfbPid: 2 },
      },
      env,
    );
    const loadedLegacy = await getSession(legacy.id, env);
    expect(loadedLegacy?.desktop?.width).toBeUndefined();
    expect(loadedLegacy?.desktop?.height).toBeUndefined();
  });

  it("round-trips through getSession", async () => {
    const created = await createSession(
      {
        type: "android",
        projectDir: "/proj",
        android: { avdName: "pickforge-avd", consolePort: 5554 },
      },
      env,
    );
    const loaded = await getSession(created.id, env);
    expect(loaded).toEqual(created);
  });

  it("lists all sessions", async () => {
    const a = await createSession({ type: "desktop", projectDir: "/a" }, env);
    const b = await createSession(
      { type: "desktop+android", projectDir: "/b" },
      env,
    );
    const sessions = await listSessions(env);
    expect(sessions.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("updates a session with a patch", async () => {
    const created = await createSession(
      { type: "desktop", projectDir: "/proj" },
      env,
    );
    const updated = await updateSession(
      created.id,
      { status: "running", desktop: { display: ":99", xvfbPid: 1234 } },
      env,
    );
    expect(updated.status).toBe("running");
    expect(updated.desktop?.display).toBe(":99");
    const reloaded = await getSession(created.id, env);
    expect(reloaded?.status).toBe("running");
  });

  it("destroys session records", async () => {
    const created = await createSession(
      { type: "desktop", projectDir: "/proj" },
      env,
    );
    await destroySessionRecord(created.id, env);
    expect(await getSession(created.id, env)).toBeUndefined();
    expect(await listSessions(env)).toEqual([]);
  });

  it("returns undefined for unknown sessions", async () => {
    expect(await getSession("desk-ffffff", env)).toBeUndefined();
  });

  it("rejects path-traversal session ids", async () => {
    const victim = path.join(home, "victim.json");
    await fs.promises.writeFile(victim, "{}", "utf8");

    expect(await getSession("../victim", env)).toBeUndefined();
    expect(await getSession("../runs/x/manifest", env)).toBeUndefined();
    await expect(destroySessionRecord("../victim", env)).rejects.toThrow(
      /session id/i,
    );
    await expect(
      updateSession("../victim", { status: "stopped" }, env),
    ).rejects.toThrow(/session id/i);

    expect(fs.existsSync(victim)).toBe(true);
  });

  it("skips corrupt session files in listSessions", async () => {
    const good = await createSession({ type: "desktop", projectDir: "/p" }, env);
    await fs.promises.writeFile(
      path.join(home, "sessions", "andr-deadbeef.json"),
      "{ not json",
      "utf8",
    );
    const sessions = await listSessions(env);
    expect(sessions.map((s) => s.id)).toEqual([good.id]);
  });

  it("getSession throws with the file path for corrupt records", async () => {
    const file = path.join(home, "sessions", "andr-deadbeef.json");
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, "{ not json", "utf8");
    await expect(getSession("andr-deadbeef", env)).rejects.toThrow(file);
  });

  it("updateSession cannot change id, type, or createdAt", async () => {
    const created = await createSession(
      { type: "desktop", projectDir: "/proj" },
      env,
    );
    const updated = await updateSession(
      created.id,
      {
        status: "running",
        ...({ id: "desk-ffffffff", type: "android", createdAt: "1999" } as object),
      },
      env,
    );
    expect(updated.id).toBe(created.id);
    expect(updated.type).toBe("desktop");
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("reaps running records whose process is dead", async () => {
    const stale = await createSession(
      {
        type: "desktop",
        projectDir: "/proj",
        status: "running",
        desktop: { display: ":90", xvfbPid: 4_194_304 },
      },
      env,
    );
    const stopped = await createSession(
      {
        type: "desktop",
        projectDir: "/proj",
        status: "stopped",
        desktop: { display: ":91", xvfbPid: 4_194_305 },
      },
      env,
    );

    const reaped = await reapDeadRunningSessions(env);

    expect(reaped.map((record) => record.id)).toEqual([stale.id]);
    expect(await getSession(stale.id, env)).toBeUndefined();
    expect(await getSession(stopped.id, env)).toBeDefined();
  });

  it("finalizes active evidence through shared session destruction", async () => {
    const projectDir = path.join(home, "project");
    await fs.promises.mkdir(projectDir);
    const session = await createSession(
      { type: "desktop", projectDir, status: "running" },
      env,
    );
    const { run } = await beginEvidenceRun(projectDir, session.id, {}, env);

    await destroySessionRecord(session.id, env);

    expect(await getSession(session.id, env)).toBeUndefined();
    expect(
      JSON.parse(
        await fs.promises.readFile(
          path.join(run.dir, "manifest.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ status: "completed" });
    expect(await fs.promises.readFile(path.join(run.dir, "report.html"), "utf8"))
      .toContain("completed");
    expect(fs.existsSync(await activePointerPath(projectDir, session.id, env))).toBe(
      false,
    );
  });

  it("finalizes active evidence when reaping a dead session", async () => {
    const projectDir = path.join(home, "project");
    await fs.promises.mkdir(projectDir);
    const stale = await createSession(
      {
        type: "desktop",
        projectDir,
        status: "running",
        desktop: { display: ":92", xvfbPid: 4_194_306 },
      },
      env,
    );
    const { run } = await beginEvidenceRun(projectDir, stale.id, {}, env);
    await appendAction(run.dir, {
      actionId: "before-reap",
      source: "mcp",
      tool: "desktop_click",
      sessionId: stale.id,
      startedAt: new Date().toISOString(),
      status: "ok",
    });

    expect(
      (await reapDeadRunningSessions(env)).map((record) => record.id),
    ).toEqual([stale.id]);

    expect(
      JSON.parse(
        await fs.promises.readFile(
          path.join(run.dir, "manifest.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ status: "failed", evidenceTruncated: false });
    expect(await readActions(run.dir)).toHaveLength(1);
    expect(await fs.promises.readFile(path.join(run.dir, "report.html"), "utf8"))
      .toContain("desktop_click");
    expect(fs.existsSync(await activePointerPath(projectDir, stale.id, env))).toBe(
      false,
    );
  });

  it("stops recorded helper pids before deleting dead running records", async () => {
    const helper = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const vncPid = helper.pid;
    if (vncPid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    const vncIdentity = readProcessIdentity(vncPid);
    if (vncIdentity === undefined) {
      throw new Error("could not read VNC identity");
    }
    const stale = await createSession(
      {
        type: "desktop",
        projectDir: "/proj",
        status: "running",
        desktop: {
          display: ":90",
          xvfbPid: 4_194_304,
          vncPid,
          vncStartTimeTicks: vncIdentity.startTicks,
        },
      },
      env,
    );

    try {
      expect(isPidAlive(vncPid)).toBe(true);

      const reaped = await reapDeadRunningSessions(env);

      expect(reaped.map((record) => record.id)).toEqual([stale.id]);
      expect(await getSession(stale.id, env)).toBeUndefined();
      await waitForExit(helper);
      expect(isPidAlive(vncPid)).toBe(false);
    } finally {
      if (isPidAlive(vncPid)) {
        await stopPid(vncPid, { timeoutMs: 1000 });
        await waitForExit(helper);
      }
    }
  });

  it("keeps an errored record and does not signal a helper with missing identity", async () => {
    const helperPid = 4_194_304;
    const stale = await createSession(
      {
        type: "desktop",
        projectDir: "/proj",
        status: "running",
        desktop: { display: ":90", vncPid: helperPid },
      },
      env,
    );
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation(((_pid: number, signal?: string | number) => {
        if (signal === 0) return true;
        throw new Error(`unexpected signal ${String(signal)}`);
      }) as typeof process.kill);
    try {
      const reaped = await reapDeadRunningSessions(env, () => false);

      expect(reaped).toEqual([]);
      expect((await getSession(stale.id, env))?.status).toBe("error");
      expect(kill.mock.calls).toEqual([[helperPid, 0]]);
    } finally {
      kill.mockRestore();
    }
  });

  it("keeps an errored record and does not signal a reused VNC pid", async () => {
    const helper = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const helperPid = helper.pid;
    if (helperPid === undefined) throw new Error("helper pid missing");
    const identity = readProcessIdentity(helperPid);
    if (identity === undefined) throw new Error("helper identity missing");
    const stale = await createSession(
      {
        type: "desktop",
        projectDir: "/proj",
        status: "running",
        desktop: {
          display: ":90",
          vncPid: helperPid,
          vncStartTimeTicks: identity.startTicks + 1,
        },
      },
      env,
    );
    try {
      const reaped = await reapDeadRunningSessions(env, () => false);

      expect(reaped).toEqual([]);
      expect((await getSession(stale.id, env))?.status).toBe("error");
      expect(isPidAlive(helperPid)).toBe(true);
    } finally {
      await stopPid(helperPid, { timeoutMs: 1000 });
      await waitForExit(helper);
    }
  });

  it("uses the recorded Xvfb identity for desktop liveness when available", async () => {
    const helper = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const pid = helper.pid;
    if (pid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    try {
      const identity = readProcessIdentity(pid);
      if (identity === undefined) {
        throw new Error("could not read child identity");
      }
      const live = await createSession(
        {
          type: "desktop",
          projectDir: "/proj",
          status: "running",
          desktop: {
            display: ":119",
            xvfbPid: pid,
            xvfbStartTimeTicks: identity.startTicks,
          },
        },
        env,
      );
      expect(isSessionProcessAlive(live)).toBe(true);
      if (live.desktop === undefined) {
        throw new Error("desktop record lost its desktop leg");
      }

      const reused = await updateSession(
        live.id,
        {
          desktop: {
            ...live.desktop,
            xvfbStartTimeTicks: identity.startTicks + 1,
          },
        },
        env,
      );
      expect(isSessionProcessAlive(reused)).toBe(false);
    } finally {
      await stopPid(pid, { timeoutMs: 1000 });
      await waitForExit(helper);
    }
  });

  it("keeps a live legacy no-identity desktop running without signaling helpers", async () => {
    const xvfb = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const vnc = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    if (xvfb.pid === undefined || vnc.pid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    try {
      const legacy = await createSession(
        {
          type: "desktop",
          projectDir: "/proj",
          status: "running",
          desktop: {
            display: ":118",
            xvfbPid: xvfb.pid,
            vncPid: vnc.pid,
          },
        },
        env,
      );
      expect(isSessionProcessAlive(legacy)).toBe(true);
      expect(await reapDeadRunningSessions(env)).toEqual([]);
      expect((await getSession(legacy.id, env))?.status).toBe("running");
      expect(isPidAlive(xvfb.pid)).toBe(true);
      expect(isPidAlive(vnc.pid)).toBe(true);
    } finally {
      for (const child of [xvfb, vnc]) {
        if (child.pid !== undefined && isPidAlive(child.pid)) {
          await stopPid(child.pid, { timeoutMs: 1000 });
          await waitForExit(child);
        }
      }
    }
  });

  it("treats a browser session as alive only when the recorded start identity matches", async () => {
    const helper = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const pid = helper.pid;
    if (pid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    const displayNumber = 30_000 + (pid % 10_000);
    const display = `:${displayNumber}`;
    const displaySocket = `/tmp/.X11-unix/X${displayNumber}`;
    fs.mkdirSync(path.dirname(displaySocket), { recursive: true });
    fs.writeFileSync(displaySocket, "");
    try {
      const identity = readProcessIdentity(pid);
      if (identity === undefined) {
        throw new Error("could not read child identity");
      }
      const makeBrowser = (
        browserStartTimeTicks: number,
        xvfbPid: number = pid,
      ) =>
        createSession(
          {
            type: "browser",
            projectDir: "/proj",
            status: "running",
            desktop: {
              display,
              xvfbPid,
              xvfbStartTimeTicks: identity.startTicks,
            },
            browser: {
              browserPid: pid,
              browserStartTimeTicks,
              binaryPath: "/usr/bin/chromium",
              profileMode: "ephemeral",
              profileDir: "/tmp/pickforge-lab-profile",
              cdpPort: 1,
            },
          },
          env,
        );

      const alive = await makeBrowser(identity.startTicks);
      expect(isSessionProcessAlive(alive)).toBe(true);

      // A recorded pid whose start time no longer matches is a reused pid.
      const stale = await makeBrowser(identity.startTicks + 1);
      expect(isSessionProcessAlive(stale)).toBe(false);

      const deadDisplay = await makeBrowser(identity.startTicks, 4_194_307);
      expect(isSessionProcessAlive(deadDisplay)).toBe(false);

      fs.rmSync(displaySocket, { force: true });
      const missingDisplay = await makeBrowser(identity.startTicks);
      expect(isSessionProcessAlive(missingDisplay)).toBe(false);
    } finally {
      fs.rmSync(displaySocket, { force: true });
      if (isPidAlive(pid)) {
        await stopPid(pid, { timeoutMs: 1000 });
        await waitForExit(helper);
      }
    }
  });

  it("default reaper removes a browser session whose display socket is missing", async () => {
    const browser = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    const xvfb = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    if (browser.pid === undefined || xvfb.pid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    try {
      const browserIdentity = readProcessIdentity(browser.pid);
      const xvfbIdentity = readProcessIdentity(xvfb.pid);
      if (browserIdentity === undefined || xvfbIdentity === undefined) {
        throw new Error("could not read process identity");
      }
      const stale = await createSession(
        {
          type: "browser",
          projectDir: "/proj",
          status: "running",
          desktop: {
            display: ":39999",
            xvfbPid: xvfb.pid,
            xvfbStartTimeTicks: xvfbIdentity.startTicks,
          },
          browser: {
            browserPid: browser.pid,
            browserStartTimeTicks: browserIdentity.startTicks,
            binaryPath: "/usr/bin/chromium",
            profileMode: "ephemeral",
            profileDir: path.join(home, "sessions", "placeholder", "profile"),
          },
        },
        env,
      );
      if (stale.browser === undefined) {
        throw new Error("browser record lost its browser leg");
      }
      const sessionDir = path.join(home, "sessions", stale.id);
      const profileDir = path.join(sessionDir, "profile");
      await fs.promises.mkdir(profileDir, { recursive: true });
      await updateSession(
        stale.id,
        {
          browser: {
            ...stale.browser,
            profileDir,
          },
        },
        env,
      );

      expect(
        (await reapDeadRunningSessions(env)).map((record) => record.id),
      ).toEqual([stale.id]);
      expect(await getSession(stale.id, env)).toBeUndefined();
      expect(isPidAlive(browser.pid)).toBe(false);
      expect(isPidAlive(xvfb.pid)).toBe(false);
    } finally {
      for (const child of [browser, xvfb]) {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // group already gone
          }
        }
      }
    }
  });

  it("reaps a dead browser session and stops its recorded desktop helper", async () => {
    const helper = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { detached: true, stdio: "ignore" },
    );
    const xvfbPid = helper.pid;
    if (xvfbPid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    const xvfbIdentity = readProcessIdentity(xvfbPid);
    if (xvfbIdentity === undefined) {
      throw new Error("desktop helper identity was unavailable");
    }
    const stale = await createSession(
      {
        type: "browser",
        projectDir: "/proj",
        status: "running",
        desktop: {
          display: ":121",
          xvfbPid,
          xvfbStartTimeTicks: xvfbIdentity.startTicks,
        },
        browser: {
          browserPid: 4_194_306,
          browserStartTimeTicks: 1,
          binaryPath: "/usr/bin/chromium",
          profileMode: "ephemeral",
          profileDir: path.join(home, "sessions", "placeholder", "profile"),
          cdpPort: 1,
        },
      },
      env,
    );
    const profileDir = path.join(home, "sessions", stale.id, "profile");
    await fs.promises.mkdir(profileDir, { recursive: true });
    await updateSession(
      stale.id,
      {
        browser: {
          ...stale.browser!,
          profileDir,
        },
      },
      env,
    );

    try {
      expect(isPidAlive(xvfbPid)).toBe(true);

      const reaped = await reapDeadRunningSessions(env);

      expect(reaped.map((record) => record.id)).toEqual([stale.id]);
      expect(await getSession(stale.id, env)).toBeUndefined();
      await waitForExit(helper);
      expect(isPidAlive(xvfbPid)).toBe(false);
    } finally {
      if (isPidAlive(xvfbPid)) {
        await stopPid(xvfbPid, { timeoutMs: 1000 });
        await waitForExit(helper);
      }
    }
  });

  it("refuses to signal a reused Xvfb pid while reaping", async () => {
    const helper = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const xvfbPid = helper.pid;
    if (xvfbPid === undefined) {
      throw new Error("child process did not expose a pid");
    }
    const identity = readProcessIdentity(xvfbPid);
    if (identity === undefined) {
      throw new Error("desktop helper identity was unavailable");
    }
    const stale = await createSession(
      {
        type: "browser",
        projectDir: "/proj",
        status: "running",
        desktop: {
          display: ":124",
          xvfbPid,
          xvfbStartTimeTicks: identity.startTicks + 1,
        },
      },
      env,
    );
    try {
      expect(await reapDeadRunningSessions(env, () => false)).toEqual([]);
      expect(isPidAlive(xvfbPid)).toBe(true);
      expect((await getSession(stale.id, env))?.status).toBe("error");
    } finally {
      await stopPid(xvfbPid, { timeoutMs: 1000 });
      await waitForExit(helper);
    }
  });

  it("deletes the ephemeral profile under the session dir when reaping", async () => {
    const stale = await createSession(
      {
        type: "browser",
        projectDir: "/proj",
        status: "running",
        desktop: { display: ":122", xvfbPid: 4_194_308 },
        browser: {
          browserPid: 4_194_309,
          browserStartTimeTicks: 1,
          binaryPath: "/usr/bin/chromium",
          profileMode: "ephemeral",
          profileDir: path.join(home, "sessions", "placeholder", "profile"),
          cdpPort: 1,
        },
      },
      env,
    );
    // Point the profile at the real per-session directory and plant data in it.
    const profileDir = path.join(home, "sessions", stale.id, "profile");
    await fs.promises.mkdir(profileDir, { recursive: true });
    await fs.promises.writeFile(path.join(profileDir, "Cookies"), "secret");
    await updateSession(
      stale.id,
      {
        browser: {
          browserPid: 4_194_309,
          browserStartTimeTicks: 1,
          binaryPath: "/usr/bin/chromium",
          profileMode: "ephemeral",
          profileDir,
          cdpPort: 1,
        },
      },
      env,
    );

    const reaped = await reapDeadRunningSessions(env);

    expect(reaped.map((record) => record.id)).toEqual([stale.id]);
    expect(await getSession(stale.id, env)).toBeUndefined();
    expect(fs.existsSync(profileDir)).toBe(false);
  });

  it("preserves a retryable error record when reaper profile removal fails", async () => {
    const stale = await createSession(
      {
        type: "browser",
        projectDir: "/proj",
        status: "running",
        browser: {
          browserPid: 4_194_312,
          browserStartTimeTicks: 1,
          binaryPath: "/usr/bin/chromium",
          profileMode: "ephemeral",
          profileDir: path.join(home, "sessions", "placeholder", "profile"),
        },
      },
      env,
    );
    const sessionDir = path.join(home, "sessions", stale.id);
    const profileDir = path.join(sessionDir, "profile");
    await fs.promises.mkdir(profileDir, { recursive: true });
    await fs.promises.writeFile(path.join(profileDir, "Cookies"), "secret");
    await updateSession(
      stale.id,
      {
        browser: {
          browserPid: 4_194_312,
          browserStartTimeTicks: 1,
          binaryPath: "/usr/bin/chromium",
          profileMode: "ephemeral",
          profileDir,
        },
      },
      env,
    );

    const realRm = fs.promises.rm.bind(fs.promises);
    let failRemoval = true;
    const rm = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation(async (target, options) => {
        if (failRemoval && path.resolve(String(target)) === sessionDir) {
          const error = new Error("simulated removal failure");
          Object.assign(error, { code: "EACCES" });
          throw error;
        }
        return realRm(target, options);
      });
    try {
      expect(await reapDeadRunningSessions(env)).toEqual([]);
      const failed = await getSession(stale.id, env);
      expect(failed?.status).toBe("error");
      expect(failed?.meta?.reaperCleanupPending).toBe(true);
      expect(fs.existsSync(profileDir)).toBe(false);

      failRemoval = false;
      expect(
        (await reapDeadRunningSessions(env)).map((record) => record.id),
      ).toEqual([stale.id]);
      expect(await getSession(stale.id, env)).toBeUndefined();
      expect(fs.existsSync(profileDir)).toBe(false);
    } finally {
      rm.mockRestore();
    }
  });

  it("removes pending browser runtime without a browser leg", async () => {
    const stale = await createSession(
      {
        type: "browser",
        projectDir: "/proj",
        status: "error",
        desktop: { display: ":125", xvfbPid: 4_194_313 },
        meta: { reaperCleanupPending: true },
      },
      env,
    );
    const sessionDir = path.join(home, "sessions", stale.id);
    const runtimePaths = [
      path.join(sessionDir, "profile"),
      path.join(sessionDir, "home", ".config"),
      path.join(sessionDir, "home", ".cache"),
      path.join(sessionDir, "home", ".local", "share"),
      path.join(sessionDir, "home", ".local", "state"),
      path.join(sessionDir, "tmp"),
      path.join(sessionDir, "xdg-runtime"),
    ];
    for (const runtimePath of runtimePaths) {
      await fs.promises.mkdir(runtimePath, { recursive: true });
      await fs.promises.writeFile(path.join(runtimePath, "data"), "secret");
    }

    expect(
      (await reapDeadRunningSessions(env)).map((record) => record.id),
    ).toEqual([stale.id]);
    expect(await getSession(stale.id, env)).toBeUndefined();
    for (const runtimePath of runtimePaths) {
      expect(fs.existsSync(runtimePath)).toBe(false);
    }
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it("does not delete a profile that escapes the session dir when reaping", async () => {
    const outside = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pickforge-lab-outside-"),
    );
    try {
      const stale = await createSession(
        {
          type: "browser",
          projectDir: "/proj",
          status: "running",
          desktop: { display: ":123", xvfbPid: 4_194_310 },
          browser: {
            browserPid: 4_194_311,
            browserStartTimeTicks: 1,
            binaryPath: "/usr/bin/chromium",
            profileMode: "ephemeral",
            profileDir: outside,
            cdpPort: 1,
          },
        },
        env,
      );

      await reapDeadRunningSessions(env);

      expect((await getSession(stale.id, env))?.status).toBe("error");
      // The confinement guard must leave the record for inspection and the
      // out-of-tree path untouched.
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it("stops the browser group before VNC and Xvfb when reaping", async () => {
    const orderFile = path.join(home, "stop-order.txt");
    const stopLogger = (label: string) =>
      `const fs=require("node:fs");process.on("SIGTERM",()=>{fs.appendFileSync(${JSON.stringify(orderFile)},${JSON.stringify(`${label}\n`)});process.exit(0)});setInterval(()=>{},1000)`;
    const browser = spawn(process.execPath, ["-e", stopLogger("browser")], {
      detached: true,
      stdio: "ignore",
    });
    const vnc = spawn(process.execPath, ["-e", stopLogger("vnc")], {
      stdio: "ignore",
    });
    const xvfb = spawn(process.execPath, ["-e", stopLogger("xvfb")], {
      detached: true,
      stdio: "ignore",
    });
    if (
      browser.pid === undefined ||
      vnc.pid === undefined ||
      xvfb.pid === undefined
    ) {
      throw new Error("child process did not expose a pid");
    }
    try {
      await delay(100);
      const identity = readProcessIdentity(browser.pid);
      if (identity === undefined) {
        throw new Error("could not read browser identity");
      }
      const xvfbIdentity = readProcessIdentity(xvfb.pid);
      if (xvfbIdentity === undefined) {
        throw new Error("could not read Xvfb identity");
      }
      const vncIdentity = readProcessIdentity(vnc.pid);
      if (vncIdentity === undefined) {
        throw new Error("could not read VNC identity");
      }
      const stale = await createSession(
        {
          type: "browser",
          projectDir: "/proj",
          status: "running",
          desktop: {
            display: ":124",
            vncPid: vnc.pid,
            vncStartTimeTicks: vncIdentity.startTicks,
            xvfbPid: xvfb.pid,
            xvfbStartTimeTicks: xvfbIdentity.startTicks,
          },
          browser: {
            browserPid: identity.pid,
            browserStartTimeTicks: identity.startTicks,
            binaryPath: "/usr/bin/chromium",
            profileMode: "ephemeral",
            profileDir: path.join(home, "sessions", "placeholder", "profile"),
            cdpPort: 1,
          },
        },
        env,
      );
      const profileDir = path.join(home, "sessions", stale.id, "profile");
      await fs.promises.mkdir(profileDir, { recursive: true });
      await updateSession(
        stale.id,
        {
          browser: {
            ...stale.browser!,
            profileDir,
          },
        },
        env,
      );

      const reaped = await reapDeadRunningSessions(env, () => false);

      expect(reaped.map((record) => record.id)).toEqual([stale.id]);
      expect(fs.readFileSync(orderFile, "utf8").trim().split("\n")).toEqual([
        "browser",
        "vnc",
        "xvfb",
      ]);
    } finally {
      for (const child of [browser, vnc, xvfb]) {
        if (child.pid !== undefined && isPidAlive(child.pid)) {
          try {
            process.kill(
              child === browser || child === xvfb ? -child.pid : child.pid,
              "SIGKILL",
            );
          } catch {
            // already gone
          }
        }
      }
    }
  });

  it("leaves helpers and profile intact for an unconfirmed browser group", async () => {
    const browser = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const vnc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const xvfb = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    if (
      browser.pid === undefined ||
      vnc.pid === undefined ||
      xvfb.pid === undefined
    ) {
      throw new Error("child process did not expose a pid");
    }
    const profileDir = path.join(home, "reused-profile");
    await fs.promises.mkdir(profileDir, { recursive: true });
    await fs.promises.writeFile(path.join(profileDir, "Cookies"), "secret");
    try {
      const identity = readProcessIdentity(browser.pid);
      if (identity === undefined) {
        throw new Error("could not read browser identity");
      }
      // The numeric PID is live but the start identity is not ours. Reaping
      // must fail closed before touching any dependent desktop process.
      const stale = await createSession(
        {
          type: "browser",
          projectDir: "/proj",
          status: "running",
          desktop: {
            display: ":125",
            vncPid: vnc.pid,
            xvfbPid: xvfb.pid,
          },
          browser: {
            browserPid: browser.pid,
            browserStartTimeTicks: identity.startTicks + 1,
            binaryPath: "/usr/bin/chromium",
            profileMode: "ephemeral",
            profileDir,
            cdpPort: 1,
          },
        },
        env,
      );

      const reaped = await reapDeadRunningSessions(env);

      expect(reaped).toEqual([]);
      expect((await getSession(stale.id, env))?.status).toBe("error");
      expect(isPidAlive(browser.pid)).toBe(true);
      expect(isPidAlive(vnc.pid)).toBe(true);
      expect(isPidAlive(xvfb.pid)).toBe(true);
      expect(fs.existsSync(path.join(profileDir, "Cookies"))).toBe(true);
    } finally {
      for (const child of [browser, vnc, xvfb]) {
        if (child.pid !== undefined && isPidAlive(child.pid)) {
          await stopPid(child.pid, { timeoutMs: 1000 });
          await waitForExit(child);
        }
      }
    }
  });
});

describe("legacy session home fallback", () => {
  let fakeHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fakeHome = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pickforge-lab-legacy-fakehome-"),
    );
    homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fs.promises.rm(fakeHome, { recursive: true, force: true });
  });

  function writeLegacySession(
    id: string,
    root = path.join(fakeHome, ".picklab"),
  ): void {
    const dir = path.join(root, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        type: "desktop",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "stopped",
        projectDir: "/legacy/project",
      }),
    );
  }

  it("reads a legacy ~/.picklab session when PICKFORGE_HOME is unset", async () => {
    writeLegacySession("desk-1eaac1");

    const record = await getSession("desk-1eaac1", {});
    expect(record?.projectDir).toBe("/legacy/project");
  });

  it("reads sessions from the former ~/.pickforge/picklab state root", async () => {
    writeLegacySession(
      "desk-1eaac6",
      path.join(fakeHome, ".pickforge", "picklab"),
    );

    const record = await getSession("desk-1eaac6", {});
    expect(record?.projectDir).toBe("/legacy/project");
  });

  it("lists legacy sessions alongside new-home sessions", async () => {
    writeLegacySession("desk-1eaac2");
    const created = await createSession(
      { type: "desktop", projectDir: "/new/project" },
      {},
    );

    const ids = (await listSessions({})).map((record) => record.id).sort();
    expect(ids).toEqual(["desk-1eaac2", created.id].sort());
  });

  it("does not fall back once PICKFORGE_HOME is set explicitly", async () => {
    writeLegacySession("desk-1eaac3");

    expect(await getSession("desk-1eaac3", { PICKFORGE_HOME: "/other" })).toBeUndefined();
  });

  it("destroying a session found via the legacy fallback removes it there, not just the new home", async () => {
    writeLegacySession("desk-1eaac4");

    await destroySessionRecord("desk-1eaac4", {});

    expect(
      fs.existsSync(
        path.join(fakeHome, ".picklab", "sessions", "desk-1eaac4.json"),
      ),
    ).toBe(false);
  });

  it("destroying a session that has copies at BOTH the legacy and new home removes both, so it cannot resurrect", async () => {
    // A session created under the legacy home, later updated: writes always
    // target the new home, leaving a stale copy at the legacy path too.
    writeLegacySession("desk-1eaac5");
    await updateSession("desk-1eaac5", { status: "running" }, {});

    const legacyPath = path.join(
      fakeHome,
      ".picklab",
      "sessions",
      "desk-1eaac5.json",
    );
    const newPath = path.join(
      fakeHome,
      ".pickforge",
      "lab",
      "sessions",
      "desk-1eaac5.json",
    );
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.existsSync(newPath)).toBe(true);

    await destroySessionRecord("desk-1eaac5", {});

    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(newPath)).toBe(false);
    expect(
      (await listSessions({})).some((record) => record.id === "desk-1eaac5"),
    ).toBe(false);
    expect(await getSession("desk-1eaac5", {})).toBeUndefined();
  });
});
