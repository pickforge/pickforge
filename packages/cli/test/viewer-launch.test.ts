import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerLaunchRecord } from "@pickforge/lab-desktop-linux";

const { prepareViewerLaunch, writeViewerLaunchRecord, removeViewerLaunch } = vi.hoisted(() => ({
  prepareViewerLaunch: vi.fn(),
  writeViewerLaunchRecord: vi.fn(),
  removeViewerLaunch: vi.fn(),
}));

vi.mock("@pickforge/lab-desktop-linux", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pickforge/lab-desktop-linux")>()),
  prepareViewerLaunch,
  writeViewerLaunchRecord,
  removeViewerLaunch,
}));

import { viewerClassPattern } from "../src/viewer/hyprland.js";
import {
  FIREFOX_USER_JS,
  buildChromiumViewerArgs,
  buildFirefoxViewerArgs,
  detectViewerBrowser,
  hasGraphicalSession,
  launchViewerWindow,
  viewerWindowSizes,
  type LaunchViewerWindowOptions,
} from "../src/viewer/launch.js";
import { createViewerFakes, monitor, type ViewerFakes } from "./viewer-fakes.js";

const LAUNCH_ID = "fedcba9876543210fedcba9876543210";
const TOKEN = "capability-token-value";

let root: string;
let fakes: ViewerFakes;
let profileDir: string;
const spawnedPids: number[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-viewer-launch-"));
  fakes = createViewerFakes(root);
  profileDir = path.join(root, "launches", LAUNCH_ID, "profile");
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  prepareViewerLaunch.mockResolvedValue({
    launchId: LAUNCH_ID,
    launchDir: path.dirname(profileDir),
    profileDir,
  });
  writeViewerLaunchRecord.mockImplementation(async (record: ViewerLaunchRecord) => {
    fs.appendFileSync(fakes.callsLog, `${JSON.stringify({ tool: "record", pid: record.pid ?? null })}\n`);
  });
  removeViewerLaunch.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function hyprEnv(): NodeJS.ProcessEnv {
  return {
    PATH: fakes.binDir,
    WAYLAND_DISPLAY: "wayland-1",
    HYPRLAND_INSTANCE_SIGNATURE: "sig_1",
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
  };
}

function options(overrides: Partial<LaunchViewerWindowOptions> = {}): LaunchViewerWindowOptions {
  return {
    sessionId: "desk-aaaaaa11",
    desktop: { display: ":42", width: 1600, height: 900 },
    bridgePort: 43210,
    token: TOKEN,
    browser: { kind: "chromium", name: "chromium", binary: fakes.installBrowser("chromium") },
    waitForExit: false,
    env: { PATH: fakes.binDir, DISPLAY: ":0" },
    ...overrides,
  };
}

async function launch(overrides: Partial<LaunchViewerWindowOptions> = {}) {
  const result = await launchViewerWindow(options(overrides));
  spawnedPids.push(result.pid);
  // The fake logs once it runs, which is after the spawn event.
  await vi.waitFor(() => expect(fakes.calls().some((call) => call.tool === "browser")).toBe(true));
  return result;
}

/** The order of steps, with the browser's own start line left out. */
function steps(): string[] {
  return sequence().filter((step) => step !== "browser");
}

/** The browser started only after every step in `earlier`. */
function expectStartedAfter(earlier: string[]): void {
  const order = sequence();
  const started = order.indexOf("browser");
  expect(started).toBeGreaterThan(-1);
  for (const step of earlier) {
    expect(order.indexOf(step)).toBeGreaterThan(-1);
    expect(order.indexOf(step)).toBeLessThan(started);
  }
}

function sequence(): string[] {
  return fakes.calls().map((call) => {
    if (call.tool === "record") return call.pid === null ? "record" : "record+pid";
    if (call.tool === "browser") return "browser";
    const args = call.args as string[];
    if (args[2] === "eval") return (args[3] as string).includes("enabled=false") ? "disable" : "install";
    return `query:${args[3]}`;
  });
}

function records(): ViewerLaunchRecord[] {
  return writeViewerLaunchRecord.mock.calls.map((call) => call[0] as ViewerLaunchRecord);
}

describe("browser detection", () => {
  it("prefers Chromium names in order, then Chrome, then Firefox", () => {
    const env = { PATH: fakes.binDir };
    expect(detectViewerBrowser(env)).toBeNull();
    fakes.installBrowser("firefox");
    expect(detectViewerBrowser(env)).toMatchObject({ kind: "firefox", name: "firefox" });
    fakes.installBrowser("google-chrome");
    expect(detectViewerBrowser(env)).toMatchObject({ kind: "chromium", name: "google-chrome" });
    fakes.installBrowser("google-chrome-stable");
    expect(detectViewerBrowser(env)).toMatchObject({ name: "google-chrome-stable" });
    fakes.installBrowser("chromium-browser");
    expect(detectViewerBrowser(env)).toMatchObject({ name: "chromium-browser" });
    fakes.installBrowser("chromium");
    expect(detectViewerBrowser(env)).toMatchObject({
      kind: "chromium",
      name: "chromium",
      binary: path.join(fakes.binDir, "chromium"),
    });
  });

  it("needs DISPLAY or WAYLAND_DISPLAY for a GUI", () => {
    expect(hasGraphicalSession({})).toBe(false);
    expect(hasGraphicalSession({ DISPLAY: "" })).toBe(false);
    expect(hasGraphicalSession({ DISPLAY: ":0" })).toBe(true);
    expect(hasGraphicalSession({ WAYLAND_DISPLAY: "wayland-1" })).toBe(true);
  });
});

describe("window sizes and arguments", () => {
  it("derives the thumbnail from the session aspect ratio", () => {
    expect(viewerWindowSizes(undefined)).toEqual({
      thumbnail: { width: 384, height: 240 },
      expanded: { width: 1280, height: 800 },
    });
    expect(viewerWindowSizes({ width: 1920, height: 1080 })).toEqual({
      thumbnail: { width: 384, height: 216 },
      expanded: { width: 1920, height: 1080 },
    });
    expect(viewerWindowSizes({ width: 0, height: 1080 }).expanded).toEqual({ width: 1280, height: 800 });
  });

  it("builds a chromeless Chromium app window without --no-sandbox", () => {
    const args = buildChromiumViewerArgs({
      url: "http://127.0.0.1:1/viewer/x#token=t",
      profileDir: "/p",
      launchId: "x",
      size: { width: 384, height: 240 },
    });
    expect(args.slice(0, 9)).toEqual([
      "--app=http://127.0.0.1:1/viewer/x#token=t",
      "--user-data-dir=/p",
      "--class=pickforge-viewer-x",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-mode",
      "--password-store=basic",
      "--disable-extensions",
    ]);
    expect(args.at(-1)).toBe("--window-size=384,240");
    expect(args).toContain("--disable-background-networking");
    expect(args).not.toContain("--no-sandbox");
    // Chromium shows an "unsupported command-line flag" bar for --gaia-url.
    expect(args.some((arg) => arg.startsWith("--gaia-url"))).toBe(false);
  });

  it("builds an ordinary Firefox window in its own instance", () => {
    expect(
      buildFirefoxViewerArgs({
        url: "http://127.0.0.1:1/viewer/x#token=t",
        profileDir: "/p",
        launchId: "x",
        size: { width: 384, height: 240 },
      }),
    ).toEqual([
      "--new-instance",
      "--profile",
      "/p",
      "--class",
      "pickforge-viewer-x",
      "--name",
      "pickforge-viewer-x",
      "--width",
      "384",
      "--height",
      "240",
      "http://127.0.0.1:1/viewer/x#token=t",
    ]);
  });
});

describe("launchViewerWindow", () => {
  it("records the launch before spawning and the browser identity right after", async () => {
    fakes.setBrowser({});
    const result = await launch();

    expect(result).toMatchObject({ launchId: LAUNCH_ID, browser: "chromium", adapter: "none" });
    expect(steps()).toEqual(["record", "record+pid"]);
    expectStartedAfter(["record"]);
    const [first, second] = records();
    expect(first).toMatchObject({
      launchId: LAUNCH_ID,
      sessionId: "desk-aaaaaa11",
      browser: { kind: "chromium", binary: path.join(fakes.binDir, "chromium") },
      profileDir,
      thumbnail: { width: 384, height: 216 },
      expanded: { width: 1600, height: 900 },
    });
    expect(first?.pid).toBeUndefined();
    expect(first?.hyprland).toBeUndefined();
    expect(second).toMatchObject({ pid: result.pid });
    expect(second?.startTicks).toEqual(expect.any(Number));
    const browser = fakes.calls().find((call) => call.tool === "browser");
    expect(browser?.args).toEqual(
      buildChromiumViewerArgs({
        url: `http://127.0.0.1:43210/viewer/${LAUNCH_ID}#token=${TOKEN}`,
        profileDir,
        launchId: LAUNCH_ID,
        size: { width: 384, height: 216 },
      }),
    );
    // Detached: the browser leads its own process group for teardown.
    expect(fs.readFileSync(`/proc/${result.pid}/stat`, "utf8").split(") ")[1]?.split(" ")[2]).toBe(
      String(result.pid),
    );
    expect(removeViewerLaunch).not.toHaveBeenCalled();
  });

  it("installs the Hyprland rule before spawning and disables it once the window maps", async () => {
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" }, monitors: [monitor({ reserved: [0, 0, 0, 40] })] });
    fakes.setBrowser({ mapAfterMs: 150 });

    const result = await launch({ env: hyprEnv() });

    expect(result.adapter).toBe("hyprland");
    const order = steps();
    expect(order.slice(0, 5)).toEqual([
      "query:status",
      "query:monitors",
      "install",
      "record",
      "record+pid",
    ]);
    expectStartedAfter(["install", "record"]);
    expect(order.at(-1)).toBe("disable");
    expect(order.slice(5, -1).length).toBeGreaterThan(0);
    expect(order.slice(5, -1).every((step) => step === "query:clients")).toBe(true);
    expect(order.filter((step) => step === "disable")).toHaveLength(1);
    const install = fakes.calls().find((call) => (call.args as string[])[2] === "eval");
    expect((install?.args as string[] | undefined)?.[3]).toContain("(monitor_h-216-64)");
    expect(records()[0]?.hyprland).toEqual({
      hyprctl: path.join(fakes.binDir, "hyprctl"),
      instance: "sig_1",
      xdgRuntimeDir: path.join(root, "runtime"),
      ruleName: `pickforge-viewer-${LAUNCH_ID}`,
      classPattern: viewerClassPattern(LAUNCH_ID),
    });
    for (const call of fakes.calls().filter((entry) => entry.tool === "hyprctl")) {
      expect(call).toMatchObject({ xdg: path.join(root, "runtime"), sig: "sig_1" });
    }
  });

  it("disables the rule after a bounded wait when the window never maps", async () => {
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" }, monitors: [] });
    fakes.setBrowser({});
    const started = Date.now();

    const result = await launch({ env: hyprEnv(), windowWaitMs: 500 });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.adapter).toBe("none");
    expect(sequence().at(-1)).toBe("disable");
  });

  it("stops waiting as soon as the browser exits", async () => {
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" }, monitors: [] });
    fakes.setBrowser({ exitAfterMs: 50, exitCode: 0 });
    const started = Date.now();

    const result = await launch({ env: hyprEnv(), windowWaitMs: 30_000, waitForExit: true });

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ adapter: "none", exitCode: 0 });
    expect(sequence().at(-1)).toBe("disable");
    expect(removeViewerLaunch).toHaveBeenCalledWith("desk-aaaaaa11", LAUNCH_ID, undefined);
  });

  it("disables the rule and removes the launch when the browser cannot spawn", async () => {
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" }, monitors: [] });
    const missing = path.join(root, "missing-chromium");

    await expect(
      launchViewerWindow(options({ env: hyprEnv(), browser: { kind: "chromium", name: "chromium", binary: missing } })),
    ).rejects.toThrow(/ENOENT/);

    expect(sequence()).toEqual(["query:status", "query:monitors", "install", "record", "disable"]);
    expect(removeViewerLaunch).toHaveBeenCalledWith("desk-aaaaaa11", LAUNCH_ID, undefined);
  });

  it("disables the rule when recording the launch fails", async () => {
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" }, monitors: [] });
    writeViewerLaunchRecord.mockRejectedValueOnce(new Error("disk full"));

    await expect(launchViewerWindow(options({ env: hyprEnv() }))).rejects.toThrow(/disk full/);

    expect(sequence()).toEqual(["query:status", "query:monitors", "install", "disable"]);
    expect(fakes.calls().some((call) => call.tool === "browser")).toBe(false);
  });

  it("stops the browser when its identity cannot be recorded", async () => {
    fakes.setBrowser({});
    writeViewerLaunchRecord.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full"));

    await expect(launchViewerWindow(options())).rejects.toThrow(/disk full/);

    const browser = fakes.calls().find((call) => call.tool === "browser");
    const pid = browser?.pid as number;
    await vi.waitFor(() => expect(fs.existsSync(`/proc/${pid}`)).toBe(false), { timeout: 5_000 });
    expect(removeViewerLaunch).toHaveBeenCalled();
  });

  it("falls back to an ordinary window when Hyprland refuses the rule", async () => {
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" }, monitors: [], evalFailOn: "no_initial_focus" });
    fakes.setBrowser({ mapAfterMs: 50 });

    const result = await launch({ env: hyprEnv() });

    expect(result.adapter).toBe("none");
    expect(records()[0]?.hyprland).toBeUndefined();
    expect(steps()).toEqual(["query:status", "query:monitors", "install", "disable", "record", "record+pid"]);
    expectStartedAfter(["disable", "record"]);
  });

  it("gives Firefox a prepared profile and no compositor rule", async () => {
    fakes.installHyprctl();
    fakes.setState({ status: { configProvider: "lua" } });
    fakes.setBrowser({});
    const binary = fakes.installBrowser("firefox");

    const result = await launch({ env: hyprEnv(), browser: { kind: "firefox", name: "firefox", binary } });

    expect(result).toMatchObject({ browser: "firefox", adapter: "none" });
    expect(fakes.calls().some((call) => call.tool === "hyprctl")).toBe(false);
    const userJs = path.join(profileDir, "user.js");
    expect(fs.readFileSync(userJs, "utf8")).toBe(FIREFOX_USER_JS);
    expect(FIREFOX_USER_JS).toContain('user_pref("browser.aboutwelcome.enabled", false);');
    expect(FIREFOX_USER_JS).toContain('user_pref("browser.shell.checkDefaultBrowser", false);');
    expect(FIREFOX_USER_JS).toContain('user_pref("identity.fxaccounts.enabled", false);');
    expect(FIREFOX_USER_JS).toContain('user_pref("browser.startup.homepage_override.mstone", "ignore");');
    expect(FIREFOX_USER_JS).toContain('user_pref("datareporting.policy.firstRunURL", "");');
    expect(fs.statSync(userJs).mode & 0o777).toBe(0o600);
    expect(fakes.calls().find((call) => call.tool === "browser")?.args).toEqual(
      expect.arrayContaining(["--new-instance", "--profile", profileDir]),
    );
  });

  it("waits for the browser and reports a nonzero exit or a signal", async () => {
    fakes.setBrowser({ exitAfterMs: 20, exitCode: 3 });
    expect(await launch({ waitForExit: true })).toMatchObject({ exitCode: 3, signal: null });
    fakes.setBrowser({ exitAfterMs: 20, exitSignal: "SIGTERM" });
    expect(await launch({ waitForExit: true })).toMatchObject({ exitCode: null, signal: "SIGTERM" });
    expect(removeViewerLaunch).toHaveBeenCalledTimes(2);
  });

  it("forwards an interrupt to the browser group while waiting", async () => {
    fakes.setBrowser({});
    const pending = launchViewerWindow(options({ waitForExit: true }));
    await vi.waitFor(() => expect(writeViewerLaunchRecord).toHaveBeenCalledTimes(2));
    process.emit("SIGINT", "SIGINT");
    expect(await pending).toMatchObject({ signal: "SIGINT" });
  });

  it("keeps a launch that cannot be removed for a later prune", async () => {
    fakes.setBrowser({ exitAfterMs: 20, exitCode: 0 });
    removeViewerLaunch.mockRejectedValueOnce(new Error("still busy"));
    expect(await launch({ waitForExit: true })).toMatchObject({ exitCode: 0 });
  });
});
