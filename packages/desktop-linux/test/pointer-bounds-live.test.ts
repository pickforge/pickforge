import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getSession, updateSession, type EnvLike } from "@pickforge/lab-core";
import { createDesktopSession, destroyDesktopSession, findOnPath } from "../src/index.js";
import { click, move } from "../src/input.js";

// pickforge/pickforge#424: pointer bounds come from the live screen, not the session record.
const available = ["Xvfb", "xdotool"].every((tool) => findOnPath(tool) !== null);
const xrandr = findOnPath("xrandr") !== null;

let root: string;
let env: EnvLike;
let session: { id: string; display: string };

beforeEach(async () => {
  if (!available) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-pointer-bounds-"));
  env = { ...process.env, PICKFORGE_HOME: path.join(root, "home") };
  session = await createDesktopSession({ projectDir: root, registryEnv: env, env, vnc: false, width: 640, height: 480 });
});

afterEach(async () => {
  if (!available) return;
  await destroyDesktopSession(session.id, env);
  fs.rmSync(root, { recursive: true, force: true });
});

const x11 = (command: string, args: string[]) =>
  execFileSync(command, args, { env: { ...process.env, DISPLAY: session.display }, encoding: "utf8" });
const pointer = () => x11("xdotool", ["getmouselocation", "--shell"]).split("\n").slice(0, 2).join(" ");
const at = () => ({ sessionId: session.id, display: session.display, env });

it.skipIf(!available || !xrandr)("refuses a point that a RandR shrink moved off screen, and accepts the new last pixel", async () => {
  await move({ ...at(), x: 100, y: 100 });
  x11("xrandr", ["--output", "screen", "--off", "--fb", "320x240"]);
  expect(x11("xrandr", []).split("\n")[0]).toContain("current 320 x 240");
  await expect(click({ ...at(), x: 500, y: 100 })).rejects.toThrow(
    "x 500 is outside the 320x240 screen (x 0-319, y 0-239); no input was sent",
  );
  await expect(move({ ...at(), x: 100, y: 240 })).rejects.toThrow("y 240 is outside the 320x240 screen");
  expect(pointer()).toBe("X=100 Y=100");
  await click({ ...at(), x: 319, y: 239 });
  expect(pointer()).toBe("X=319 Y=239");
}, 30_000);

it.skipIf(!available)("refuses points past the real edge when the record holds a larger size", async () => {
  const desktop = (await getSession(session.id, env))!.desktop!;
  await updateSession(session.id, { desktop: { ...desktop, width: 40000, height: 40000 } }, env);
  await move({ ...at(), x: 100, y: 100 });
  for (const [x, y, label] of [[32768, 100, "x 32768"], [640, 0, "x 640"], [0, 480, "y 480"]] as const) {
    await expect(click({ ...at(), x, y })).rejects.toThrow(`${label} is outside the 640x480 screen`);
  }
  expect(pointer()).toBe("X=100 Y=100");
  await click({ ...at(), x: 639, y: 479 });
  expect(pointer()).toBe("X=639 Y=479");
}, 30_000);

it.skipIf(!available)("refuses pointer input when the screen size cannot be read", async () => {
  await move({ ...at(), x: 100, y: 100 });
  const pid = (await getSession(session.id, env))!.desktop!.xvfbPid!;
  // A stopped server still passes the ownership check but never answers setup.
  process.kill(pid, "SIGSTOP");
  try {
    await expect(click({ ...at(), x: 1, y: 1 })).rejects.toThrow(
      "Desktop pointer input refused: the screen size could not be read; no input was sent",
    );
  } finally {
    process.kill(pid, "SIGCONT");
  }
  expect(pointer()).toBe("X=100 Y=100");
}, 30_000);
