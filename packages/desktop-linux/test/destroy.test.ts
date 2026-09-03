import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const FAILING_PID = 424_242;
const STUCK_PID = 535_353;
let allowFailingPidStop = false;

vi.mock("@pickforge/lab-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pickforge/lab-core")>();
  return {
    ...actual,
    processIdentityMatches: vi.fn(() => true),
    stopPid: vi.fn(async (pid: number) => {
      if (pid === FAILING_PID && !allowFailingPidStop) {
        throw new Error(`kill EPERM (pid ${pid})`);
      }
      if (pid === STUCK_PID) {
        return false;
      }
      return true;
    }),
    stopProcessGroupVerified: vi.fn(
      async ({ pid }: { pid: number; startTicks: number }) => {
        if (pid === FAILING_PID && !allowFailingPidStop) {
          throw new Error(`kill EPERM (pid ${pid})`);
        }
        return {
          outcome: pid === STUCK_PID ? "survived" : "terminated",
          signaled: true,
        };
      },
    ),
  };
});

import {
  REAPER_CLEANUP_PENDING_META_KEY,
  createSession,
  getSession,
  reapDeadRunningSessions,
  stopPid,
  stopProcessGroupVerified,
  updateSession,
  type EnvLike,
} from "@pickforge/lab-core";
import {
  destroyDesktopSession,
  teardownDesktopSession,
} from "../src/session.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-destroy-test-"));
const registryEnv: EnvLike = {
  ...process.env,
  PICKLAB_HOME: path.join(tmpRoot, "home"),
};
const projectDir = path.join(tmpRoot, "project");
fs.mkdirSync(projectDir, { recursive: true });

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function makeDesktopRecord(
  xvfbPid: number,
  vncPid?: number,
): Promise<string> {
  const record = await createSession(
    { type: "desktop", projectDir },
    registryEnv,
  );
  const desktop: {
    display: string;
    xvfbPid: number;
    xvfbStartTimeTicks: number;
    vncPid?: number;
    vncStartTimeTicks?: number;
  } = {
    display: ":219",
    xvfbPid,
    xvfbStartTimeTicks: 1,
  };
  if (vncPid !== undefined) {
    desktop.vncPid = vncPid;
    desktop.vncStartTimeTicks = 1;
  }
  await updateSession(record.id, { status: "running", desktop }, registryEnv);
  return record.id;
}

describe("destroyDesktopSession exception safety", () => {
  it("attempts every stop, marks the record as error, and aggregates failures", async () => {
    const id = await makeDesktopRecord(FAILING_PID, FAILING_PID);
    const error = await destroyDesktopSession(id, registryEnv).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).message).toMatch(/failed to stop 2/i);
    const after = await getSession(id, registryEnv);
    expect(after?.status).toBe("error");
    expect(after?.meta?.[REAPER_CLEANUP_PENDING_META_KEY]).toBe(true);
    expect(after?.desktop).toMatchObject({
      xvfbPid: FAILING_PID,
      vncPid: FAILING_PID,
    });
    allowFailingPidStop = true;
    try {
      const reaped = await reapDeadRunningSessions(registryEnv, {
        desktop: {
          teardown: (sessionId, finalize) =>
            teardownDesktopSession(sessionId, registryEnv, finalize),
        },
      });
      expect(reaped.map((record) => record.id)).toEqual([id]);
      expect(await getSession(id, registryEnv)).toBeUndefined();
    } finally {
      allowFailingPidStop = false;
    }
  });

  it("still stops xvfb when stopping vnc throws", async () => {
    const stopPidMock = vi.mocked(stopPid);
    const stopGroupMock = vi.mocked(stopProcessGroupVerified);
    stopPidMock.mockClear();
    stopGroupMock.mockClear();
    const id = await makeDesktopRecord(777_777, FAILING_PID);
    await expect(destroyDesktopSession(id, registryEnv)).rejects.toThrow(
      /failed to stop 1/i,
    );
    expect(stopPidMock).toHaveBeenCalledWith(FAILING_PID);
    expect(stopGroupMock).toHaveBeenCalledWith({
      pid: 777_777,
      startTicks: 1,
    });
  });

  it("treats a pid surviving SIGKILL as a stop failure", async () => {
    const id = await makeDesktopRecord(STUCK_PID);
    const error = await destroyDesktopSession(id, registryEnv).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: expect.stringMatching(/could not be verified as gone/),
    });
    const after = await getSession(id, registryEnv);
    expect(after?.status).toBe("error");
  });

  it("removes the record directly when all stops succeed", async () => {
    const id = await makeDesktopRecord(888_888, 999_999);
    await destroyDesktopSession(id, registryEnv);
    expect(await getSession(id, registryEnv)).toBeUndefined();
  });
});
