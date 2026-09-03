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
  legacyPickforgeHomes,
  loadConfig,
  pickforgeHome,
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
  pickforgeHome: { path: string; exists: boolean; writable: boolean };
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

interface ConfigDetection {
  config: DetectionSnapshot["config"];
  loaded: Awaited<ReturnType<typeof loadConfig>>;
}

async function detectConfig(
  projectDir: string,
  env: EnvLike,
): Promise<ConfigDetection> {
  try {
    const loaded = await loadConfig(projectDir, env);
    return {
      loaded,
      config: { ok: true, error: null, profile: loaded.profile ?? null },
    };
  } catch (error) {
    return {
      loaded: { ...resolvedDefaults },
      config: { ok: false, error: (error as Error).message, profile: null },
    };
  }
}

function detectLegacyHome(
  homePath: string,
  env: EnvLike,
): { path: string } | null {
  const legacyPath = legacyPickforgeHomes(env).find(
    (candidate) => candidate !== homePath && dirExists(candidate),
  );
  return legacyPath === undefined ? null : { path: legacyPath };
}

async function detectRejectedProjectCustom(
  projectDir: string,
  env: EnvLike,
): Promise<{ requestedPath?: string } | null> {
  try {
    const resolvedStorage = await resolveRunStorage(projectDir, env);
    return resolvedStorage.rejectedProjectCustom ?? null;
  } catch {
    return null;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export async function collectSnapshot(
  opts: CollectSnapshotOptions = {},
): Promise<DetectionSnapshot> {
  const env = opts.env ?? process.env;
  const projectDir = opts.projectDir ?? process.cwd();
  const { config, loaded } = await detectConfig(projectDir, env);

  const avdName =
    opts.avdName ?? loaded.android?.avdName ?? resolvedDefaults.android.avdName;
  const labUserName =
    opts.labUserName ?? loaded.labUser?.name ?? resolvedDefaults.labUser.name;
  const labUserHome =
    opts.labUserHome ?? loaded.labUser?.home ?? resolvedDefaults.labUser.home;

  const homePath = pickforgeHome(env);
  const homeExists = dirExists(homePath);
  const legacyHome = detectLegacyHome(homePath, env);
  const rejectedProjectCustom = await detectRejectedProjectCustom(
    projectDir,
    env,
  );

  const androidEnv = detectAndroidEnvironment({
    env,
    homeDir: nonEmpty(env.HOME),
    kvmPath: nonEmpty(readPickforgeEnv(env, "KVM_PATH")),
  });
  const avds = await listAvds({ sdk: androidEnv.sdkRoot, env });

  return {
    pickforgeHome: {
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
