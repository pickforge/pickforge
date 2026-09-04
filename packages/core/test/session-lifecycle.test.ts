import { describe, expect, it, vi } from "vitest";
import {
  createLocalSessions,
  destroyLocalSessions,
  localSessionStatusEntry,
  teardownLocalSession,
  type LocalSessionCreateRuntime,
  type LocalSessionDestroyRuntime,
  type LocalSessionRecipe,
  type LocalSessionStatusRuntime,
  type LocalSessionTeardownRuntime,
  type SessionRecord,
} from "../src/index.js";

const desktopHandle = {
  id: "desk-123456",
  display: ":90",
  logDir: "/logs/desktop",
  vncPort: 5900,
  vncViewOnly: true,
};
const androidHandle = {
  id: "andr-123456",
  avdName: "pickforge-lab",
  serial: "emulator-5554",
  consolePort: 5554,
  logDir: "/logs/android",
};
const browserHandle = {
  id: "brow-123456",
  display: ":200",
  cdpPort: 9222,
  profileDir: "/logs/browser/profile",
  binaryPath: "/usr/bin/chromium",
  logDir: "/logs/browser",
};

function createRuntime(
  overrides: Partial<LocalSessionCreateRuntime> = {},
): LocalSessionCreateRuntime {
  return {
    desktop: {
      create: vi.fn(async () => desktopHandle),
      destroy: vi.fn(async () => undefined),
      ...overrides.desktop,
    },
    android: {
      create: vi.fn(async () => androidHandle),
      ...overrides.android,
    },
    browser: {
      create: vi.fn(async () => browserHandle),
      ...overrides.browser,
    },
  };
}

function record(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "desk-123456",
    type: "desktop",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    projectDir: "/project",
    desktop: { display: ":90", vncPort: 5900, vncViewOnly: true },
    ...patch,
  };
}

describe("local session lifecycle", () => {
  it("validates recipes and expands desktop+android in order", async () => {
    const calls: string[] = [];
    const runtime = createRuntime({
      desktop: {
        create: vi.fn(async () => {
          calls.push("desktop");
          return desktopHandle;
        }),
        destroy: vi.fn(async () => undefined),
      },
      android: {
        create: vi.fn(async () => {
          calls.push("android");
          return androidHandle;
        }),
      },
    });

    await expect(
      createLocalSessions("cloud" as LocalSessionRecipe, runtime),
    ).rejects.toThrow("Unsupported local session recipe: cloud");
    const sessions = await createLocalSessions("desktop+android", runtime);

    expect(calls).toEqual(["desktop", "android"]);
    expect(sessions).toEqual([
      { type: "desktop", ...desktopHandle },
      { type: "android", ...androidHandle },
    ]);
  });

  it("rolls back the desktop leg when android creation fails", async () => {
    const failure = new Error("android failed");
    const destroy = vi.fn(async () => undefined);
    const runtime = createRuntime({
      desktop: {
        create: vi.fn(async () => desktopHandle),
        destroy,
      },
      android: { create: vi.fn(async () => Promise.reject(failure)) },
    });

    await expect(
      createLocalSessions("desktop+android", runtime),
    ).rejects.toBe(failure);
    expect(destroy).toHaveBeenCalledWith(desktopHandle.id);
  });

  it("honors cancellation before and between recipe legs", async () => {
    const before = new AbortController();
    before.abort();
    const untouched = createRuntime();
    await expect(
      createLocalSessions("desktop", untouched, { signal: before.signal }),
    ).rejects.toThrow("Session creation aborted by the client");
    expect(untouched.desktop.create).not.toHaveBeenCalled();
    await expect(
      createLocalSessions("browser", untouched, { signal: before.signal }),
    ).rejects.toThrow("Browser session creation aborted by the client");
    expect(untouched.browser.create).not.toHaveBeenCalled();

    const between = new AbortController();
    const destroy = vi.fn(async () => undefined);
    const runtime = createRuntime({
      desktop: {
        create: vi.fn(async () => {
          between.abort();
          return desktopHandle;
        }),
        destroy,
      },
    });
    await expect(
      createLocalSessions("desktop+android", runtime, {
        signal: between.signal,
      }),
    ).rejects.toThrow("Session creation aborted by the client");
    expect(runtime.android.create).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledWith(desktopHandle.id);
  });

  it("keeps browser display ownership in the browser leg and status", async () => {
    const create = createRuntime();
    const sessions = await createLocalSessions("browser", create);
    expect(sessions).toEqual([{ type: "browser", ...browserHandle }]);
    expect(create.desktop.create).not.toHaveBeenCalled();

    const status: LocalSessionStatusRuntime = {
      browser: {
        status: vi.fn(async () => ({
          alive: true,
          xvfbAlive: true,
          displayAlive: true,
          browserAlive: true,
        })),
      },
      desktop: {
        status: vi.fn(async () => ({
          xvfbAlive: false,
          vncAlive: true,
          displayAlive: false,
        })),
      },
      android: {
        status: vi.fn(async () => ({
          emulatorAlive: false,
          deviceState: null,
        })),
      },
    };
    const entry = await localSessionStatusEntry(
      record({
        id: browserHandle.id,
        type: "browser",
        browser: {
          browserPid: 10,
          browserStartTimeTicks: 20,
          binaryPath: browserHandle.binaryPath,
          profileMode: "ephemeral",
          profileDir: browserHandle.profileDir,
          cdpPort: browserHandle.cdpPort,
        },
        desktop: { display: browserHandle.display, vncPort: 5901 },
      }),
      status,
    );

    expect(entry.desktop).toMatchObject({
      display: browserHandle.display,
      xvfbAlive: true,
      displayAlive: true,
      vncAlive: true,
    });
    expect(entry.browser).toMatchObject({ browserAlive: true });
    expect(entry.viewer).toEqual({
      endpoint: "vnc://127.0.0.1:5901",
      ready: true,
      readOnly: false,
    });
  });

  it("aggregates dead status across desktop and android liveness", async () => {
    const status: LocalSessionStatusRuntime = {
      desktop: {
        status: vi.fn(async () => ({
          xvfbAlive: true,
          vncAlive: false,
          displayAlive: true,
        })),
      },
      browser: {
        status: vi.fn(async () => ({
          alive: false,
          xvfbAlive: false,
          displayAlive: false,
          browserAlive: false,
        })),
      },
      android: {
        status: vi.fn(async () => ({
          emulatorAlive: false,
          deviceState: "offline",
        })),
      },
    };
    const entry = await localSessionStatusEntry(
      record({
        id: "andr-123456",
        type: "android",
        desktop: undefined,
        android: { avdName: "pickforge-lab", serial: "emulator-5554" },
      }),
      status,
    );

    expect(entry.status).toBe("dead");
    expect(entry.android).toMatchObject({
      emulatorAlive: false,
      deviceState: "offline",
    });
  });

  it("combines typed desktop and android teardown before finalizing a legacy record", async () => {
    const calls: string[] = [];
    const runtime: LocalSessionTeardownRuntime = {
      desktop: {
        teardown: vi.fn(async (_id, finalize) => {
          calls.push("desktop");
          await finalize();
        }),
      },
      android: {
        teardown: vi.fn(async (_id, finalize) => {
          calls.push("android");
          await finalize();
        }),
      },
    };

    await teardownLocalSession(
      record({ id: "duo-123456", type: "desktop+android" }),
      runtime,
      async () => {
        calls.push("finalize");
      },
    );

    expect(calls).toEqual(["android", "desktop", "finalize"]);
  });

  it("dispatches typed destroy and continues after individual failures", async () => {
    const desktopDestroy = vi.fn(async () => {
      throw new Error("desktop stuck");
    });
    const browserDestroy = vi.fn(async () => undefined);
    const androidDestroy = vi.fn(async () => undefined);
    const runtime: LocalSessionDestroyRuntime = {
      desktop: { destroy: desktopDestroy },
      browser: { destroy: browserDestroy },
      android: { destroy: androidDestroy },
    };
    const result = await destroyLocalSessions(
      [
        record(),
        record({ id: "brow-123456", type: "browser" }),
        record({
          id: "andr-123456",
          type: "android",
          desktop: undefined,
          android: { avdName: "pickforge-lab" },
        }),
      ],
      runtime,
    );

    expect(result).toEqual({
      destroyed: ["brow-123456", "andr-123456"],
      errors: ["desk-123456: desktop stuck"],
    });
    expect(browserDestroy).toHaveBeenCalledWith("brow-123456");
    expect(androidDestroy).toHaveBeenCalledWith("andr-123456");
  });
});
