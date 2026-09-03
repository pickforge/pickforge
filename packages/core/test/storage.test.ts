import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalProjectPath,
  deriveProjectId,
  projectId,
  resolveRunStorage,
  StorageConfigError,
} from "../src/storage.js";
import { saveGlobalConfig, saveProjectConfig } from "../src/config.js";
import { createRun } from "../src/run.js";

const execFileAsync = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-storage-"));
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe("deriveProjectId", () => {
  it("is stable for the same canonical path", () => {
    const id = deriveProjectId("/home/u/projects/widget");
    expect(deriveProjectId("/home/u/projects/widget")).toBe(id);
  });

  it("differs for different canonical paths", () => {
    expect(deriveProjectId("/home/u/projects/widget")).not.toBe(
      deriveProjectId("/home/u/projects/gadget"),
    );
  });

  it("includes a debuggable slug derived from the basename", () => {
    const id = deriveProjectId("/home/u/projects/My Cool App!");
    expect(id.startsWith("my-cool-app-")).toBe(true);
  });

  it("falls back to a generic slug for an unrepresentable basename", () => {
    const id = deriveProjectId("/home/u/projects/___");
    expect(id.startsWith("project-")).toBe(true);
  });
});

describe("projectId / canonicalProjectPath", () => {
  it("resolves the same id for the same directory reached through a symlink", async () => {
    const real = path.join(root, "real-project");
    const link = path.join(root, "linked-project");
    await fs.promises.mkdir(real);
    await fs.promises.symlink(real, link);

    expect(await projectId(link)).toBe(await projectId(real));
  });

  it("resolves different ids for different projects", async () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await fs.promises.mkdir(a);
    await fs.promises.mkdir(b);

    expect(await projectId(a)).not.toBe(await projectId(b));
  });

  it("does not throw for a project directory that does not exist yet", async () => {
    const missing = path.join(root, "not-created-yet");
    await expect(canonicalProjectPath(missing)).resolves.toBeTruthy();
    await expect(projectId(missing)).resolves.toBeTruthy();
  });
});

describe("resolveRunStorage", () => {
  it("defaults to home mode under the resolved Pickforge home", async () => {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });
    const env = { PICKFORGE_HOME: home };

    const resolved = await resolveRunStorage(project, env);

    expect(resolved.mode).toBe("home");
    expect(resolved.projectId).toBeDefined();
    expect(resolved.runsDir).toBe(
      path.join(home, "projects", resolved.projectId!, "runs"),
    );
  });

  it("resolves project-local mode from PICKFORGE_STORAGE_MODE", async () => {
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });

    const resolved = await resolveRunStorage(project, {
      PICKFORGE_STORAGE_MODE: "project-local",
    });

    expect(resolved.mode).toBe("project-local");
    expect(resolved.runsDir).toBe(path.join(project, ".picklab", "runs"));
  });

  it("resolves project-local mode from project config", async () => {
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });
    await saveProjectConfig(project, { storage: { mode: "project-local" } });

    const resolved = await resolveRunStorage(project, {});

    expect(resolved.mode).toBe("project-local");
    expect(resolved.runsDir).toBe(path.join(project, ".picklab", "runs"));
  });

  it("lets an env override win over project config", async () => {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });
    await saveProjectConfig(project, { storage: { mode: "project-local" } });

    const resolved = await resolveRunStorage(project, {
      PICKFORGE_HOME: home,
      PICKFORGE_STORAGE_MODE: "home",
    });

    expect(resolved.mode).toBe("home");
  });

  it("resolves custom mode from GLOBAL config with an absolute path", async () => {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const custom = path.join(root, "custom-artifacts");
    await fs.promises.mkdir(project, { recursive: true });
    await saveGlobalConfig({ storage: { mode: "custom", path: custom } }, {
      PICKFORGE_HOME: home,
    });

    const resolved = await resolveRunStorage(project, { PICKFORGE_HOME: home });

    expect(resolved.mode).toBe("custom");
    expect(resolved.runsDir).toBe(path.join(custom, "runs"));
    expect(resolved.rejectedProjectCustom).toBeUndefined();
  });

  it("resolves custom mode from PICKFORGE_STORAGE_MODE + PICKFORGE_STORAGE_PATH", async () => {
    const project = path.join(root, "project");
    const custom = path.join(root, "custom-artifacts");
    await fs.promises.mkdir(project, { recursive: true });

    const resolved = await resolveRunStorage(project, {
      PICKFORGE_STORAGE_MODE: "custom",
      PICKFORGE_STORAGE_PATH: custom,
    });

    expect(resolved.mode).toBe("custom");
    expect(resolved.runsDir).toBe(path.join(custom, "runs"));
  });

  it("rejects custom mode with no path", async () => {
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });

    await expect(
      resolveRunStorage(project, { PICKFORGE_STORAGE_MODE: "custom" }),
    ).rejects.toThrow(StorageConfigError);
  });

  it("rejects custom mode with a relative path", async () => {
    const project = path.join(root, "project");
    await fs.promises.mkdir(project, { recursive: true });

    await expect(
      resolveRunStorage(project, {
        PICKFORGE_STORAGE_MODE: "custom",
        PICKFORGE_STORAGE_PATH: "relative/path",
      }),
    ).rejects.toThrow(/absolute/i);
  });

  describe("project-committed config cannot select custom (P1)", () => {
    it("ignores a project-config custom request and falls back to home, flagging the rejection", async () => {
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const hostilePath = path.join(root, "attacker-controlled");
      await fs.promises.mkdir(project, { recursive: true });
      await saveProjectConfig(project, {
        storage: { mode: "custom", path: hostilePath },
      });

      const resolved = await resolveRunStorage(project, {
        PICKFORGE_HOME: home,
      });

      expect(resolved.mode).toBe("home");
      expect(resolved.runsDir.startsWith(home)).toBe(true);
      expect(resolved.rejectedProjectCustom).toEqual({
        requestedPath: hostilePath,
      });
    });

    it("falls back to global config's mode (not the hostile path) when the project requests custom", async () => {
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const hostilePath = path.join(root, "attacker-controlled");
      await fs.promises.mkdir(project, { recursive: true });
      await saveGlobalConfig({ storage: { mode: "project-local" } }, {
        PICKFORGE_HOME: home,
      });
      await saveProjectConfig(project, {
        storage: { mode: "custom", path: hostilePath },
      });

      const resolved = await resolveRunStorage(project, {
        PICKFORGE_HOME: home,
      });

      expect(resolved.mode).toBe("project-local");
      expect(resolved.rejectedProjectCustom).toBeDefined();
    });

    it("still allows project config to select project-local", async () => {
      const project = path.join(root, "project");
      await fs.promises.mkdir(project, { recursive: true });
      await saveProjectConfig(project, { storage: { mode: "project-local" } });

      const resolved = await resolveRunStorage(project, {});

      expect(resolved.mode).toBe("project-local");
      expect(resolved.rejectedProjectCustom).toBeUndefined();
    });

    it("still allows project config to select home", async () => {
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      await fs.promises.mkdir(project, { recursive: true });
      await saveGlobalConfig({ storage: { mode: "project-local" } }, {
        PICKFORGE_HOME: home,
      });
      await saveProjectConfig(project, { storage: { mode: "home" } });

      const resolved = await resolveRunStorage(project, {
        PICKFORGE_HOME: home,
      });

      expect(resolved.mode).toBe("home");
      expect(resolved.rejectedProjectCustom).toBeUndefined();
    });

    it("lets an env override select custom even when project config also requests it", async () => {
      const project = path.join(root, "project");
      const custom = path.join(root, "custom-artifacts");
      await fs.promises.mkdir(project, { recursive: true });
      await saveProjectConfig(project, {
        storage: { mode: "custom", path: "/should-be-ignored" },
      });

      const resolved = await resolveRunStorage(project, {
        PICKFORGE_STORAGE_MODE: "custom",
        PICKFORGE_STORAGE_PATH: custom,
      });

      expect(resolved.mode).toBe("custom");
      expect(resolved.runsDir).toBe(path.join(custom, "runs"));
      // The env override made the mode selection moot, so no rejection is
      // reported; the project's path was never consulted either way.
      expect(resolved.rejectedProjectCustom).toBeUndefined();
    });

    it("an env mode override never uses the project layer's custom path", async () => {
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      await fs.promises.mkdir(project, { recursive: true });
      await saveProjectConfig(project, {
        storage: { mode: "custom", path: "/should-never-be-used" },
      });

      // env selects custom but supplies no path, and global config has none
      // either: this must fail closed (missing path), never silently reuse
      // the project layer's path.
      await expect(
        resolveRunStorage(project, {
          PICKFORGE_HOME: home,
          PICKFORGE_STORAGE_MODE: "custom",
        }),
      ).rejects.toThrow(StorageConfigError);
    });
  });

  describe("custom path containment (P2)", () => {
    it("rejects a custom path equal to the project directory", async () => {
      const project = path.join(root, "project");
      await fs.promises.mkdir(project, { recursive: true });

      await expect(
        resolveRunStorage(project, {
          PICKFORGE_STORAGE_MODE: "custom",
          PICKFORGE_STORAGE_PATH: project,
        }),
      ).rejects.toThrow(/outside the project directory/i);
    });

    it("rejects a custom path nested inside the project directory", async () => {
      const project = path.join(root, "project");
      await fs.promises.mkdir(project, { recursive: true });

      await expect(
        resolveRunStorage(project, {
          PICKFORGE_STORAGE_MODE: "custom",
          PICKFORGE_STORAGE_PATH: path.join(project, "artifacts"),
        }),
      ).rejects.toThrow(/outside the project directory/i);
    });

    it("accepts a custom path that is a sibling of the project directory", async () => {
      const project = path.join(root, "project");
      const sibling = path.join(root, "project-artifacts");
      await fs.promises.mkdir(project, { recursive: true });

      const resolved = await resolveRunStorage(project, {
        PICKFORGE_STORAGE_MODE: "custom",
        PICKFORGE_STORAGE_PATH: sibling,
      });

      expect(resolved.runsDir).toBe(path.join(sibling, "runs"));
    });
  });
});

describe("repo cleanliness smoke", () => {
  it("leaves a target git repo's working tree clean after a default run", async () => {
    const home = path.join(root, "home");
    const project = path.join(root, "target-repo");
    await fs.promises.mkdir(project, { recursive: true });
    const env = { ...process.env, PICKFORGE_HOME: home };

    await execFileAsync("git", ["init", "-q"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: project,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: project,
    });
    await fs.promises.writeFile(path.join(project, "README.md"), "# repo\n");
    await execFileAsync("git", ["add", "-A"], { cwd: project });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], {
      cwd: project,
    });

    const run = await createRun(project, "smoke", {}, env);
    await fs.promises.writeFile(
      path.join(run.dir, "screenshots", "screenshot.png"),
      "fake-png",
    );
    await run.addArtifact(
      "screenshot",
      "screenshot.png",
      path.join(run.dir, "screenshots", "screenshot.png"),
    );
    await run.finish("completed");

    const status = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: project,
    });
    expect(status.stdout.trim()).toBe("");
    expect(fs.existsSync(path.join(project, ".picklab"))).toBe(false);
    expect(run.dir.startsWith(home)).toBe(true);
  });
});
