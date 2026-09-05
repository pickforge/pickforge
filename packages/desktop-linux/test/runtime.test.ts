import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createContainmentScope } from "@pickforge/lab-core";
import {
  createDesktopRuntimeDir,
  desktopRuntimeLayout,
  removeDesktopRuntimeDir,
} from "../src/runtime.js";
import {
  createIsolatedDesktopEnvironment,
  desktopEnvironmentRecipe,
} from "../src/environment.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-runtime-"));
let savedUmask: number | undefined;

afterEach(() => {
  if (savedUmask !== undefined) {
    process.umask(savedUmask);
    savedUmask = undefined;
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function sessionDir(name: string): string {
  const dir = path.join(root, "sessions", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("desktop runtime layout", () => {
  it("keeps every generated path inside the session directory", () => {
    const dir = sessionDir("desk-layout");
    const layout = desktopRuntimeLayout(dir);
    for (const value of Object.values(layout)) {
      expect(value.startsWith(`${dir}${path.sep}`)).toBe(true);
    }
    expect(layout.runtimeDir).toBe(path.join(dir, "runtime"));
    expect(path.dirname(layout.dbusSessionPath)).toBe(layout.runtimeDir);
    expect(path.dirname(layout.dbusSystemPath)).toBe(layout.runtimeDir);
  });

  it("creates the runtime dir private even under a permissive umask", async () => {
    savedUmask = process.umask(0o000);
    const layout = desktopRuntimeLayout(sessionDir("desk-perm"));
    await createDesktopRuntimeDir(layout);
    expect(fs.statSync(layout.runtimeDir).mode & 0o777).toBe(0o700);
  });

  it("re-tightens the permissions of an existing loose runtime dir", async () => {
    const layout = desktopRuntimeLayout(sessionDir("desk-loose"));
    fs.mkdirSync(layout.runtimeDir, { recursive: true });
    fs.chmodSync(layout.runtimeDir, 0o777);
    await createDesktopRuntimeDir(layout);
    expect(fs.statSync(layout.runtimeDir).mode & 0o777).toBe(0o700);
  });

  it("never creates the D-Bus sockets, so a connection fails closed", async () => {
    const layout = desktopRuntimeLayout(sessionDir("desk-dbus"));
    await createDesktopRuntimeDir(layout);
    expect(fs.existsSync(layout.dbusSessionPath)).toBe(false);
    expect(fs.existsSync(layout.dbusSystemPath)).toBe(false);
  });
});

describe("desktop runtime removal", () => {
  it("removes a confined runtime dir with its contents", async () => {
    const dir = sessionDir("desk-remove");
    const layout = desktopRuntimeLayout(dir);
    await createDesktopRuntimeDir(layout);
    fs.writeFileSync(path.join(layout.runtimeDir, "scratch"), "x");

    const removal = await removeDesktopRuntimeDir(dir, layout.runtimeDir);
    expect(removal.removed).toBe(true);
    expect(fs.existsSync(layout.runtimeDir)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("treats an already-missing runtime dir as removed", async () => {
    const dir = sessionDir("desk-missing");
    const removal = await removeDesktopRuntimeDir(
      dir,
      path.join(dir, "runtime"),
    );
    expect(removal.removed).toBe(true);
  });

  it("refuses a runtime path outside the session directory", async () => {
    const dir = sessionDir("desk-escape");
    const outside = path.join(root, "not-a-session");
    fs.mkdirSync(outside, { recursive: true });

    const removal = await removeDesktopRuntimeDir(dir, outside);
    expect(removal.removed).toBe(false);
    expect(removal.error?.message).toContain("Refusing to delete");
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("refuses a traversal that climbs back out of the session directory", async () => {
    const dir = sessionDir("desk-traversal");
    const victim = path.join(root, "victim");
    fs.mkdirSync(victim, { recursive: true });

    const removal = await removeDesktopRuntimeDir(
      dir,
      path.join(dir, "..", "..", "victim"),
    );
    expect(removal.removed).toBe(false);
    expect(fs.existsSync(victim)).toBe(true);
  });

  it("refuses a runtime dir redirected through a symlink", async () => {
    const dir = sessionDir("desk-symlink");
    const victim = path.join(root, "symlink-victim");
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, "precious"), "keep me");
    fs.symlinkSync(victim, path.join(dir, "runtime"));

    const removal = await removeDesktopRuntimeDir(
      dir,
      path.join(dir, "runtime"),
    );
    expect(removal.removed).toBe(false);
    expect(fs.existsSync(path.join(victim, "precious"))).toBe(true);
  });

  it("refuses when the session directory itself is a symlink", async () => {
    const real = sessionDir("desk-real-target");
    const link = path.join(root, "sessions", "desk-linked");
    fs.symlinkSync(real, link);
    const layout = desktopRuntimeLayout(link);
    fs.mkdirSync(layout.runtimeDir, { recursive: true });

    const removal = await removeDesktopRuntimeDir(link, layout.runtimeDir);
    expect(removal.removed).toBe(false);
    expect(fs.existsSync(path.join(real, "runtime"))).toBe(true);
  });
});

describe("isolated desktop environment", () => {
  it("replaces the caller's runtime dir and D-Bus endpoints", () => {
    const layout = desktopRuntimeLayout(sessionDir("desk-env"));
    const env = createIsolatedDesktopEnvironment(
      ":91",
      {
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/run/dbus/system_bus_socket",
        DBUS_SESSION_BUS_PID: "1234",
        DBUS_SESSION_BUS_WINDOWID: "5678",
        DBUS_STARTER_ADDRESS: "unix:path=/run/user/1000/bus",
        DBUS_STARTER_BUS_TYPE: "session",
      },
      { runtime: layout },
    );

    expect(env.XDG_RUNTIME_DIR).toBe(layout.runtimeDir);
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(
      `unix:path=${layout.dbusSessionPath}`,
    );
    expect(env.DBUS_SYSTEM_BUS_ADDRESS).toBe(
      `unix:path=${layout.dbusSystemPath}`,
    );
    expect(env.DBUS_SESSION_BUS_PID).toBeUndefined();
    expect(env.DBUS_SESSION_BUS_WINDOWID).toBeUndefined();
    expect(env.DBUS_STARTER_ADDRESS).toBeUndefined();
    expect(env.DBUS_STARTER_BUS_TYPE).toBeUndefined();
    for (const value of [
      env.XDG_RUNTIME_DIR,
      env.DBUS_SESSION_BUS_ADDRESS,
      env.DBUS_SYSTEM_BUS_ADDRESS,
    ]) {
      expect(value).toContain(layout.runtimeDir);
    }
  });

  it("drops an inherited containment token when no scope is given", () => {
    const env = createIsolatedDesktopEnvironment(":91", {
      PICKFORGE_CONTAINMENT_TOKEN: "someone-elses-token",
    });
    expect(env.PICKFORGE_CONTAINMENT_TOKEN).toBeUndefined();
  });

  it("exports the session's own containment token", () => {
    const scope = createContainmentScope({ id: "desk-token", useCgroup: false });
    const env = createIsolatedDesktopEnvironment(
      ":91",
      { PICKFORGE_CONTAINMENT_TOKEN: "someone-elses-token" },
      { containment: scope },
    );
    expect(env.PICKFORGE_CONTAINMENT_TOKEN).toBe(scope.token);
  });

  it("prints runtime isolation in the shell recipe without leaking secrets", () => {
    const layout = desktopRuntimeLayout(sessionDir("desk-recipe"));
    const scope = createContainmentScope({ id: "desk-recipe", useCgroup: false });
    const recipe = desktopEnvironmentRecipe(
      ":92",
      { SECRET_TOKEN: "do-not-print", DBUS_STARTER_BUS_TYPE: "session" },
      { runtime: layout, containment: scope },
    );

    expect(recipe.exports.XDG_RUNTIME_DIR).toBe(layout.runtimeDir);
    expect(recipe.exports.PICKFORGE_CONTAINMENT_TOKEN).toBe(scope.token);
    expect(recipe.unset).toContain("DBUS_STARTER_BUS_TYPE");
    expect(recipe.lines.join("\n")).not.toContain("do-not-print");
  });
});
