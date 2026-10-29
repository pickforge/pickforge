import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createSession, getSession, processIdentityMatches, runCommand, type EnvLike } from "@pickforge/lab-core";
import {
  startXvfb, stopXvfb, findOnPath, screenshot, startNativeViewerHost, requestNativeViewerHost, stopSessionViewer, click,
  stopNativeViewerHost, type NativeViewerHostIdentity, type XvfbHandle,
} from "@pickforge/lab-desktop-linux";
import { unusedTestDisplay } from "../../desktop-linux/test/test-resources.js";
import { ensureCliBuilt } from "./build-once.js";
import { readViewerLines } from "../src/viewer/native-host.js";
import { nativeViewerVersion } from "../src/viewer/native.js";

const binary = findOnPath("pickforge-viewer");
const required = process.env.PICKFORGE_REQUIRE_VIEWER === "1";
const imageCommand = findOnPath("magick") ?? findOnPath("convert");
const missing = ["Xvfb", "xdotool", "xterm"].filter((name) => findOnPath(name) === null);
if (imageCommand === null) missing.push("ImageMagick");
let root: string | undefined;
let child: ChildProcess | undefined;
let terminal: ChildProcess | undefined;
const displays: XvfbHandle[] = [];
const viewerSessions: { id: string; env: EnvLike }[] = [];
afterEach(async () => {
  for (const { id, env } of viewerSessions.splice(0)) await stopSessionViewer(id, undefined, env);
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
  // A mapped window may not have painted yet (#456).
  expect(await paints(watched.display, "#179ac3", env), "Fixture must paint on the watched lab display").toBe(true);
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

/** The viewer window's title and geometry on the host display. */
async function viewerWindow(pid: number, env: NodeJS.ProcessEnv): Promise<{ title: string; geometry: string }> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const search = await runCommand("xdotool", ["search", "--onlyvisible", "--pid", String(pid)], { env });
    const id = search.ok ? search.stdout.trim().split("\n")[0] : undefined;
    if (id) {
      const title = await runCommand("xdotool", ["getwindowname", id], { env });
      const geometry = await runCommand("xdotool", ["getwindowgeometry", "--shell", id], { env });
      if (title.ok && geometry.ok) return { title: title.stdout.trim(), geometry: geometry.stdout.trim() };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No viewer window for pid ${pid}`);
}

async function viewerMode(host: NativeViewerHostIdentity): Promise<string | undefined> {
  const response = await requestNativeViewerHost(host, { op: "status" });
  return response.ok ? response.mode : undefined;
}

async function waitForMode(host: NativeViewerHostIdentity, mode: string): Promise<void> {
  await expect.poll(() => viewerMode(host), { timeout: 5_000 }).toBe(mode);
}

function alive(host: NativeViewerHostIdentity): boolean {
  return processIdentityMatches({ pid: host.pid, startTicks: host.startTicks }) &&
    processIdentityMatches({ pid: host.viewerPid, startTicks: host.viewerStartTicks });
}

it.skipIf(binary === null && !required)("two viewers expand, collapse and close on their own and show their session", async () => {
  expect(binary, "PICKFORGE_REQUIRE_VIEWER requires pickforge-viewer on PATH").not.toBeNull();
  expect(missing, "Live viewer dependencies must be present").toEqual([]);
  await ensureCliBuilt();
  const cliEntry = fileURLToPath(new URL("../dist/pickforge-lab.js", import.meta.url));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-viewer-pair-"));
  const hostDisplay = await startXvfb({ display: unusedTestDisplay(), logDir: root, width: 1280, height: 800, env: process.env });
  displays.push(hostDisplay);
  const env: NodeJS.ProcessEnv = { ...process.env, PICKFORGE_HOME: root, DISPLAY: hostDisplay.display };
  delete env.WAYLAND_DISPLAY;
  delete env.HYPRLAND_INSTANCE_SIGNATURE;
  const sessions: { id: string; name: string; display: XvfbHandle }[] = [];
  for (const name of ["alpha", "beta"]) {
    const projectDir = path.join(root, name);
    fs.mkdirSync(projectDir);
    const display = await startXvfb({ display: unusedTestDisplay(), logDir: projectDir, width: 640, height: 480, env });
    displays.push(display);
    const { id } = await createSession({ type: "desktop", status: "running", projectDir,
      desktop: { display: display.display, xvfbPid: display.pid, xvfbStartTimeTicks: display.startTimeTicks, width: 640, height: 480, homePolicy: "private" } }, env);
    viewerSessions.push({ id, env });
    sessions.push({ id, name, display });
  }
  const [a, b] = await Promise.all(sessions.map(({ id }) =>
    startNativeViewerHost({ sessionId: id, cliEntry, binary: binary!, version: nativeViewerVersion, env })));
  for (const [index, host] of [a!, b!].entries()) {
    const { id, name } = sessions[index]!;
    expect((await viewerWindow(host.viewerPid, env)).title).toBe(`${id} \u00b7 ${name} \u00b7 Pickforge viewer`);
    await waitForMode(host, "thumbnail");
  }
  const bBefore = await viewerWindow(b!.viewerPid, env);
  const aThumbnail = await viewerWindow(a!.viewerPid, env);

  await requestNativeViewerHost(a!, { op: "expand" });
  await waitForMode(a!, "expanded");
  await expect.poll(async () => (await viewerWindow(a!.viewerPid, env)).geometry, { timeout: 5_000 }).not.toBe(aThumbnail.geometry);
  expect(await viewerMode(b!)).toBe("thumbnail");
  expect(await viewerWindow(b!.viewerPid, env)).toEqual(bBefore);

  await requestNativeViewerHost(a!, { op: "collapse" });
  await waitForMode(a!, "thumbnail");
  expect(await viewerMode(b!)).toBe("thumbnail");
  expect(await viewerWindow(b!.viewerPid, env)).toEqual(bBefore);

  await stopNativeViewerHost(sessions[0]!.id, env);
  expect(processIdentityMatches({ pid: a!.viewerPid, startTicks: a!.viewerStartTicks })).toBe(false);
  expect(alive(b!)).toBe(true);
  expect(await viewerMode(b!)).toBe("thumbnail");
  expect(await viewerWindow(b!.viewerPid, env)).toEqual(bBefore);
  for (const { id, display } of sessions) {
    expect((await getSession(id, env))?.status).toBe("running");
    expect(processIdentityMatches({ pid: display.pid, startTicks: display.startTimeTicks })).toBe(true);
  }

  await stopNativeViewerHost(sessions[1]!.id, env);
  expect(alive(b!)).toBe(false);
  expect((await getSession(sessions[1]!.id, env))?.status).toBe("running");
}, 60_000);

/** True once a screenshot of `display` holds `color`, within ten seconds. */
async function paints(display: string, color: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const file = path.join(root!, "fixture.png");
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    await screenshot({ display, outPath: file, env, countWindows: false });
    const pixels = await runCommand(imageCommand!, [file, "-format", "%c", "histogram:info:"], { env });
    if (pixels.ok && pixels.stdout.toLowerCase().includes(color)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** True when the PNG holds an ember pixel, at any opacity over the black session. */
async function hasEmber(file: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const histogram = await runCommand(imageCommand!, [file, "-format", "%c", "histogram:info:"], { env });
  expect(histogram.ok).toBe(true);
  return [...histogram.stdout.matchAll(/#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})(?:[0-9A-F]{2})?\b/gi)].some((match) => {
    const [r, g, b] = match.slice(1, 4).map((hex) => Number.parseInt(hex!, 16)) as [number, number, number];
    return r >= 0x99 && Math.abs(g / r - 0x7a / 0xff) < 0.08 && b < 0x50;
  });
}

/** A hash of the decoded pixels only, so PNG metadata cannot differ. */
async function pixelHash(file: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand(imageCommand!, [file, "-format", "%#", "info:"], { env });
  expect(result.ok).toBe(true);
  return result.stdout.trim();
}

it.skipIf(binary === null && !required)("a click pulse shows in the viewer and never in session captures", async () => {
  expect(binary, "PICKFORGE_REQUIRE_VIEWER requires pickforge-viewer on PATH").not.toBeNull();
  expect(missing, "Live viewer dependencies must be present").toEqual([]);
  await ensureCliBuilt();
  const cliEntry = fileURLToPath(new URL("../dist/pickforge-lab.js", import.meta.url));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-viewer-pulse-"));
  const hostDisplay = await startXvfb({ display: unusedTestDisplay(), logDir: root, width: 1280, height: 800, env: process.env });
  displays.push(hostDisplay);
  const env: NodeJS.ProcessEnv = { ...process.env, PICKFORGE_HOME: root, DISPLAY: hostDisplay.display };
  delete env.WAYLAND_DISPLAY;
  delete env.HYPRLAND_INSTANCE_SIGNATURE;
  const watched = await startXvfb({ display: unusedTestDisplay(), logDir: root, width: 640, height: 480, env });
  displays.push(watched);
  const { id } = await createSession({ type: "desktop", status: "running", projectDir: root,
    desktop: { display: watched.display, xvfbPid: watched.pid, xvfbStartTimeTicks: watched.startTimeTicks, width: 640, height: 480, homePolicy: "private" } }, env);
  viewerSessions.push({ id, env });
  const point = { display: watched.display, sessionId: id, x: 320, y: 240, env };
  const sessionShot = async (name: string): Promise<string> => {
    const file = path.join(root!, name);
    await screenshot({ display: watched.display, outPath: file, env, countWindows: false });
    return file;
  };
  const hostShot = async (name: string): Promise<string> => {
    const file = path.join(root!, name);
    await screenshot({ display: hostDisplay.display, outPath: file, env, countWindows: false });
    return file;
  };

  await click(point);
  const withoutViewer = await pixelHash(await sessionShot("without-viewer.png"), env);
  const host = await startNativeViewerHost({ sessionId: id, cliEntry, binary: binary!, version: nativeViewerVersion, env });
  await waitForMode(host, "thumbnail");
  expect(await hasEmber(await hostShot("idle.png"), env)).toBe(false);

  // A loaded machine can miss the 500 ms ring, so a few clicks may try.
  let seen = false;
  for (let attempt = 0; attempt < 5 && !seen; attempt++) {
    await click(point);
    const [viewer, session] = await Promise.all([hostShot(`pulse-${attempt}.png`), sessionShot(`session-${attempt}.png`)]);
    seen = await hasEmber(viewer, env);
    expect(await pixelHash(session, env)).toBe(withoutViewer);
    expect(await hasEmber(session, env)).toBe(false);
  }
  expect(seen, "The viewer must show the pulse").toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(await hasEmber(await hostShot("after.png"), env)).toBe(false);
  expect(await pixelHash(await sessionShot("after-session.png"), env)).toBe(withoutViewer);
}, 60_000);

