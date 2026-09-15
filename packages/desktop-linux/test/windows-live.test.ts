import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runCommand } from "@pickforge/lab-core";
import {
  createDesktopSession, destroyDesktopSession, desktopWindows,
  ensureDesktopSessionIsolation, execApp, findOnPath, focusWindow,
  selectDesktopWindow,
} from "../src/index.js";

const available = ["Xvfb", "xdotool", "xprop", "zenity"].every((command) => findOnPath(command) !== null);
if (process.env.PICKFORGE_REQUIRE_DESKTOP_WINDOWS === "1" && !available) {
  throw new Error("Required desktop windows integration needs Xvfb, xdotool, xprop and zenity");
}

it.skipIf(!available)("inventories and focuses two zenity windows on managed bare Xvfb", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-windows-live-"));
  const env = { ...process.env, PICKFORGE_HOME: path.join(root, "home") };
  const session = await createDesktopSession({ projectDir: root, registryEnv: env });
  try {
    const isolation = await ensureDesktopSessionIsolation(session.id, env);
    for (const name of ["Focus One", "Focus Two"]) {
      await execApp({ display: session.display, command: "zenity", args: ["--entry", "--title", name, "--text", name], logDir: session.logDir, env, ...isolation, windowTimeoutMs: 10_000 });
    }
    const windows = await desktopWindows(session.display, env);
    expect(windows.map((window) => window.name).sort()).toEqual(["Focus One", "Focus Two"]);
    for (const window of windows) {
      expect(window.class).toMatch(/zenity/i);
      expect(window.geometry.width).toBeGreaterThan(0);
      expect(window.geometry.height).toBeGreaterThan(0);
    }
    await runCommand("xdotool", ["windowfocus", "0"], { env: { ...env, DISPLAY: session.display }, timeoutMs: 2_000, check: true });
    expect((await desktopWindows(session.display, env)).every((window) => !window.focused)).toBe(true);
    const ewmh = await runCommand("xdotool", ["getactivewindow"], { env: { ...env, DISPLAY: session.display }, timeoutMs: 2_000 });
    expect(ewmh.ok).toBe(false);
    for (const selector of [{ name: "Focus One" }, { id: windows.find((window) => window.name === "Focus Two")!.id }]) {
      const window = await selectDesktopWindow(session.display, selector, env);
      expect(await focusWindow({ display: session.display, sessionId: session.id, env, window })).toMatchObject({ id: window.id, focused: true });
      expect((await desktopWindows(session.display, env)).filter((entry) => entry.focused).map((entry) => entry.id)).toEqual([window.id]);
    }
  } finally {
    await destroyDesktopSession(session.id, env);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
