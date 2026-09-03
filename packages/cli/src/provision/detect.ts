import fs from "node:fs";
import {
  detectAndroidEnvironment,
  findOnPath,
  listAvds,
  type KvmStatus,
  type SdkToolPaths,
  type SystemImage,
} from "@pickforge/lab-android";
import {
  legacyPickforgeHome,
  loadConfig,
  picklabHome,
  readPickforgeEnv,
  resolvedDefaults,
  resolveRunStorage,
  runCommand,
  type EnvLike,
  type PickforgeProfile,
} from "@pickforge/lab-core";
import {
  detectScreenshotTool,
  detectVncBinary,
} from "@pickforge/lab-desktop-linux";

export interface DetectionSnapshot {
  picklabHome: { path: string; exists: boolean; writable: boolean };
  /** Present only when the pre-#34 `~/.picklab` root still exists and
   * differs from the current default (never when `PICKFORGE_HOME` is set
   * explicitly — that is the user's own root, not a legacy one). */
  legacyHome: { path: string } | null;
  config: { ok: boolean; error: string | null; profile: PickforgeProfile | null };
  /** Present when the project-committed `.picklab/config.json` requested
   * `storage.mode: "custom"` and the resolver rejected it (repo config
   * cannot select custom storage) and fell back to the next layer. */
  storage: { rejectedProjectCustom: { requestedPath?: string } | null };
  desktop: {
    xvfb: string | null;
    xdotool: string | null;
    screenshotTool: string | null;
    x11vnc: string | null;
  };
  android: {
    sdkRoot: string | null;
    tools: SdkToolPaths;
    systemImages: SystemImage[];
    kvm: KvmStatus;
    avdName: string;
    avds: string[];
    avdExists: boolean;
  };
  labUser: {
    name: string;
    home: string;
    exists: boolean;
    homeExists: boolean;
  };
  sudo: string | null;
}

export interface CollectSnapshotOptions {
  env?: EnvLike;
  projectDir?: string;
  avdName?: string;
  labUserName?: string;
  labUserHome?: string;
}

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isWritable(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function labUserExists(
  name: string,
  env: EnvLike = process.env,
): Promise<boolean> {
  try {
    const result = await runCommand("getent", ["passwd", "--", name], {
      env,
      timeoutMs: 10_000,
    });
    if (!result.ok) {
      return false;
    }
    return result.stdout
      .split("\n")
      .some((line) => line.split(":")[0] === name);
  } catch {
    return false;
  }
}

// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export async function collectSnapshot(
  opts: CollectSnapshotOptions = {},
): Promise<DetectionSnapshot> {
  const env = opts.env ?? process.env;
  const projectDir = opts.projectDir ?? process.cwd();

  let config: DetectionSnapshot["config"] = {
    ok: true,
    error: null,
    profile: null,
  };
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig(projectDir, env);
    config = { ok: true, error: null, profile: loaded.profile ?? null };
  } catch (error) {
    loaded = { ...resolvedDefaults };
    config = { ok: false, error: (error as Error).message, profile: null };
  }

  const avdName =
    opts.avdName ?? loaded.android?.avdName ?? resolvedDefaults.android.avdName;
  const labUserName =
    opts.labUserName ?? loaded.labUser?.name ?? resolvedDefaults.labUser.name;
  const labUserHome =
    opts.labUserHome ?? loaded.labUser?.home ?? resolvedDefaults.labUser.home;

  const homePath = picklabHome(env);
  const homeExists = dirExists(homePath);
  const legacyPath = legacyPickforgeHome(env);
  const legacyHome =
    legacyPath !== undefined && legacyPath !== homePath && dirExists(legacyPath)
      ? { path: legacyPath }
      : null;

  let rejectedProjectCustom: { requestedPath?: string } | null = null;
  try {
    const resolvedStorage = await resolveRunStorage(projectDir, env);
    rejectedProjectCustom = resolvedStorage.rejectedProjectCustom ?? null;
  } catch {
    // A resolver error (e.g. a broken global/env custom path) is not this
    // check's concern; it surfaces wherever storage is actually resolved for
    // a run.
  }

  const kvmPath = readPickforgeEnv(env, "KVM_PATH");
  const androidEnv = detectAndroidEnvironment({
    env,
    homeDir: env.HOME !== undefined && env.HOME !== "" ? env.HOME : undefined,
    kvmPath: kvmPath !== undefined && kvmPath !== "" ? kvmPath : undefined,
  });
  const avds = await listAvds({ sdk: androidEnv.sdkRoot, env });

  return {
    picklabHome: {
      path: homePath,
      exists: homeExists,
      writable: homeExists && isWritable(homePath),
    },
    legacyHome,
    config,
    storage: { rejectedProjectCustom },
    desktop: {
      xvfb: findOnPath("Xvfb", env),
      xdotool: findOnPath("xdotool", env),
      screenshotTool: detectScreenshotTool(env),
      x11vnc: detectVncBinary(env),
    },
    android: {
      ...androidEnv,
      avdName,
      avds,
      avdExists: avds.includes(avdName),
    },
    labUser: {
      name: labUserName,
      home: labUserHome,
      exists: await labUserExists(labUserName, env),
      homeExists: dirExists(labUserHome),
    },
    sudo: findOnPath("sudo", env),
  };
}
