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
    env: { ANDROID_HOME: opts.sdk, ANDROID_SDK_ROOT: opts.sdk, ...opts.env },
    input: "no\n",
    timeoutMs: opts.timeoutMs ?? CREATE_AVD_TIMEOUT_MS,
  });
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    let message = `avdmanager create avd failed for "${name}": ${detail}`;
    if (/package path is not valid|no suitable|not installed/i.test(detail)) {
      message += `. If the system image is missing, install it with: ${sdkmanagerInstallCommand(opts.systemImage)}`;
    }
    throw new Error(message);
  }
  return { name, systemImage: opts.systemImage };
}

export function avdHomeDir(env: EnvLike = process.env): string {
  const fromEnv = env.ANDROID_AVD_HOME;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : os.homedir();
  return path.join(home, ".android", "avd");
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
        env: opts.env,
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
