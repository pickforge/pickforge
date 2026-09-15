import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireHumanLease,
  createSession,
  getSession,
  releaseHumanLease,
  sessionDataDir,
  type DesktopSessionInfo,
  type EnvLike,
} from "@pickforge/lab-core";
import { createIsolatedDesktopEnvironment, desktopEnvironmentRecipe } from "../src/environment.js";
import { desktopRuntimeLayout } from "../src/runtime.js";
import { ensureDesktopSessionIsolation, getDesktopSessionStatus, startSessionVnc } from "../src/session.js";
import { startHumanTakeover } from "../src/takeover.js";

let root: string;
let env: EnvLike;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-home-policy-"));
  env = { PICKFORGE_HOME: path.join(root, "registry"), HOME: path.join(root, "synthetic-host") };
  fs.mkdirSync(env.HOME!);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function session(homePolicy?: unknown) {
  return createSession({
    type: "desktop", projectDir: root, status: "running",
    desktop: { display: ":987", ...(homePolicy === undefined ? {} : { homePolicy }) } as DesktopSessionInfo,
  }, env);
}

describe("immutable managed desktop home policy", () => {
  it("reuses the stored private policy and session-local paths with no caller secrets in its recipe", async () => {
    const record = await session("private");
    const isolation = await ensureDesktopSessionIsolation(record.id, env);
    const source = { ...env, XDG_CONFIG_HOME: "", SECRET: "not-for-output", PICKFORGE_HOME: "", PICKLAB_HOME: "legacy-value" };
    const actual = createIsolatedDesktopEnvironment(":987", source, isolation);
    const recipe = desktopEnvironmentRecipe(":987", source, isolation);
    const home = path.join(sessionDataDir(record.id, env), "runtime", "home");
    expect(actual.HOME).toBe(home);
    expect(actual.XDG_CONFIG_HOME).toBe(path.join(home, "config"));
    expect(actual.PICKFORGE_HOME).toBe("");
    expect(actual.PICKLAB_HOME).toBe("legacy-value");
    for (const [key, value] of Object.entries(recipe.exports)) expect(actual[key]).toBe(value);
    expect(recipe.lines.join("\n")).not.toContain("not-for-output");
    expect(recipe.lines.join("\n")).not.toContain("legacy-value");
    expect(await ensureDesktopSessionIsolation(record.id, env)).toEqual(isolation);
    expect((await getDesktopSessionStatus(record.id, env)).homePolicy).toBe("private");
  });

  it("inherits only by stored consent, preserving absent and empty XDG values", async () => {
    const record = await session("inherit");
    const isolation = await ensureDesktopSessionIsolation(record.id, env);
    const source = { ...env, XDG_CONFIG_HOME: "", XDG_DATA_HOME: path.join(env.HOME!, "data") };
    const actual = createIsolatedDesktopEnvironment(":987", source, isolation);
    expect(actual.HOME).toBe(env.HOME);
    expect(actual.XDG_CONFIG_HOME).toBe("");
    expect(actual.XDG_DATA_HOME).toBe(source.XDG_DATA_HOME);
    expect(actual.XDG_STATE_HOME).toBeUndefined();
    expect(actual.XDG_RUNTIME_DIR).toBe(isolation.runtime.runtimeDir);
    expect(actual.WAYLAND_DISPLAY).toBe("pickforge-no-wayland");
    expect(actual.DBUS_SESSION_BUS_ADDRESS).toContain(isolation.runtime.runtimeDir);
    const recipe = desktopEnvironmentRecipe(":987", source, isolation);
    expect(recipe.exports.HOME).toBeUndefined();
    expect(recipe.lines.join("\n")).not.toContain(env.HOME);
    expect((await getSession(record.id, env))?.desktop?.homePolicy).toBe("inherit");
  });

  it.each([undefined, null, "invalid", {}, false])("refuses legacy or corrupt policy %j without creating home state", async (policy) => {
    const record = await session(policy);
    await expect(ensureDesktopSessionIsolation(record.id, env)).rejects.toThrow(/recreate/);
    expect(fs.existsSync(sessionDataDir(record.id, env))).toBe(false);
    expect((await getDesktopSessionStatus(record.id, env)).homePolicy).toBe(policy === undefined ? "legacy-inherit" : "unknown");
    expect((await getSession(record.id, env))?.desktop?.homePolicy).toEqual(policy);
  });

  it("refuses inherited-home processes and env preparation while a human lease is live", async () => {
    const record = await session("inherit");
    const lease = await acquireHumanLease(record.id, env);
    try {
      await expect(ensureDesktopSessionIsolation(record.id, env)).rejects.toThrow(/human control is active/);
      await expect(startSessionVnc(record.id, env, { display: ":987", viewOnly: true })).rejects.toThrow(/human control is active/);
      await expect(startSessionVnc(record.id, env, {
        display: ":987", viewOnly: false, humanLeaseId: "not-the-holder",
      })).rejects.toThrow(/Human lease authority lost/);
      expect(fs.existsSync(desktopRuntimeLayout(sessionDataDir(record.id, env)).runtimeDir)).toBe(false);
      expect((await getSession(record.id, env))?.desktop?.homePolicy).toBe("inherit");
    } finally {
      await releaseHumanLease(record.id, lease.leaseId, env);
    }
    expect((await ensureDesktopSessionIsolation(record.id, env)).homePolicy).toBe("inherit");
  });

  it.each([undefined, "invalid"])("refuses takeover before acquiring a lease or stopping VNC for %j policy", async (policy) => {
    const record = await session(policy);
    await expect(startHumanTakeover(record.id, { registryEnv: env })).rejects.toThrow(/requires a known home policy/);
    expect(fs.existsSync(sessionDataDir(record.id, env))).toBe(false);
    expect((await getSession(record.id, env))?.desktop).toEqual(record.desktop);
  });
});
