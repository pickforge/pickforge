import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EndHumanTakeoverResult,
  HumanTakeoverHandle,
  OpenVncViewerResult,
} from "@pickforge/lab-desktop-linux";

const { startHumanTakeover, endHumanTakeover, renewHumanTakeover, openVncViewer } =
  vi.hoisted(() => ({
    startHumanTakeover: vi.fn(),
    endHumanTakeover: vi.fn(),
    renewHumanTakeover: vi.fn(),
    openVncViewer: vi.fn(),
  }));

vi.mock("@pickforge/lab-desktop-linux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pickforge/lab-desktop-linux")>();
  return {
    ...actual,
    startHumanTakeover,
    endHumanTakeover,
    renewHumanTakeover,
    openVncViewer,
  };
});

import { createSession } from "@pickforge/lab-core";
import { watchDesktopSession, type SpawnWatchdogFn } from "../src/commands/watch.js";

let root: string;

// Every test must inject a fake watchdog spawner: the real one re-execs
// `process.argv[1]` (the vitest worker under test) with `internal
// takeover-watchdog` argv, which is a real, unwanted side effect in tests.
let watchdogKill: ReturnType<typeof vi.fn>;
let spawnWatchdog: SpawnWatchdogFn;

function fakeHandle(overrides: Partial<HumanTakeoverHandle> = {}): HumanTakeoverHandle {
  return {
    sessionId: "desk-aaaaaa11",
    leaseId: "lease-1",
    display: ":42",
    vncPid: 4242,
    vncPort: 5942,
    vncStartTimeTicks: 1,
    ttlMs: 30_000,
    heartbeatMs: 15,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    projectDir: root,
    ...overrides,
  };
}

function fakeLease(handle: HumanTakeoverHandle, ttlMs = 30_000): { leaseId: string; expiresAt: string } {
  return { leaseId: handle.leaseId, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
}

function fakeViewer(overrides: Partial<OpenVncViewerResult> = {}): OpenVncViewerResult {
  return {
    opened: true,
    endpoint: "vnc://127.0.0.1:5942",
    viewer: "remote-viewer",
    exitCode: 0,
    signal: null,
    ...overrides,
  };
}

async function delayedResolve<T>(value: T, ms: number): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return value;
}

async function createDesktop(): Promise<string> {
  const record = await createSession(
    { type: "desktop", projectDir: root, status: "running", desktop: { display: ":42" } },
    { PICKLAB_HOME: path.join(root, "home") },
  );
  return record.id;
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-watch-control-"));
  process.env.PICKLAB_HOME = path.join(root, "home");
  startHumanTakeover.mockReset();
  endHumanTakeover.mockReset();
  renewHumanTakeover.mockReset();
  openVncViewer.mockReset();
  endHumanTakeover.mockResolvedValue({ reason: "return" } satisfies EndHumanTakeoverResult);
  renewHumanTakeover.mockImplementation(async (handle: HumanTakeoverHandle) => fakeLease(handle));
  watchdogKill = vi.fn();
  spawnWatchdog = vi.fn(() => ({ kill: watchdogKill }));
});

afterEach(async () => {
  delete process.env.PICKLAB_HOME;
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe("watch --control (mocked)", () => {
  it("rejects --control combined with waitForViewerExit: false before any side effect", async () => {
    const id = await createDesktop();
    await expect(
      watchDesktopSession({
        session: id,
        projectDir: root,
        control: true,
        waitForViewerExit: false,
        _spawnWatchdog: spawnWatchdog,
      }),
    ).rejects.toThrow(/requires waiting for the viewer to exit/);
    expect(startHumanTakeover).not.toHaveBeenCalled();
  });

  it("starts human takeover, spawns the watchdog, waits for the viewer, and ends with reason 'return'", async () => {
    const id = await createDesktop();
    const handle = fakeHandle({ sessionId: id });
    startHumanTakeover.mockResolvedValue(handle);
    openVncViewer.mockResolvedValue(fakeViewer());
    endHumanTakeover.mockResolvedValue({
      reason: "return",
      screenshotPath: "screenshots/abc.png",
    } satisfies EndHumanTakeoverResult);

    const result = await watchDesktopSession({
      session: id,
      projectDir: root,
      control: true,
      _spawnWatchdog: spawnWatchdog,
    });

    expect(startHumanTakeover).toHaveBeenCalledWith(id, { registryEnv: process.env });
    expect(spawnWatchdog).toHaveBeenCalledWith(handle);
    expect(openVncViewer).toHaveBeenCalledWith({ port: handle.vncPort, waitForExit: true });
    expect(endHumanTakeover).toHaveBeenCalledWith(handle, {
      registryEnv: process.env,
      reason: "return",
    });
    // The watchdog is stopped once control returns cleanly — it must not
    // linger polling a lease that no longer exists.
    expect(watchdogKill).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      sessionId: id,
      leaseId: handle.leaseId,
      opened: true,
      controlReason: "return",
      resumeScreenshot: "screenshots/abc.png",
    });
    expect(result.lines?.join("\n")).toContain("returned (return)");
  });

  it("ends with reason 'cancelled' when a SIGINT arrives while the viewer is open", async () => {
    const id = await createDesktop();
    const handle = fakeHandle({ sessionId: id, heartbeatMs: 10_000 });
    startHumanTakeover.mockResolvedValue(handle);
    openVncViewer.mockImplementation(() => delayedResolve(fakeViewer({ signal: "SIGTERM" }), 60));
    endHumanTakeover.mockImplementation(async (_handle, opts) => ({
      reason: opts.reason,
    }));

    const pending = watchDesktopSession({
      session: id,
      projectDir: root,
      control: true,
      _spawnWatchdog: spawnWatchdog,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.emit("SIGINT");
    const result = await pending;

    expect(endHumanTakeover).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({ reason: "cancelled" }),
    );
    expect(result.data?.controlReason).toBe("cancelled");
    expect(watchdogKill).toHaveBeenCalledTimes(1);
  });

  it("ends the takeover IMMEDIATELY on the first failed renewal, without waiting for the viewer", async () => {
    const id = await createDesktop();
    const handle = fakeHandle({ sessionId: id, heartbeatMs: 10 });
    startHumanTakeover.mockResolvedValue(handle);
    renewHumanTakeover.mockResolvedValue(undefined);
    const events: string[] = [];
    let viewerResolvedAt = Number.POSITIVE_INFINITY;
    openVncViewer.mockImplementation(async () => {
      const viewer = await delayedResolve(fakeViewer(), 100);
      viewerResolvedAt = Date.now();
      events.push("viewer-resolved");
      return viewer;
    });
    let endedAt = Number.POSITIVE_INFINITY;
    endHumanTakeover.mockImplementation(async (_handle, opts) => {
      endedAt = Date.now();
      events.push(`end:${String(opts.reason)}`);
      return { reason: opts.reason };
    });

    const started = Date.now();
    const result = await watchDesktopSession({
      session: id,
      projectDir: root,
      control: true,
      _spawnWatchdog: spawnWatchdog,
    });

    expect(renewHumanTakeover).toHaveBeenCalled();
    // The end happened well before the (100ms-delayed) viewer resolved, and
    // close to the 10ms heartbeat — proving it did not wait for the viewer.
    expect(endedAt - started).toBeLessThan(60);
    expect(endedAt).toBeLessThan(viewerResolvedAt);
    expect(events[0]).toBe("end:timeout");
    expect(result.data?.controlReason).toBe("timeout");
    expect(result.lines?.join("\n")).toContain("could not be renewed");
    expect(watchdogKill).toHaveBeenCalledTimes(1);
  });

  it("force-ends via the hard deadline timer even if the heartbeat itself never fires", async () => {
    const id = await createDesktop();
    // A heartbeat interval far longer than the test window: the deadline
    // timer, not the heartbeat, must be what ends this takeover.
    const handle = fakeHandle({
      sessionId: id,
      heartbeatMs: 60_000,
      expiresAt: new Date(Date.now() + 30).toISOString(),
    });
    startHumanTakeover.mockResolvedValue(handle);
    openVncViewer.mockImplementation(() => delayedResolve(fakeViewer(), 200));
    endHumanTakeover.mockImplementation(async (_handle, opts) => ({ reason: opts.reason }));

    const result = await watchDesktopSession({
      session: id,
      projectDir: root,
      control: true,
      _spawnWatchdog: spawnWatchdog,
    });

    expect(renewHumanTakeover).not.toHaveBeenCalled();
    expect(endHumanTakeover).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({ reason: "timeout" }),
    );
    expect(result.data?.controlReason).toBe("timeout");
  });

  it("reschedules the deadline timer to the freshly renewed expiresAt", async () => {
    const id = await createDesktop();
    // TTL of 40ms with a 10ms heartbeat: if the deadline timer were only ever
    // scheduled against the *original* expiresAt (never rescheduled), it
    // would still fire around 40ms even though renewals keep succeeding —
    // this proves the reschedule keeps the backstop from firing early.
    const handle = fakeHandle({
      sessionId: id,
      heartbeatMs: 10,
      ttlMs: 40,
      expiresAt: new Date(Date.now() + 40).toISOString(),
    });
    startHumanTakeover.mockResolvedValue(handle);
    renewHumanTakeover.mockImplementation(async () => fakeLease(handle, 40));
    openVncViewer.mockImplementation(() => delayedResolve(fakeViewer(), 90));
    endHumanTakeover.mockImplementation(async (_handle, opts) => ({ reason: opts.reason }));

    const result = await watchDesktopSession({
      session: id,
      projectDir: root,
      control: true,
      _spawnWatchdog: spawnWatchdog,
    });

    expect(result.data?.controlReason).toBe("return");
    expect(endHumanTakeover).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({ reason: "return" }),
    );
  }, 10_000);

  it("ends control immediately and reports guidance when no viewer can be opened", async () => {
    const id = await createDesktop();
    const handle = fakeHandle({ sessionId: id });
    startHumanTakeover.mockResolvedValue(handle);
    openVncViewer.mockResolvedValue(
      fakeViewer({
        opened: false,
        viewer: undefined,
        exitCode: undefined,
        signal: undefined,
        guidance: "No graphical host session is available.",
      }),
    );
    endHumanTakeover.mockResolvedValue({ reason: "return" } satisfies EndHumanTakeoverResult);

    const result = await watchDesktopSession({
      session: id,
      projectDir: root,
      control: true,
      _spawnWatchdog: spawnWatchdog,
    });

    expect(endHumanTakeover).toHaveBeenCalledWith(handle, {
      registryEnv: process.env,
      reason: "return",
    });
    expect(result.errors?.join("\n")).toContain("No writable VNC viewer could be opened");
    expect(result.errors?.join("\n")).toContain("No graphical host session is available.");
  });
});
