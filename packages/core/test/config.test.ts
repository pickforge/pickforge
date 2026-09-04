import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isEvidenceEnabled,
  loadConfig,
  resolvedDefaults,
  saveGlobalConfig,
  saveProjectConfig,
} from "../src/config.js";

let home: string;
let project: string;
let env: { PICKFORGE_HOME: string };

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-home-"));
  project = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-proj-"));
  env = { PICKFORGE_HOME: home };
});

afterEach(async () => {
  await fs.promises.rm(home, { recursive: true, force: true });
  await fs.promises.rm(project, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when no config files exist", async () => {
    const config = await loadConfig(project, env);
    expect(config.android?.avdName).toBe("pickforge-avd");
    expect(config.labUser?.name).toBe("pickforge-lab");
    expect(config.labUser?.home).toBe("/var/lib/pickforge/lab-home");
    expect(config.viewer?.mode).toBe("manual");
    expect(config.evidence?.enabled).toBe(true);
  });

  it("applies global config over defaults", async () => {
    await saveGlobalConfig(
      {
        profile: "android",
        android: { avdName: "global-avd" },
      },
      env,
    );
    const config = await loadConfig(project, env);
    expect(config.profile).toBe("android");
    expect(config.android?.avdName).toBe("global-avd");
    expect(config.labUser?.name).toBe("pickforge-lab");
  });

  it("applies project config over global config", async () => {
    await saveGlobalConfig({ android: { avdName: "global-avd" } }, env);
    await saveProjectConfig(project, { android: { avdName: "project-avd" } });
    const config = await loadConfig(project, env);
    expect(config.android?.avdName).toBe("project-avd");
  });

  it("lets project viewer mode override the global mode", async () => {
    await saveGlobalConfig({ viewer: { mode: "auto" } }, env);
    await saveProjectConfig(project, { viewer: { mode: "manual" } });
    const config = await loadConfig(project, env);
    expect(config.viewer?.mode).toBe("manual");
  });

  it("deep-merges nested objects across layers", async () => {
    await saveGlobalConfig(
      {
        android: { avdName: "global-avd" },
        labUser: { name: "global-user" },
      },
      env,
    );
    await saveProjectConfig(project, { labUser: { home: "/proj/home" } });
    const config = await loadConfig(project, env);
    expect(config.android?.avdName).toBe("global-avd");
    expect(config.labUser?.name).toBe("global-user");
    expect(config.labUser?.home).toBe("/proj/home");
  });

  it("throws with the file path on malformed JSON", async () => {
    const configPath = path.join(project, ".picklab", "config.json");
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, "{ not json", "utf8");
    await expect(loadConfig(project, env)).rejects.toThrow(configPath);
  });

  it("round-trips unknown keys", async () => {
    await saveProjectConfig(project, {
      custom: { nested: { value: 42 } },
      flag: true,
    });
    const config = await loadConfig(project, env);
    expect(config.custom).toEqual({ nested: { value: 42 } });
    expect(config.flag).toBe(true);
  });
});

describe("save/load round-trip", () => {
  it("persists project config as pretty JSON", async () => {
    await saveProjectConfig(project, { profile: "flutter-desktop" });
    const raw = await fs.promises.readFile(
      path.join(project, ".picklab", "config.json"),
      "utf8",
    );
    expect(raw).toContain("\n");
    expect(JSON.parse(raw).profile).toBe("flutter-desktop");
  });

  it("persists global config under pickforge-lab home", async () => {
    await saveGlobalConfig({ profile: "generic" }, env);
    const raw = await fs.promises.readFile(
      path.join(home, "config.json"),
      "utf8",
    );
    expect(JSON.parse(raw).profile).toBe("generic");
  });
});

describe("resolvedDefaults", () => {
  it("exposes the documented defaults", () => {
    expect(resolvedDefaults.android.avdName).toBe("pickforge-avd");
    expect(resolvedDefaults.labUser.name).toBe("pickforge-lab");
    expect(resolvedDefaults.labUser.home).toBe("/var/lib/pickforge/lab-home");
    expect(resolvedDefaults.viewer.mode).toBe("manual");
    expect(resolvedDefaults.evidence.enabled).toBe(true);
    expect(resolvedDefaults.storage.mode).toBe("home");
  });
});

describe("loadConfig legacy home fallback", () => {
  it("reads an existing ~/.picklab global config when PICKFORGE_HOME is unset and the new default has nothing yet", async () => {
    const fakeHome = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pickforge-lab-fakehome-"),
    );
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    try {
      const legacyConfigDir = path.join(fakeHome, ".picklab");
      await fs.promises.mkdir(legacyConfigDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(legacyConfigDir, "config.json"),
        JSON.stringify({ profile: "android" }),
      );

      const config = await loadConfig(project, {});
      expect(config.profile).toBe("android");
      // Non-destructive: nothing was written to the new default location.
      expect(
        fs.existsSync(path.join(fakeHome, ".pickforge", "lab")),
      ).toBe(false);
    } finally {
      homedirSpy.mockRestore();
      await fs.promises.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("prefers ~/.pickforge/picklab over the older ~/.picklab fallback", async () => {
    const fakeHome = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pickforge-lab-fakehome-"),
    );
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    try {
      await fs.promises.mkdir(path.join(fakeHome, ".picklab"), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(fakeHome, ".picklab", "config.json"),
        JSON.stringify({ profile: "android" }),
      );
      await fs.promises.mkdir(
        path.join(fakeHome, ".pickforge", "picklab"),
        { recursive: true },
      );
      await fs.promises.writeFile(
        path.join(fakeHome, ".pickforge", "picklab", "config.json"),
        JSON.stringify({ profile: "generic" }),
      );

      const config = await loadConfig(project, {});
      expect(config.profile).toBe("generic");
    } finally {
      homedirSpy.mockRestore();
      await fs.promises.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("prefers the new ~/.pickforge/lab default over both fallbacks", async () => {
    const fakeHome = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pickforge-lab-fakehome-"),
    );
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    try {
      for (const [dir, profile] of [
        [path.join(fakeHome, ".picklab"), "android"],
        [path.join(fakeHome, ".pickforge", "picklab"), "generic"],
        [path.join(fakeHome, ".pickforge", "lab"), "flutter-desktop"],
      ] as const) {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(
          path.join(dir, "config.json"),
          JSON.stringify({ profile }),
        );
      }

      const config = await loadConfig(project, {});
      expect(config.profile).toBe("flutter-desktop");
    } finally {
      homedirSpy.mockRestore();
      await fs.promises.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("does not fall back to old defaults once PICKFORGE_HOME is set explicitly", async () => {
    const fakeHome = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "pickforge-lab-fakehome-"),
    );
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    try {
      await fs.promises.mkdir(path.join(fakeHome, ".picklab"), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(fakeHome, ".picklab", "config.json"),
        JSON.stringify({ profile: "android" }),
      );

      const config = await loadConfig(project, env);
      expect(config.profile).toBeUndefined();
    } finally {
      homedirSpy.mockRestore();
      await fs.promises.rm(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("isEvidenceEnabled", () => {
  it("defaults to enabled", async () => {
    expect(isEvidenceEnabled(await loadConfig(project, env))).toBe(true);
    expect(isEvidenceEnabled({})).toBe(true);
  });

  it("honors an explicit disable from config", async () => {
    await saveProjectConfig(project, { evidence: { enabled: false } });
    const config = await loadConfig(project, env);
    expect(config.evidence?.enabled).toBe(false);
    expect(isEvidenceEnabled(config)).toBe(false);
  });

  it("stays enabled for non-boolean or partial evidence config", () => {
    expect(isEvidenceEnabled({ evidence: {} })).toBe(true);
    expect(isEvidenceEnabled({ evidence: { retentionKeep: 5 } })).toBe(true);
  });
});
