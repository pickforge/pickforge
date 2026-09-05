import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, type EnvLike } from "@pickforge/lab-core";
import {
  assertSystemImageId,
  findSdkTool,
  sdkmanagerInstallCommand,
  systemImageInstalled,
} from "./sdk.js";

export const DEFAULT_AVD_NAME = "pickforge-avd";

const AVD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CREATE_AVD_TIMEOUT_MS = 120_000;
const LIST_AVDS_TIMEOUT_MS = 30_000;
const AVD_LOCK_FILE = "hardware-qemu.ini.lock";

export interface CreateAvdArgsOptions {
  name: string;
  systemImage: string;
  device?: string;
}

export interface CreateAvdOptions {
  name?: string;
  systemImage: string;
  device?: string;
  sdk: string;
  env?: EnvLike;
  timeoutMs?: number;
}

export interface CreateAvdResult {
  name: string;
  systemImage: string;
  iniPath: string;
}

export interface ListAvdsOptions {
  sdk?: string | null;
  env?: EnvLike;
}

export function assertAvdName(name: string): void {
  if (!AVD_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid AVD name "${name}": expected only letters, digits, ` +
        `dots, underscores, and hyphens`,
    );
  }
}

function assertDeviceProfile(device: string): void {
  if (device === "" || device.startsWith("-") || /[\x00-\x1f\x7f]/.test(device)) {
    throw new Error(
      `Invalid device profile "${device}": expected a non-empty avdmanager ` +
        `device id or name`,
    );
  }
}

export function buildCreateAvdArgs(opts: CreateAvdArgsOptions): string[] {
  assertAvdName(opts.name);
  assertSystemImageId(opts.systemImage);
  const args = ["create", "avd", "-n", opts.name, "-k", opts.systemImage];
  if (opts.device !== undefined) {
    assertDeviceProfile(opts.device);
    args.push("--device", opts.device);
  }
  return args;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

/** Emulator search order for the AVD directory, before `$HOME/.android/avd`. */
const AVD_HOME_SOURCES: ReadonlyArray<{ key: string; suffix: string[] }> = [
  { key: "ANDROID_AVD_HOME", suffix: [] },
  { key: "ANDROID_USER_HOME", suffix: ["avd"] },
  { key: "ANDROID_EMULATOR_HOME", suffix: ["avd"] },
  { key: "ANDROID_PREFS_ROOT", suffix: [".android", "avd"] },
  { key: "ANDROID_SDK_HOME", suffix: [".android", "avd"] },
];

/**
 * The single AVD directory Pickforge uses for both `avdmanager` and the
 * emulator. The two tools disagree on their defaults: `avdmanager` honours
 * `XDG_CONFIG_HOME` (writing to `$XDG_CONFIG_HOME/.android/avd`) while the
 * emulator only searches `$ANDROID_AVD_HOME`, `$ANDROID_SDK_HOME/avd` and
 * `$HOME/.android/avd`. Pickforge resolves one directory here and passes it
 * as `ANDROID_AVD_HOME` to every tool so an AVD created by one is found by
 * the other.
 */
export function avdHomeDir(env: EnvLike = process.env): string {
  for (const source of AVD_HOME_SOURCES) {
    const value = nonEmpty(env[source.key]);
    if (value !== undefined) {
      return path.join(value, ...source.suffix);
    }
  }
  const home = nonEmpty(env.HOME) ?? os.homedir();
  return path.join(home, ".android", "avd");
}

/** Environment that pins every SDK tool to the resolved AVD directory. */
export function avdToolEnv(env: EnvLike = process.env): EnvLike {
  return { ANDROID_AVD_HOME: avdHomeDir(env) };
}

export function avdIniPath(name: string, env: EnvLike = process.env): string {
  assertAvdName(name);
  return path.join(avdHomeDir(env), `${name}.ini`);
}

export function avdExists(name: string, env: EnvLike = process.env): boolean {
  try {
    return fs.statSync(avdIniPath(name, env)).isFile();
  } catch {
    return false;
  }
}

/** The AVD's data directory, from its `.ini` `path=` entry when present. */
export function avdDataDir(name: string, env: EnvLike = process.env): string {
  const iniPath = avdIniPath(name, env);
  try {
    const match = /^path=(.+)$/m.exec(fs.readFileSync(iniPath, "utf8"));
    if (match !== null && match[1] !== undefined && match[1].trim() !== "") {
      return match[1].trim();
    }
  } catch {
    // fall through to the conventional sibling directory
  }
  return path.join(avdHomeDir(env), `${name}.avd`);
}

export function avdLockPath(name: string, env: EnvLike = process.env): string {
  return path.join(avdDataDir(name, env), AVD_LOCK_FILE);
}

/**
 * The pid recorded in the emulator's own AVD lock file, or `null` when the
 * lock is absent or unreadable. The emulator writes this lock while it holds
 * the AVD's writable state; a live owner means a second writable instance
 * would be refused.
 */
export function readAvdLockOwner(
  name: string,
  env: EnvLike = process.env,
): number | null {
  try {
    const match = /^\s*(\d+)/.exec(fs.readFileSync(avdLockPath(name, env), "latin1"));
    if (match === null || match[1] === undefined) {
      return null;
    }
    const pid = Number(match[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function createAvdFailure(
  name: string,
  systemImage: string,
  detail: string,
): Error {
  let message = `avdmanager create avd failed for "${name}": ${detail}`;
  if (/package path is not valid|no suitable|not installed/i.test(detail)) {
    message += `. If the system image is missing, install it with: ${sdkmanagerInstallCommand(systemImage)}`;
  }
  return new Error(message);
}

export async function createAvd(
  opts: CreateAvdOptions,
): Promise<CreateAvdResult> {
  const name = opts.name ?? DEFAULT_AVD_NAME;
  const env = opts.env ?? process.env;
  const args = buildCreateAvdArgs({
    name,
    systemImage: opts.systemImage,
    device: opts.device,
  });

  if (!systemImageInstalled(opts.sdk, opts.systemImage)) {
    throw new Error(
      `System image "${opts.systemImage}" is not installed under ${opts.sdk}. ` +
        `Install it with: ${sdkmanagerInstallCommand(opts.systemImage)}`,
    );
  }

  const avdmanager = findSdkTool(opts.sdk, "avdmanager", env);
  if (avdmanager === null) {
    throw new Error(
      `avdmanager not found under ${opts.sdk} ` +
        "(looked in cmdline-tools/latest/bin and tools/bin) or on PATH; " +
        "install the Android command-line tools " +
        "(https://developer.android.com/studio#command-line)",
    );
  }

  const result = await runCommand(avdmanager, args, {
    env: {
      ANDROID_HOME: opts.sdk,
      ANDROID_SDK_ROOT: opts.sdk,
      ...avdToolEnv(env),
      ...opts.env,
    },
    input: "no\n",
    timeoutMs: opts.timeoutMs ?? CREATE_AVD_TIMEOUT_MS,
  });
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw createAvdFailure(name, opts.systemImage, detail);
  }
  const iniPath = avdIniPath(name, env);
  if (!avdExists(name, env)) {
    throw new Error(
      `avdmanager reported success for "${name}" but ${iniPath} does not exist, ` +
        `so the emulator cannot find it (it searches ${avdHomeDir(env)}). ` +
        "avdmanager writes under $XDG_CONFIG_HOME/.android when that variable " +
        "is set; set ANDROID_AVD_HOME for both tools or move the AVD there",
    );
  }
  return { name, systemImage: opts.systemImage, iniPath };
}

export function parseEmulatorListAvds(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => AVD_NAME_PATTERN.test(line));
}

export function scanAvdHome(env: EnvLike = process.env): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(avdHomeDir(env));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".ini"))
    .map((entry) => entry.slice(0, -".ini".length))
    .filter((name) => AVD_NAME_PATTERN.test(name))
    .sort();
}

export async function listAvds(opts: ListAvdsOptions = {}): Promise<string[]> {
  const env = opts.env ?? process.env;
  const emulator = findSdkTool(opts.sdk, "emulator", env);
  if (emulator !== null) {
    try {
      const result = await runCommand(emulator, ["-list-avds"], {
        env: { ...avdToolEnv(env), ...opts.env },
        timeoutMs: LIST_AVDS_TIMEOUT_MS,
      });
      if (result.ok) {
        return parseEmulatorListAvds(result.stdout);
      }
    } catch {
      // fall through to the AVD home scan
    }
  }
  return scanAvdHome(env);
}
