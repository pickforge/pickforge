import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { createSession, runCommand } from "@pickforge/lab-core";
import { startXvfb, stopXvfb, findOnPath, screenshot, type XvfbHandle } from "@pickforge/lab-desktop-linux";
import { unusedTestDisplay } from "../../desktop-linux/test/test-resources.js";
import { readViewerLines } from "../src/viewer/native-host.js";

const binary = findOnPath("pickforge-viewer");
const required = process.env.PICKFORGE_REQUIRE_VIEWER === "1";
const imageCommand = findOnPath("magick") ?? findOnPath("convert");
const missing = ["Xvfb", "xdotool", "xterm"].filter((name) => findOnPath(name) === null);
if (imageCommand === null) missing.push("ImageMagick");
let root: string | undefined;
let child: ChildProcess | undefined;
let terminal: ChildProcess | undefined;
const displays: XvfbHandle[] = [];
afterEach(async () => {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  if (terminal !== undefined && terminal.exitCode === null && terminal.signalCode === null) {
    const exited = once(terminal, "exit");
    terminal.kill("SIGKILL");
    await exited;
  }
  for (const display of displays.splice(0)) await stopXvfb(display.pid, display.startTimeTicks);
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

it.skipIf(binary === null && !required)("real viewer draws the watched frame on a second explicit lab display", async () => {
  expect(binary, "PICKFORGE_REQUIRE_VIEWER requires pickforge-viewer on PATH").not.toBeNull();
  expect(missing, "Live viewer dependencies must be present").toEqual([]);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-viewer-live-"));
  const env = { ...process.env, PICKFORGE_HOME: root };
  for (const name of ["watched", "host"]) {
    const logDir = path.join(root, name);
    fs.mkdirSync(logDir);
    const display = await startXvfb({ display: unusedTestDisplay(), logDir, width: 640, height: 480, env });
    displays.push(display);
    await createSession({ type: "desktop", status: "running", projectDir: root,
      desktop: { display: display.display, xvfbPid: display.pid, xvfbStartTimeTicks: display.startTimeTicks, width: 640, height: 480 } }, env);
  }
  const [watched, host] = displays;
  terminal = spawn("xterm", ["-display", watched.display, "-bg", "#179ac3", "-fg", "#179ac3", "-geometry", "80x24+0+0", "-e", process.execPath, "-e", "setInterval(() => {}, 1000)"], { env, stdio: "ignore" });
  await once(terminal, "spawn");
  let mapped = false;
  for (let attempt = 0; attempt < 100 && !mapped; attempt++) {
    const windows = await runCommand("xdotool", ["search", "--pid", String(terminal.pid)], { env: { ...env, DISPLAY: watched.display } });
    mapped = windows.ok && windows.stdout.trim() !== "";
    if (!mapped) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(mapped, "Fixture must map on the watched lab display").toBe(true);
  child = spawn("env", ["-u", "WAYLAND_DISPLAY", `DISPLAY=${host.display}`, binary!,
    "--display", watched.display, "--xvfb-pid", String(watched.pid), "--xvfb-start-ticks", String(watched.startTimeTicks),
    "--width", "640", "--height", "480", "--class", "pickforge-viewer-00112233445566778899aabbccddeeff",
    "--thumbnail-width", "384", "--placement", "self"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Native viewer did not draw its first frame")), 10_000);
    const finish = (operation: () => void): void => { clearTimeout(timeout); operation(); };
    child!.once("error", (error) => finish(() => reject(error)));
    child!.once("exit", () => finish(() => reject(new Error("Viewer exited before ready"))));
    readViewerLines(child!.stdout!, (event) => {
      if (event.event === "ready") finish(() => resolve(event));
      if (event.event === "error") finish(() => reject(new Error("Viewer capture failed")));
    }, () => finish(() => reject(new Error("Invalid viewer framing"))));
  });
  expect(ready).toMatchObject({ event: "ready", backend: "x11", pid: child.pid });
  const output = path.join(root, "viewer.png");
  await screenshot({ display: host.display, outPath: output, env, countWindows: false });
  const pixels = await runCommand(imageCommand!, [output, "-format", "%c", "histogram:info:"], { env });
  expect(pixels.ok).toBe(true);
  expect(pixels.stdout.toLowerCase()).toContain("#179ac3");
}, 30_000);
