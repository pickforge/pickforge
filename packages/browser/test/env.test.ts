import path from "node:path";
import { describe, expect, it } from "vitest";
import { browserRuntimeLayout, buildBrowserEnv } from "../src/env.js";

const SESSION_DIR = "/home/lab/.pickforge/lab/sessions/brow-abcdef01";

describe("browserRuntimeLayout", () => {
  it("confines runtime storage and gives Chrome a short temp alias", () => {
    const layout = browserRuntimeLayout(SESSION_DIR);
    for (const [name, dir] of Object.entries(layout)) {
      if (name === "chromeTmpDir") continue;
      expect(dir.startsWith(SESSION_DIR + path.sep)).toBe(true);
    }
    expect(layout.profileDir).toBe(path.join(SESSION_DIR, "profile"));
    expect(layout.homeDir).toBe(path.join(SESSION_DIR, "home"));
    expect(layout.xdgConfigHome).toBe(
      path.join(SESSION_DIR, "home", ".config"),
    );
    expect(layout.chromeTmpDir).toMatch(
      /^\/tmp\/pickforge-browser-[^/]+\/[0-9a-f]{16}$/,
    );
    expect(layout.chromeTmpDir.length).toBeLessThan(64);
  });
});

describe("buildBrowserEnv", () => {
  const layout = browserRuntimeLayout(SESSION_DIR);

  it("returns only the allowlisted keys and never leaks secrets", () => {
    const env = buildBrowserEnv({
      display: ":120",
      layout,
      sourceEnv: {
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        TZ: "UTC",
        // An empty locale var must be dropped, not forwarded as "".
        LC_ALL: "",
        SECRET_TOKEN: "super-secret-value",
        AWS_SECRET_ACCESS_KEY: "leak-me",
        HOME: "/home/realuser",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
    });
    // Secrets from the source environment must be absent.
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // The real user's HOME/runtime dir must be replaced, not inherited.
    expect(env.HOME).toBe(layout.homeDir);
    expect(env.XDG_RUNTIME_DIR).toBe(layout.xdgRuntimeDir);
    expect(env.TMPDIR).toBe(layout.chromeTmpDir);
    // Only the allowlist appears.
    expect(new Set(Object.keys(env))).toEqual(
      new Set([
        "DISPLAY",
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
        "TMPDIR",
        "PATH",
        "WAYLAND_DISPLAY",
        "LANG",
        "TZ",
      ]),
    );
  });

  it("points the display and Wayland guard at the isolated lab display", () => {
    const env = buildBrowserEnv({
      display: ":137",
      layout,
      sourceEnv: { PATH: "/usr/bin" },
    });
    expect(env.DISPLAY).toBe(":137");
    expect(env.WAYLAND_DISPLAY).toBe("pickforge-no-wayland");
  });

  it("falls back to a safe default PATH when the source has none", () => {
    const env = buildBrowserEnv({ display: ":1", layout, sourceEnv: {} });
    expect(env.PATH).toContain("/usr/bin");
  });
});
