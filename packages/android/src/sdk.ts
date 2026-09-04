import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvLike } from "@pickforge/lab-core";
import { findOnPath, isExecutableFile } from "./util.js";

export type SdkToolName = "sdkmanager" | "avdmanager" | "emulator" | "adb";

export interface SdkToolPaths {
  sdkmanager: string | null;
  avdmanager: string | null;
  emulator: string | null;
  adb: string | null;
}

export interface DetectSdkRootOptions {
  env?: EnvLike;
  homeDir?: string;
  commonPaths?: readonly string[];
}

export interface SystemImage {
  packageId: string;
  api: string;
  tag: string;
  abi: string;
  path: string;
}

export interface KvmStatus {
  exists: boolean;
  readable: boolean;
  writable: boolean;
  supported: boolean;
}

export interface AndroidEnvironment {
  sdkRoot: string | null;
  tools: SdkToolPaths;
  systemImages: SystemImage[];
  kvm: KvmStatus;
}

const SYSTEM_IMAGE_ID_PATTERN = /^system-images;[^;\s]+;[^;\s]+;[^;\s]+$/;

const SDK_PACKAGE_ID_PATTERN =
  /^(?:platform-tools|emulator|cmdline-tools;(?:latest|\d+(?:\.\d+)*))$/;

const CMDLINE_TOOLS_VERSION_PATTERN = /^\d+(\.\d+)*$/;

export function commonSdkPaths(homeDir: string = os.homedir()): string[] {
  return [
    path.join(homeDir, "Android", "Sdk"),
    path.join(homeDir, "Library", "Android", "sdk"),
    path.join("/opt", "android-sdk"),
  ];
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function detectSdkRoot(opts: DetectSdkRootOptions = {}): string | null {
  const env = opts.env ?? process.env;
  for (const key of ["ANDROID_HOME", "ANDROID_SDK_ROOT"] as const) {
    const candidate = env[key];
    if (candidate !== undefined && candidate !== "" && isDirectory(candidate)) {
      return candidate;
    }
  }
  const candidates = opts.commonPaths ?? commonSdkPaths(opts.homeDir);
  for (const candidate of candidates) {
    if (isDirectory(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function missingSdkMessage(): string {
  return (
    "Android SDK not found. Set ANDROID_HOME (or ANDROID_SDK_ROOT) to your SDK " +
    "directory, or install it to one of: " +
    `${commonSdkPaths().join(", ")}. ` +
    'Set it with: export ANDROID_HOME="$HOME/Android/Sdk"; ' +
    'export ANDROID_SDK_ROOT="$ANDROID_HOME". ' +
    "See https://developer.android.com/studio#command-line for command-line tools."
  );
}

export function resolveSdkRoot(
  sdk: string | null | undefined,
  env: EnvLike = process.env,
): string | null {
  return sdk === undefined ? detectSdkRoot({ env }) : sdk;
}

function compareVersionsDesc(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function cmdlineToolsBinDirs(sdk: string): string[] {
  const root = path.join(sdk, "cmdline-tools");
  const dirs = [path.join(root, "latest", "bin")];
  const versioned = listSubdirs(root)
    .filter((name) => CMDLINE_TOOLS_VERSION_PATTERN.test(name))
    .sort(compareVersionsDesc);
  for (const version of versioned) {
    dirs.push(path.join(root, version, "bin"));
  }
  dirs.push(path.join(root, "bin"));
  return dirs;
}

function toolCandidateDirs(
  sdk: string,
  tool: Exclude<SdkToolName, "adb">,
): string[] {
  if (tool === "emulator") {
    return [path.join(sdk, "emulator")];
  }
  return [...cmdlineToolsBinDirs(sdk), path.join(sdk, "tools", "bin")];
}

export function findSdkTool(
  sdk: string | null | undefined,
  tool: SdkToolName,
  env: EnvLike = process.env,
): string | null {
  const root = resolveSdkRoot(sdk, env);
  if (tool === "adb") {
    if (root !== null) {
      const candidate = path.join(root, "platform-tools", "adb");
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
    return findOnPath("adb", env);
  }
  if (root === null) {
    return findOnPath(tool, env);
  }
  for (const dir of toolCandidateDirs(root, tool)) {
    const candidate = path.join(dir, tool);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return findOnPath(tool, env);
}

export function detectSdkTools(
  opts: { sdk?: string | null; env?: EnvLike } = {},
): SdkToolPaths {
  const env = opts.env ?? process.env;
  const sdk = resolveSdkRoot(opts.sdk, env);
  return {
    sdkmanager: findSdkTool(sdk, "sdkmanager", env),
    avdmanager: findSdkTool(sdk, "avdmanager", env),
    emulator: findSdkTool(sdk, "emulator", env),
    adb: findSdkTool(sdk, "adb", env),
  };
}

function listSubdirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name);
    } else if (
      entry.isSymbolicLink() &&
      isDirectory(path.join(dir, entry.name))
    ) {
      names.push(entry.name);
    }
  }
  return names;
}

export function listSystemImages(sdk: string): SystemImage[] {
  const root = path.join(sdk, "system-images");
  const images: SystemImage[] = [];
  for (const api of listSubdirs(root)) {
    for (const tag of listSubdirs(path.join(root, api))) {
      for (const abi of listSubdirs(path.join(root, api, tag))) {
        images.push({
          packageId: `system-images;${api};${tag};${abi}`,
          api,
          tag,
          abi,
          path: path.join(root, api, tag, abi),
        });
      }
    }
  }
  images.sort((a, b) => a.packageId.localeCompare(b.packageId));
  return images;
}

export function isValidSystemImageId(packageId: string): boolean {
  return SYSTEM_IMAGE_ID_PATTERN.test(packageId);
}

export function assertSystemImageId(packageId: string): void {
  if (!isValidSystemImageId(packageId)) {
    throw new Error(
      `Invalid system image "${packageId}": expected the form ` +
        `"system-images;android-<api>;<tag>;<abi>"`,
    );
  }
}

export function systemImageInstalled(sdk: string, packageId: string): boolean {
  assertSystemImageId(packageId);
  const [, api, tag, abi] = packageId.split(";") as [
    string,
    string,
    string,
    string,
  ];
  return isDirectory(path.join(sdk, "system-images", api, tag, abi));
}

export function sdkmanagerInstallCommand(packageId: string): string {
  assertSystemImageId(packageId);
  return `sdkmanager "${packageId}"`;
}

export function sdkmanagerPackageInstallCommand(packageId: string): string {
  if (!SDK_PACKAGE_ID_PATTERN.test(packageId)) {
    throw new Error(`Invalid Android SDK package "${packageId}"`);
  }
  return `sdkmanager "${packageId}"`;
}

export function detectKvm(kvmPath = "/dev/kvm"): KvmStatus {
  const exists = fs.existsSync(kvmPath);
  let readable = false;
  let writable = false;
  if (exists) {
    try {
      fs.accessSync(kvmPath, fs.constants.R_OK);
      readable = true;
    } catch {
      readable = false;
    }
    try {
      fs.accessSync(kvmPath, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
  }
  return { exists, readable, writable, supported: exists && readable && writable };
}

export function detectAndroidEnvironment(
  opts: DetectSdkRootOptions & { kvmPath?: string } = {},
): AndroidEnvironment {
  const sdkRoot = detectSdkRoot(opts);
  return {
    sdkRoot,
    tools: detectSdkTools({ sdk: sdkRoot, env: opts.env }),
    systemImages: sdkRoot === null ? [] : listSystemImages(sdkRoot),
    kvm: detectKvm(opts.kvmPath),
  };
}
