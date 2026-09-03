import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const distEntry = path.join(repoRoot, "packages", "cli", "dist", "pickforge-lab.js");
const lockDir = path.join(repoRoot, ".cli-build.lock");

const LOCK_STALE_MS = 300_000;
const LOCK_WAIT_MS = 300_000;
const BUILD_TIMEOUT_MS = 280_000;

function newestSourceMtimeMs(): number {
  let newest = 0;
  const visit = (target: string): void => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) {
        visit(path.join(target, entry));
      }
      return;
    }
    if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  };
  visit(path.join(repoRoot, "scripts"));
  const packagesDir = path.join(repoRoot, "packages");
  for (const entry of fs.readdirSync(packagesDir)) {
    visit(path.join(packagesDir, entry, "src"));
    visit(path.join(packagesDir, entry, "package.json"));
    visit(path.join(packagesDir, entry, "tsup.config.ts"));
  }
  return newest;
}

function distIsFresh(): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(distEntry);
  } catch {
    return false;
  }
  return stat.mtimeMs > newestSourceMtimeMs();
}

async function acquireLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    try {
      const age = Date.now() - fs.statSync(lockDir).mtimeMs;
      if (age > LOCK_STALE_MS) {
        fs.rmdirSync(lockDir);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for the CLI build lock at ${lockDir}`);
    }
    await sleep(250);
  }
}

export async function ensureCliBuilt(): Promise<void> {
  await acquireLock();
  try {
    if (distIsFresh()) {
      return;
    }
    const build = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: repoRoot,
      stdio: "pipe",
      timeout: BUILD_TIMEOUT_MS,
    });
    if (build.status !== 0) {
      throw new Error(
        `build failed: ${build.stdout?.toString()}${build.stderr?.toString()}`,
      );
    }
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // released by stale-lock cleanup in another worker
    }
  }
}
