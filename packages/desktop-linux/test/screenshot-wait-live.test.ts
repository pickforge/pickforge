import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { pngPixelDigest } from "../src/png.js";
import {
  createDesktopSession,
  desktopWait,
  destroyDesktopSession,
  detectScreenshotTool,
  ensureDesktopSessionIsolation,
  execApp,
  findOnPath,
  screenshot,
  screenshotMetadata,
  sessionDisplaySize,
} from "../src/index.js";

const available =
  ["Xvfb", "xdotool", "zenity"].every((command) => findOnPath(command) !== null) &&
  detectScreenshotTool() !== null;
if (process.env.PICKFORGE_REQUIRE_DESKTOP_WAIT === "1" && !available) {
  throw new Error(
    "Required desktop wait integration needs Xvfb, xdotool, zenity and a screenshot tool",
  );
}

// zenity keeps its window mapped for this long. The 8 s window wait plus the paint
// wait below fit inside it with headroom for delayed painting under load.
const WINDOW_LIFETIME_S = 30;
const PAINT_WAIT_MS = 20_000;

it.skipIf(!available)("captures geometry and distinguishes pixel change from PNG metadata on managed Xvfb", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-wait-live-"));
  const env = { ...process.env, PICKFORGE_HOME: path.join(root, "home") };
  const session = await createDesktopSession({
    projectDir: root,
    registryEnv: env,
    width: 320,
    height: 240,
  });
  try {
    const firstPath = path.join(root, "first.png");
    const first = await screenshot({ display: session.display, outPath: firstPath, env });
    expect(first.imageSize).toEqual({ width: 320, height: 240 });
    const metadata = screenshotMetadata(first.imageSize, sessionDisplaySize({ width: 320, height: 240 }));
    expect(metadata).toEqual({
      imageSize: { width: 320, height: 240 },
      displaySize: { width: 320, height: 240 },
      scale: 1,
      inputCoordinates: "image-pixels",
    });
    const laterPath = path.join(root, "later.png");
    await screenshot({ display: session.display, outPath: laterPath, env });
    expect(await pngPixelDigest(firstPath)).toBe(await pngPixelDigest(laterPath));

    const stable = await desktopWait({
      display: session.display,
      mode: { type: "stable", stableMs: 200 },
      timeoutMs: 5_000,
      env,
    });
    expect(stable.reason).toBe("stable");
    expect(stable.samples).toBeGreaterThanOrEqual(2);

    const timedOut = await desktopWait({
      display: session.display,
      mode: { type: "changed", baselinePath: firstPath },
      timeoutMs: 400,
      env,
    });
    expect(timedOut.reason).toBe("timeout");

    const isolation = await ensureDesktopSessionIsolation(session.id, env);
    const appeared = desktopWait({
      display: session.display,
      mode: { type: "window", name: "Wait Live" },
      timeoutMs: 8_000,
      env,
    });
    const launched = execApp({
      display: session.display,
      command: "zenity",
      args: ["--info", "--title", "Wait Live", "--text", "Wait Live", "--timeout", String(WINDOW_LIFETIME_S)],
      logDir: session.logDir,
      env,
      ...isolation,
      windowTimeoutMs: 8_000,
    });
    // Attach both handlers immediately and finish both observations before teardown.
    // The earlier failure log contained a delayed-handler unhandled rejection here.
    const [observed, launch] = await Promise.allSettled([appeared, launched]);
    if (observed.status === "rejected") throw observed.reason;
    if (launch.status === "rejected") throw launch.reason;
    const window = observed.value;
    expect(window.reason).toBe("window");
    expect(window.window?.name).toContain("Wait Live");

    // xdotool lists the window once it is mapped; GTK paints its first frame later,
    // about 250 ms after that unloaded, 6.5 s after it in a loaded run, and later
    // than 10 s after launch at higher load (#193). This pixel-change wait is the
    // paint wait, so its budget is headroom for a starved paint instead of a fixed
    // 5 s. Unloaded it still returns at the first changed sample; the change
    // detection itself is unchanged.
    const changed = await desktopWait({
      display: session.display,
      mode: { type: "changed", baselinePath: firstPath },
      timeoutMs: PAINT_WAIT_MS,
      env,
    });
    expect(changed.reason).toBe("changed");
  } finally {
    await destroyDesktopSession(session.id, env);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
