import fs from "node:fs";
import path from "node:path";
import {
  runCommand,
  type EnvLike,
  type RunCommandResult,
} from "@pickforge/lab-core";
import { findSdkTool } from "./sdk.js";
import { sleep } from "./util.js";

export const KEYCODE_HOME = "KEYCODE_HOME";
export const KEYCODE_BACK = "KEYCODE_BACK";
export const UI_DUMP_REMOTE_PATH = "/sdcard/pickforge-lab-ui.xml";

const SERIAL_PATTERN = /^[A-Za-z0-9._:-]+$/;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const ACTIVITY_PATTERN = /^\.?[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const KEYCODE_PATTERN = /^(KEYCODE_[A-Z0-9_]+|\d+)$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ADB_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 300_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;
const SCREENSHOT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_LOGCAT_LINES = 500;
const DEFAULT_UI_DUMP_ATTEMPTS = 15;
const DEFAULT_UI_DUMP_RETRY_DELAY_MS = 2_000;

export interface AdbTargetOptions {
  serial: string;
  sdk?: string | null;
  env?: EnvLike;
}

export interface AdbDevice {
  serial: string;
  state: string;
}

export function assertSerial(serial: string): void {
  if (!SERIAL_PATTERN.test(serial)) {
    throw new Error(
      `Invalid device serial "${serial}": expected only letters, digits, ` +
        `dots, colons, underscores, and hyphens`,
    );
  }
}

export function assertPackageName(packageName: string): void {
  if (!PACKAGE_PATTERN.test(packageName)) {
    throw new Error(
      `Invalid package name "${packageName}": expected a Java package ` +
        `like "com.example.app"`,
    );
  }
}

function assertActivity(activity: string): void {
  if (!ACTIVITY_PATTERN.test(activity)) {
    throw new Error(
      `Invalid activity "${activity}": expected a class name like ` +
        `".MainActivity" or "com.example.app.MainActivity"`,
    );
  }
}

function assertCoordinate(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid ${label} coordinate ${value}: expected a non-negative integer`,
    );
  }
}

export function resolveAdb(
  opts: { sdk?: string | null; env?: EnvLike } = {},
): string {
  const adb = findSdkTool(opts.sdk, "adb", opts.env ?? process.env);
  if (adb === null) {
    throw new Error(
      "adb not found in <sdk>/platform-tools or on PATH; install it with: " +
        'sdkmanager "platform-tools" (or your distro\'s android-tools package)',
    );
  }
  return adb;
}

export function escapeInputText(text: string): string {
  return text
    .replace(/[\\()<>|;&*~"'`$]/g, (c) => `\\${c}`)
    .replace(/ /g, "%s");
}

export function splitInputText(text: string): string[] {
  return text.split(/(?<=%)(?=s)/);
}

export function buildInstallApkArgs(serial: string, apkPath: string): string[] {
  assertSerial(serial);
  if (apkPath === "") {
    throw new Error("Invalid apkPath: expected a non-empty path");
  }
  return ["-s", serial, "install", "-r", apkPath];
}

export function buildLaunchAppArgs(
  serial: string,
  packageName: string,
  activity?: string,
): string[] {
  assertSerial(serial);
  assertPackageName(packageName);
  if (activity !== undefined) {
    assertActivity(activity);
    return [
      "-s",
      serial,
      "shell",
      "am",
      "start",
      "-n",
      `${packageName}/${activity}`,
    ];
  }
  return [
    "-s",
    serial,
    "shell",
    "monkey",
    "-p",
    packageName,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ];
}

export function buildScreenshotArgs(serial: string): string[] {
  assertSerial(serial);
  return ["-s", serial, "exec-out", "screencap", "-p"];
}

export function buildTapArgs(serial: string, x: number, y: number): string[] {
  assertSerial(serial);
  assertCoordinate(x, "x");
  assertCoordinate(y, "y");
  return ["-s", serial, "shell", "input", "tap", String(x), String(y)];
}

export function buildTypeTextArgs(serial: string, text: string): string[] {
  assertSerial(serial);
  if (text === "") {
    throw new Error("Invalid text: expected a non-empty string");
  }
  if (/[\x00-\x1f\x7f]/.test(text)) {
    throw new Error(
      "Invalid text: control characters (including newlines) are not " +
        "supported by android input text",
    );
  }
  if (/[^\x20-\x7e]/.test(text)) {
    throw new Error(
      "Invalid text: non-ASCII characters cannot be typed with android " +
        '"input text"; use ASCII text, or set the field content through ' +
        "the app itself (clipboard or deep link)",
    );
  }
  if (text.includes("%s")) {
    throw new Error(
      'Invalid text: the device input tool turns "%s" into a space; ' +
        "use typeText, which splits such text into safe chunks",
    );
  }
  return ["-s", serial, "shell", "input", "text", escapeInputText(text)];
}

export function buildKeyeventArgs(serial: string, key: string): string[] {
  assertSerial(serial);
  if (!KEYCODE_PATTERN.test(key)) {
    throw new Error(
      `Invalid key "${key}": expected a KEYCODE_* name or a numeric keycode`,
    );
  }
  return ["-s", serial, "shell", "input", "keyevent", key];
}

export function buildUiDumpArgs(serial: string): string[] {
  assertSerial(serial);
  return ["-s", serial, "shell", "uiautomator", "dump", UI_DUMP_REMOTE_PATH];
}

export function buildUiCatArgs(serial: string): string[] {
  assertSerial(serial);
  return ["-s", serial, "exec-out", "cat", UI_DUMP_REMOTE_PATH];
}

export function buildUiCleanupArgs(serial: string): string[] {
  assertSerial(serial);
  return ["-s", serial, "shell", "rm", "-f", UI_DUMP_REMOTE_PATH];
}

export interface LogcatArgsOptions {
  lines?: number;
  filter?: string;
}

export function buildLogcatArgs(
  serial: string,
  opts: LogcatArgsOptions = {},
): string[] {
  assertSerial(serial);
  const lines = opts.lines ?? DEFAULT_LOGCAT_LINES;
  if (!Number.isInteger(lines) || lines <= 0) {
    throw new Error(`Invalid lines ${lines}: expected a positive integer`);
  }
  const args = ["-s", serial, "logcat", "-d", "-t", String(lines)];
  if (opts.filter !== undefined && opts.filter.trim() !== "") {
    args.push(...opts.filter.trim().split(/\s+/));
  }
  return args;
}

export function buildClearLogcatArgs(serial: string): string[] {
  assertSerial(serial);
  return ["-s", serial, "logcat", "-c"];
}

export function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed === "" ||
      trimmed.startsWith("List of devices") ||
      trimmed.startsWith("*")
    ) {
      continue;
    }
    const [serial, state] = trimmed.split(/\s+/);
    if (
      serial !== undefined &&
      state !== undefined &&
      SERIAL_PATTERN.test(serial)
    ) {
      devices.push({ serial, state });
    }
  }
  return devices;
}

interface ExecAdbRunOptions {
  timeoutMs?: number;
  binary?: boolean;
  maxOutputBytes?: number;
}

async function execAdb(
  opts: { sdk?: string | null; env?: EnvLike },
  args: string[],
  runOpts: ExecAdbRunOptions & { binary: true },
): Promise<RunCommandResult & { stdoutBuffer: Buffer }>;
async function execAdb(
  opts: { sdk?: string | null; env?: EnvLike },
  args: string[],
  runOpts?: ExecAdbRunOptions,
): Promise<RunCommandResult>;
async function execAdb(
  opts: { sdk?: string | null; env?: EnvLike },
  args: string[],
  runOpts: ExecAdbRunOptions = {},
): Promise<RunCommandResult> {
  const adb = resolveAdb(opts);
  const baseOpts = {
    env: opts.env,
    timeoutMs: runOpts.timeoutMs ?? ADB_TIMEOUT_MS,
    maxOutputBytes: runOpts.maxOutputBytes,
  };
  if (runOpts.binary === true) {
    return runCommand(adb, args, { ...baseOpts, binary: true });
  }
  return runCommand(adb, args, baseOpts);
}

function commandFailure(
  what: string,
  args: readonly string[],
  result: RunCommandResult,
): Error {
  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    (result.timedOut ? "timed out" : `exit code ${result.code}`);
  return new Error(`${what} failed (adb ${args.join(" ")}): ${detail}`);
}

export async function listDevices(
  opts: { sdk?: string | null; env?: EnvLike } = {},
): Promise<AdbDevice[]> {
  const result = await execAdb(opts, ["devices"]);
  if (!result.ok) {
    throw commandFailure("adb devices", ["devices"], result);
  }
  return parseAdbDevices(result.stdout);
}

export async function installApk(
  opts: AdbTargetOptions & { apkPath: string },
): Promise<void> {
  const args = buildInstallApkArgs(opts.serial, opts.apkPath);
  const result = await execAdb(opts, args, { timeoutMs: INSTALL_TIMEOUT_MS });
  if (!result.ok || /Failure/.test(result.stdout)) {
    throw commandFailure(`apk install of ${opts.apkPath}`, args, result);
  }
}

export async function launchApp(
  opts: AdbTargetOptions & { packageName: string; activity?: string },
): Promise<void> {
  const args = buildLaunchAppArgs(opts.serial, opts.packageName, opts.activity);
  const result = await execAdb(opts, args);
  if (
    !result.ok ||
    /^Error/m.test(result.stdout) ||
    /monkey aborted/i.test(result.stdout) ||
    /monkey aborted/i.test(result.stderr)
  ) {
    throw commandFailure(`launch of ${opts.packageName}`, args, result);
  }
}

export async function screenshot(
  opts: AdbTargetOptions & { outPath: string },
): Promise<{ path: string }> {
  const args = buildScreenshotArgs(opts.serial);
  const result = await execAdb(opts, args, {
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    binary: true,
    maxOutputBytes: SCREENSHOT_MAX_BYTES,
  });
  if (!result.ok) {
    throw commandFailure("screenshot", args, result);
  }
  if (result.stdoutTruncated) {
    throw new Error(
      `screenshot output exceeded ${SCREENSHOT_MAX_BYTES} bytes and was truncated`,
    );
  }
  const data = result.stdoutBuffer;
  if (data.length < PNG_MAGIC.length || !data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new Error(
      `screencap on ${opts.serial} did not produce a PNG image ` +
        `(got ${data.length} bytes)`,
    );
  }
  await fs.promises.mkdir(path.dirname(opts.outPath), { recursive: true });
  await fs.promises.writeFile(opts.outPath, data);
  return { path: opts.outPath };
}

export async function tap(
  opts: AdbTargetOptions & { x: number; y: number },
): Promise<void> {
  const args = buildTapArgs(opts.serial, opts.x, opts.y);
  const result = await execAdb(opts, args);
  if (!result.ok) {
    throw commandFailure(`tap at (${opts.x}, ${opts.y})`, args, result);
  }
}

export async function typeText(
  opts: AdbTargetOptions & { text: string },
): Promise<void> {
  for (const chunk of splitInputText(opts.text)) {
    const args = buildTypeTextArgs(opts.serial, chunk);
    const result = await execAdb(opts, args);
    if (!result.ok) {
      throw commandFailure("text input", args, result);
    }
  }
}

export async function pressKey(
  opts: AdbTargetOptions & { key: string },
): Promise<void> {
  const args = buildKeyeventArgs(opts.serial, opts.key);
  const result = await execAdb(opts, args);
  if (!result.ok) {
    throw commandFailure(`keyevent ${opts.key}`, args, result);
  }
}

export async function back(opts: AdbTargetOptions): Promise<void> {
  await pressKey({ ...opts, key: KEYCODE_BACK });
}

export async function home(opts: AdbTargetOptions): Promise<void> {
  await pressKey({ ...opts, key: KEYCODE_HOME });
}

async function dumpUiTreeOnce(opts: AdbTargetOptions): Promise<string> {
  const dumpArgs = buildUiDumpArgs(opts.serial);
  const dumpResult = await execAdb(opts, dumpArgs);
  if (
    !dumpResult.ok ||
    /ERROR/i.test(dumpResult.stderr) ||
    /ERROR/.test(dumpResult.stdout)
  ) {
    throw commandFailure("uiautomator dump", dumpArgs, dumpResult);
  }
  try {
    const catArgs = buildUiCatArgs(opts.serial);
    const catResult = await execAdb(opts, catArgs);
    if (!catResult.ok) {
      throw commandFailure("ui tree read", catArgs, catResult);
    }
    const xml = catResult.stdout.trim();
    if (!xml.startsWith("<?xml") && !xml.startsWith("<hierarchy")) {
      throw new Error(
        `uiautomator dump on ${opts.serial} did not return XML: ` +
          `${xml.slice(0, 120)}`,
      );
    }
    return xml;
  } finally {
    await execAdb(opts, buildUiCleanupArgs(opts.serial)).catch(() => {});
  }
}

export interface GetUiTreeOptions extends AdbTargetOptions {
  attempts?: number;
  retryDelayMs?: number;
}

export async function getUiTree(opts: GetUiTreeOptions): Promise<string> {
  const attempts = opts.attempts ?? DEFAULT_UI_DUMP_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts <= 0) {
    throw new Error(`Invalid attempts ${attempts}: expected a positive integer`);
  }
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_UI_DUMP_RETRY_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await dumpUiTreeOnce(opts);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await sleep(retryDelayMs);
      }
    }
  }
  throw lastError;
}

export async function logcat(
  opts: AdbTargetOptions & LogcatArgsOptions,
): Promise<string> {
  const args = buildLogcatArgs(opts.serial, {
    lines: opts.lines,
    filter: opts.filter,
  });
  const result = await execAdb(opts, args);
  if (!result.ok) {
    throw commandFailure("logcat", args, result);
  }
  return result.stdout;
}

export async function clearLogcat(opts: AdbTargetOptions): Promise<void> {
  const args = buildClearLogcatArgs(opts.serial);
  const result = await execAdb(opts, args);
  if (!result.ok) {
    throw commandFailure("logcat clear", args, result);
  }
}

export async function runAdb(
  opts: {
    serial?: string;
    args: readonly string[];
    sdk?: string | null;
    env?: EnvLike;
    timeoutMs?: number;
  },
): Promise<RunCommandResult> {
  const args = [...opts.args];
  if (opts.serial !== undefined) {
    assertSerial(opts.serial);
    args.unshift("-s", opts.serial);
  }
  return execAdb(opts, args, { timeoutMs: opts.timeoutMs });
}
