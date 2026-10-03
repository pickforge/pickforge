import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ViewerLaunchRecord } from "@pickforge/lab-desktop-linux";
import {
  applyHyprlandWindowMode,
  buildPlacementLua,
  buildRuleDisableLua,
  buildRuleInstallLua,
  detectHyprland,
  disableViewerRule,
  installViewerRule,
  luaInt,
  luaString,
  monitorWorkArea,
  placeViewerWindow,
  viewerClassPattern,
  waitForViewerWindow,
} from "../src/viewer/hyprland.js";
import { createViewerFakes, monitor, type ViewerFakes } from "./viewer-fakes.js";

const LAUNCH_ID = "0123456789abcdef0123456789abcdef";
const APP_CLASS = `chrome-127.0.0.1__viewer_${LAUNCH_ID}-Default`;
const X11_CLASS = `pickforge-viewer-${LAUNCH_ID}`;

let root: string;
let fakes: ViewerFakes;
let hyprctl: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-viewer-hypr-"));
  fakes = createViewerFakes(root);
  hyprctl = fakes.installHyprctl();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PATH: fakes.binDir,
    HYPRLAND_INSTANCE_SIGNATURE: "abc_123",
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    ...overrides,
  };
}

function ctx(): { hyprctl: string; instance: string; xdgRuntimeDir: string } {
  return { hyprctl, instance: "abc_123", xdgRuntimeDir: path.join(root, "runtime") };
}

function launch(overrides: Partial<ViewerLaunchRecord> = {}): ViewerLaunchRecord {
  return {
    launchId: LAUNCH_ID,
    sessionId: "desk-aaaaaa11",
    createdAt: new Date().toISOString(),
    browser: { kind: "chromium", binary: "/usr/bin/chromium" },
    profileDir: path.join(root, "profile"),
    pid: 4242,
    thumbnail: { width: 384, height: 240 },
    expanded: { width: 1280, height: 800 },
    hyprland: {
      ...ctx(),
      ruleName: `pickforge-viewer-${LAUNCH_ID}`,
      classPattern: viewerClassPattern(LAUNCH_ID),
    },
    ...overrides,
  };
}

function setClients(clients: unknown[]): void {
  fs.writeFileSync(fakes.clientsFile, JSON.stringify(clients));
}

function client(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { address: "0xabc123", class: APP_CLASS, pid: 4242, floating: true, monitor: 0, ...overrides };
}

function evals(): string[] {
  return fakes
    .calls()
    .filter((call) => (call.args as string[])[2] === "eval")
    .map((call) => (call.args as string[])[3] as string);
}

describe("class pattern and Lua literals", () => {
  it("matches the verified Wayland app id and the X11 class, nothing else", () => {
    const pattern = new RegExp(viewerClassPattern(LAUNCH_ID));
    expect(pattern.test(APP_CLASS)).toBe(true);
    expect(pattern.test(X11_CLASS)).toBe(true);
    expect(pattern.test(`chrome-127.0.0.1__viewer_${"f".repeat(32)}-Default`)).toBe(false);
    expect(pattern.test(`chrome-127x0x0x1__viewer_${LAUNCH_ID}-Default`)).toBe(false);
    expect(pattern.test(`${X11_CLASS}-other`)).toBe(false);
  });

  it("escapes Lua strings and refuses control characters and non-integers", () => {
    expect(luaString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(() => luaString("a\nb")).toThrow(/control characters/);
    expect(luaInt(42)).toBe("42");
    expect(() => luaInt(1.5)).toThrow(/non-integer/);
    expect(() => luaInt(Number.NaN)).toThrow(/non-integer/);
  });

  it("builds the launch rule with monitor-relative expressions", () => {
    const lua = buildRuleInstallLua("pickforge-viewer-x", "^a\\.b$", { width: 384, height: 240 }, { right: 0, bottom: 30 });
    expect(lua).toBe(
      'hl.window_rule({name="pickforge-viewer-x", match={class="^a\\\\.b$"}, float=true, pin=true, ' +
        'no_initial_focus=true, size={384,240}, move={"(monitor_w-384-24)","(monitor_h-240-54)"}})',
    );
    expect(buildRuleDisableLua("pickforge-viewer-x")).toBe(
      'hl.window_rule({name="pickforge-viewer-x", enabled=false})',
    );
  });

  it("targets exactly one client address and refuses anything else", () => {
    expect(buildPlacementLua("0xabc123", { x: 1, y: 2, width: 3, height: 4 })).toBe(
      'hl.dispatch(hl.dsp.window.resize({x=3,y=4,window="address:0xabc123"})); ' +
        'hl.dispatch(hl.dsp.window.move({x=1,y=2,window="address:0xabc123"}))',
    );
    expect(() => buildPlacementLua('0x1"}) os.exit(', { x: 1, y: 2, width: 3, height: 4 })).toThrow(
      /invalid Hyprland client address/,
    );
  });
});

describe("placement geometry", () => {
  it("uses logical size, honors rotation and reserved areas", () => {
    expect(monitorWorkArea(monitor({ width: 2880, height: 1920, scale: 1.5, x: 100, y: 50 }) as never)).toEqual({
      x: 100,
      y: 50,
      width: 1920,
      height: 1280,
    });
    expect(monitorWorkArea(monitor({ width: 1920, height: 1080, transform: 1 }) as never)).toEqual({
      x: 0,
      y: 0,
      width: 1080,
      height: 1920,
    });
    expect(monitorWorkArea(monitor({ reserved: [10, 30, 20, 40] }) as never)).toEqual({
      x: 10,
      y: 30,
      width: 1890,
      height: 1010,
    });
  });

  it("centers the expanded window within 90 percent and keeps the aspect ratio", () => {
    const area = { x: 0, y: 0, width: 1280, height: 800 };
    expect(placeViewerWindow(launch(), "expanded", area)).toEqual({ x: 64, y: 40, width: 1152, height: 720 });
    const big = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(placeViewerWindow(launch(), "expanded", big)).toEqual({ x: 320, y: 140, width: 1280, height: 800 });
  });

  it("puts the thumbnail in the bottom-right corner with a 24 px margin", () => {
    const area = { x: 1920, y: 30, width: 1920, height: 1050 };
    expect(placeViewerWindow(launch(), "thumbnail", area)).toEqual({
      x: 1920 + 1920 - 384 - 24,
      y: 30 + 1050 - 240 - 24,
      width: 384,
      height: 240,
    });
  });
});

describe("detectHyprland", () => {
  it("applies only with a signature, a runtime dir, hyprctl and the Lua provider", async () => {
    fakes.setState({ status: { configProvider: "lua" } });
    expect(await detectHyprland(env())).toEqual(ctx());
    expect(await detectHyprland(env({ HYPRLAND_INSTANCE_SIGNATURE: undefined }))).toBeUndefined();
    expect(await detectHyprland(env({ HYPRLAND_INSTANCE_SIGNATURE: "a/b" }))).toBeUndefined();
    expect(await detectHyprland(env({ XDG_RUNTIME_DIR: undefined }))).toBeUndefined();
    expect(await detectHyprland(env({ XDG_RUNTIME_DIR: "relative" }))).toBeUndefined();
    expect(await detectHyprland(env({ PATH: path.join(root, "nowhere") }))).toBeUndefined();
    const status = fakes.calls().find((call) => (call.args as string[]).includes("status"));
    expect(status).toMatchObject({
      args: ["--instance", "abc_123", "-j", "status"],
      xdg: path.join(root, "runtime"),
      sig: "abc_123",
    });
  });

  it("ships an ordinary window for a hyprlang config or a broken hyprctl", async () => {
    fakes.setState({ status: { configProvider: "hyprlang" } });
    expect(await detectHyprland(env())).toBeUndefined();
    fs.writeFileSync(hyprctl, "#!/bin/sh\necho not-json\n");
    expect(await detectHyprland(env())).toBeUndefined();
  });
});

describe("rule lifecycle helpers", () => {
  it("installs with the focused monitor's reserved space and disables by name", async () => {
    fakes.setState({ monitors: [monitor({ focused: false }), monitor({ id: 1, reserved: [0, 0, 6, 32] })] });
    expect(await installViewerRule(ctx(), "pickforge-viewer-x", "^x$", { width: 384, height: 240 })).toBe(true);
    expect(await disableViewerRule(ctx(), "pickforge-viewer-x")).toBe(true);
    expect(evals()).toEqual([
      buildRuleInstallLua("pickforge-viewer-x", "^x$", { width: 384, height: 240 }, { right: 6, bottom: 32 }),
      buildRuleDisableLua("pickforge-viewer-x"),
    ]);
  });

  it("reports a refused eval as false", async () => {
    fakes.setState({ monitors: [], evalFailOn: "window_rule" });
    expect(await installViewerRule(ctx(), "pickforge-viewer-x", "^x$", { width: 1, height: 1 })).toBe(false);
  });

  it("waits for the window, and stops early when told to", async () => {
    setClients([client({ pid: 1 }), client()]);
    const found = await waitForViewerWindow(ctx(), viewerClassPattern(LAUNCH_ID), 4242, { timeoutMs: 1_000 });
    expect(found).toMatchObject({ address: "0xabc123", pid: 4242 });
    setClients([]);
    const started = Date.now();
    expect(await waitForViewerWindow(ctx(), "^x$", 4242, { timeoutMs: 400, pollMs: 50 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await waitForViewerWindow(ctx(), "^x$", 4242, { timeoutMs: 10_000, stopped: () => true })).toBeUndefined();
  });
});

describe("applyHyprlandWindowMode", () => {
  beforeEach(() => {
    fakes.setState({ monitors: [monitor({ width: 2560, height: 1600, scale: 2, reserved: [0, 0, 0, 0] })] });
  });

  it("resizes and moves the verified client for both modes", async () => {
    setClients([client({ address: "0x1", class: "other", pid: 4242 }), client()]);
    expect(await applyHyprlandWindowMode(launch(), "expanded")).toBe(true);
    expect(await applyHyprlandWindowMode(launch(), "thumbnail")).toBe(true);
    expect(evals()).toEqual([
      buildPlacementLua("0xabc123", { x: 64, y: 40, width: 1152, height: 720 }),
      buildPlacementLua("0xabc123", { x: 872, y: 536, width: 384, height: 240 }),
    ]);
    const call = fakes.calls().at(-1);
    expect(call).toMatchObject({ xdg: path.join(root, "runtime"), sig: "abc_123" });
    expect((call?.args as string[] | undefined)?.slice(0, 2)).toEqual(["--instance", "abc_123"]);
  });

  it("matches the X11 class too", async () => {
    setClients([client({ class: X11_CLASS })]);
    expect(await applyHyprlandWindowMode(launch(), "expanded")).toBe(true);
  });

  it("returns false without a context, a window, the pid, floating or a monitor", async () => {
    expect(await applyHyprlandWindowMode(launch({ hyprland: undefined }), "expanded")).toBe(false);
    setClients([]);
    expect(await applyHyprlandWindowMode(launch(), "expanded")).toBe(false);
    setClients([client({ pid: 999 })]);
    expect(await applyHyprlandWindowMode(launch(), "expanded")).toBe(false);
    setClients([client({ floating: false })]);
    expect(await applyHyprlandWindowMode(launch(), "expanded")).toBe(false);
    setClients([client({ monitor: 7 })]);
    expect(await applyHyprlandWindowMode(launch(), "expanded")).toBe(false);
    setClients([client({ address: "not-an-address" })]);
    expect(await applyHyprlandWindowMode(launch(), "expanded")).toBe(false);
    expect(evals()).toEqual([]);
  });

  it("matches by class alone when no pid was recorded", async () => {
    setClients([client({ pid: 31337 })]);
    expect(await applyHyprlandWindowMode(launch({ pid: undefined }), "thumbnail")).toBe(true);
  });

  it("returns false instead of throwing when hyprctl fails", async () => {
    setClients([client()]);
    fakes.setState({ monitors: [monitor()], evalFailOn: "hl.dispatch" });
    expect(await applyHyprlandWindowMode(launch(), "expanded")).toBe(false);
    const missing = launch();
    missing.hyprland = { ...missing.hyprland!, hyprctl: path.join(root, "missing-hyprctl") };
    expect(await applyHyprlandWindowMode(missing, "expanded")).toBe(false);
  });
});
