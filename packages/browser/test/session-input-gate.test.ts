import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as core from "@pickforge/lab-core";

const XVFB_PID = 4_194_313;
const CHROME_PID = 4_194_314;
vi.mock("@pickforge/lab-core", async (original) => {
  const actual = await original<typeof core>();
  return {
    ...actual,
    stopProcessGroupVerified: vi.fn(async () => ({ outcome: "already-dead", signaled: false })),
    readProcessIdentity: (pid: number) => pid === CHROME_PID ? { pid, startTicks: 654 } : actual.readProcessIdentity(pid),
    startDaemon: vi.fn(async () => ({ pid: CHROME_PID, logPath: "/fake/chrome.log", child: { exitCode: null, signalCode: null }, release: vi.fn() })),
  };
});
vi.mock("@pickforge/lab-desktop-linux", async (original) => {
  const actual = await original<typeof import("@pickforge/lab-desktop-linux")>();
  return { ...actual, startXvfb: vi.fn(async () => ({ display: ":2993", pid: XVFB_PID, startTimeTicks: 321, logPath: "/fake/xvfb.log", width: 1280, height: 800 })) };
});
vi.mock("../src/detect.js", () => ({ requireChromeBinary: () => "/fake/chrome" }));
vi.mock("../src/devtools.js", () => ({ waitForDevToolsPort: vi.fn(), readDevToolsBrowserVersion: vi.fn() }));
import { waitForDevToolsPort } from "../src/devtools.js";
import { createBrowserSession, destroyBrowserSession, teardownBrowserSession } from "../src/session.js";

let home: string;
let env: { PICKFORGE_HOME: string };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-browser-input-gate-"));
  env = { PICKFORGE_HOME: home };
  vi.mocked(core.stopProcessGroupVerified).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});
function watchClosure() {
  let closed!: () => void;
  const promise = new Promise<void>((resolve) => { closed = resolve; });
  const open = fs.promises.open;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".input-closed")) closed();
    return file;
  });
  return promise;
}
const running = () => core.createSession({ type: "browser", status: "running", projectDir: home,
  desktop: { display: ":2993", xvfbPid: XVFB_PID, xvfbStartTimeTicks: 321 },
  browser: { browserPid: CHROME_PID, browserStartTimeTicks: 654, profileMode: "ephemeral", profileDir: "", binaryPath: "/fake/chrome" },
}, env);

it("destroy waits for input before stopping Chrome or the display", async () => {
  const record = await running();
  await core.updateSession(record.id, { browser: { ...record.browser!, profileDir: path.join(core.sessionDataDir(record.id, env), "profile") } }, env);
  const permit = await core.acquireAgentPermit(record.id, env);
  const closed = watchClosure();
  const destroying = destroyBrowserSession(record.id, env);
  await closed;
  expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
  await core.releaseAgentPermit(permit);
  await destroying;
  expect(vi.mocked(core.stopProcessGroupVerified).mock.calls.map(([identity]) => identity.pid)).toEqual([CHROME_PID, XVFB_PID]);
});

it("a drain timeout preserves Chrome and the display for a reaper retry", async () => {
  const record = await running();
  await core.updateSession(record.id, { browser: { ...record.browser!, profileDir: path.join(core.sessionDataDir(record.id, env), "profile") } }, env);
  const permit = await core.acquireAgentPermit(record.id, env);
  const stop = core.stopSessionAgentInput;
  const shortDrain = vi.spyOn(core, "stopSessionAgentInput").mockImplementation((id, registry) => stop(id, registry, 0));
  await expect(destroyBrowserSession(record.id, env)).rejects.toThrow(core.SessionInputDrainTimeoutError);
  expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
  expect(await core.getSession(record.id, env)).toMatchObject({ status: "error", meta: { reaperCleanupPending: true }, desktop: record.desktop });
  await core.releaseAgentPermit(permit);
  shortDrain.mockRestore();
  const reaped = await core.reapDeadRunningSessions(env, { browser: {
    teardown: (id, finalize) => teardownBrowserSession(id, env, finalize),
  } }, () => true);
  expect(reaped.map(({ id }) => id)).toEqual([record.id]);
});

it.each([false, true])("startup rollback preserves resources until input drains, timeout=%s", async (timeout) => {
  let permit!: core.AgentPermit;
  vi.mocked(waitForDevToolsPort).mockImplementationOnce(async () => {
    const [record] = await core.listSessions(env);
    await core.updateSession(record!.id, { status: "running" }, env);
    permit = await core.acquireAgentPermit(record!.id, env);
    throw new Error("CDP startup failed");
  });
  if (timeout) {
    const stop = core.stopSessionAgentInput;
    vi.spyOn(core, "stopSessionAgentInput").mockImplementation((id, registry) => stop(id, registry, 0));
  }
  const closed = watchClosure();
  const creating = createBrowserSession({ projectDir: home, registryEnv: env });
  const failed = expect(creating).rejects.toThrow("CDP startup failed");
  await closed;
  expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
  if (timeout) {
    await failed;
    expect(core.stopProcessGroupVerified).not.toHaveBeenCalled();
    expect(await core.getSession(permit.sessionId, env)).toMatchObject({ status: "error", meta: { reaperCleanupPending: true }, desktop: { xvfbPid: XVFB_PID }, browser: { browserPid: CHROME_PID } });
  }
  await core.releaseAgentPermit(permit);
  if (!timeout) {
    await failed;
    expect(vi.mocked(core.stopProcessGroupVerified).mock.calls.map(([identity]) => identity.pid)).toEqual([CHROME_PID, XVFB_PID]);
  }
});
