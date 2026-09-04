import fs from "node:fs";
import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  agentsDir,
  isProfileConfined,
  legacyAgentsDirs,
  legacyGlobalConfigPaths,
  legacyPickforgeHomes,
  legacySessionsDirs,
  listDirSafe,
  pickforgeHome,
  resolveReadablePath,
  sessionsDir,
} from "../src/paths.js";

describe("pickforgeHome", () => {
  it("uses PICKFORGE_HOME when set and non-empty", () => {
    expect(pickforgeHome({ PICKFORGE_HOME: "/custom/home" })).toBe("/custom/home");
  });

  it("falls back to PICKLAB_HOME with the renamed environment shim", () => {
    expect(pickforgeHome({ PICKLAB_HOME: "/legacy/override" })).toBe(
      "/legacy/override",
    );
  });

  it("defaults to ~/.pickforge/lab", () => {
    expect(pickforgeHome({ PICKFORGE_HOME: "" })).toBe(
      path.join(os.homedir(), ".pickforge", "lab"),
    );
    expect(pickforgeHome({})).toBe(
      path.join(os.homedir(), ".pickforge", "lab"),
    );
  });
});

describe("legacyPickforgeHomes", () => {
  const expected = [
    path.join(os.homedir(), ".pickforge", "picklab"),
    path.join(os.homedir(), ".picklab"),
  ];

  it("returns both earlier defaults when PICKFORGE_HOME is unset or empty", () => {
    expect(legacyPickforgeHomes({})).toEqual(expected);
    expect(legacyPickforgeHomes({ PICKFORGE_HOME: "" })).toEqual(expected);
  });

  it("returns no fallbacks once PICKFORGE_HOME is set explicitly", () => {
    expect(legacyPickforgeHomes({ PICKFORGE_HOME: "/custom/home" })).toEqual([]);
  });
});

describe("legacy subdir helpers", () => {
  it("derives both old locations unless PICKFORGE_HOME is explicit", () => {
    expect(legacySessionsDirs({})).toEqual(
      legacyPickforgeHomes({}).map((home) => path.join(home, "sessions")),
    );
    expect(legacyAgentsDirs({})).toEqual(
      legacyPickforgeHomes({}).map((home) => path.join(home, "agents")),
    );
    expect(legacyGlobalConfigPaths({})).toEqual(
      legacyPickforgeHomes({}).map((home) => path.join(home, "config.json")),
    );
    expect(legacySessionsDirs({ PICKFORGE_HOME: "/lab" })).toEqual([]);
    expect(legacyAgentsDirs({ PICKFORGE_HOME: "/lab" })).toEqual([]);
    expect(legacyGlobalConfigPaths({ PICKFORGE_HOME: "/lab" })).toEqual([]);
  });
});

describe("resolveReadablePath", () => {
  it("returns the primary path verbatim when there is no legacy path", async () => {
    expect(await resolveReadablePath("/a/primary.json", undefined)).toBe(
      "/a/primary.json",
    );
  });

  it("prefers the primary path when it exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-readable-"));
    const primary = path.join(root, "primary.json");
    const legacy = path.join(root, "legacy.json");
    fs.writeFileSync(primary, "{}");
    fs.writeFileSync(legacy, "{}");
    try {
      expect(await resolveReadablePath(primary, legacy)).toBe(primary);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy path when the primary is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-readable-"));
    const primary = path.join(root, "primary.json");
    const legacy = path.join(root, "legacy.json");
    fs.writeFileSync(legacy, "{}");
    try {
      expect(await resolveReadablePath(primary, legacy)).toBe(legacy);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the primary path when neither exists", async () => {
    expect(
      await resolveReadablePath("/nope/primary.json", "/nope/legacy.json"),
    ).toBe("/nope/primary.json");
  });
});

describe("listDirSafe", () => {
  it("returns [] for a missing directory instead of throwing", async () => {
    expect(await listDirSafe("/definitely/does/not/exist")).toEqual([]);
  });

  it("lists real entries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-listdir-"));
    fs.writeFileSync(path.join(root, "a.json"), "{}");
    fs.writeFileSync(path.join(root, "b.json"), "{}");
    try {
      expect((await listDirSafe(root)).sort()).toEqual(["a.json", "b.json"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("global subdirs", () => {
  const env = { PICKFORGE_HOME: "/lab" };

  it("builds the sessions dir", () => {
    expect(sessionsDir(env)).toBe(path.join("/lab", "sessions"));
  });

  it("builds the agents dir", () => {
    expect(agentsDir(env)).toBe(path.join("/lab", "agents"));
  });
});

describe("isProfileConfined", () => {
  it("accepts the profile and runtime paths beneath a resolved session", async () => {
    const sessionDir = "/tmp/pickforge-lab/sessions/../sessions/brow-12345678";
    expect(
      await isProfileConfined(
        sessionDir,
        "/tmp/pickforge-lab/sessions/brow-12345678/profile",
      ),
    ).toBe(true);
    expect(
      await isProfileConfined(
        sessionDir,
        "/tmp/pickforge-lab/sessions/brow-12345678/home/.cache",
      ),
    ).toBe(true);
  });

  it("rejects sibling paths with a shared prefix", async () => {
    expect(
      await isProfileConfined(
        "/tmp/pickforge-lab/sessions/brow-12345678",
        "/tmp/pickforge-lab/sessions/brow-123456789/profile",
      ),
    ).toBe(false);
  });

  it("rejects symlinked session and profile ancestry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-paths-"));
    const sessions = path.join(root, "sessions");
    const outside = path.join(root, "outside");
    const id = "brow-12345678";
    const session = path.join(sessions, id);
    try {
      fs.mkdirSync(session, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(session, "profile"));
      expect(
        await isProfileConfined(session, path.join(session, "profile")),
      ).toBe(false);

      fs.rmSync(session, { recursive: true, force: true });
      fs.symlinkSync(outside, session);
      expect(
        await isProfileConfined(session, path.join(session, "profile")),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
