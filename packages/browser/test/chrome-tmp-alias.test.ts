import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserRuntimeLayout } from "../src/env.js";
import { ensureChromeTmpAlias, removeChromeTmpAlias } from "../src/session.js";

// Chrome's process singleton binds a Unix socket under $TMPDIR and sun_path is
// 108 bytes, so a nested PICKFORGE_HOME broke headed Chrome with "Socket path
// too long". The fix hands Chrome a short /tmp alias that points into the
// session's own temp directory. These tests pin the alias lifecycle without
// any browser: creation, refusal of foreign state, and ownership-checked
// removal. They use the real per-uid alias root because that root is part of
// the contract; every alias key here derives from a unique temp session dir.

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-chrome-tmp-alias-"));
});

afterEach(async () => {
  // Best effort: drop any alias a failing test left behind, then the tree.
  for (const entry of fs.readdirSync(tmp)) {
    const layout = browserRuntimeLayout(path.join(tmp, entry));
    await removeChromeTmpAlias(layout).catch(() => {});
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function layoutFor(name: string) {
  const sessionDir = path.join(tmp, name);
  const layout = browserRuntimeLayout(sessionDir);
  fs.mkdirSync(layout.tmpDir, { recursive: true, mode: 0o700 });
  return layout;
}

describe("ensureChromeTmpAlias", () => {
  it("publishes a short private symlink into the session temp dir", async () => {
    const layout = layoutFor("brow-00000001");
    await ensureChromeTmpAlias(layout);

    expect(fs.lstatSync(layout.chromeTmpDir).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(layout.chromeTmpDir)).toBe(layout.tmpDir);
    expect(fs.realpathSync(layout.chromeTmpDir)).toBe(fs.realpathSync(layout.tmpDir));
    // Leaves headroom for "<random>/SingletonSocket" under sun_path (108).
    expect(layout.chromeTmpDir.length).toBeLessThan(64);

    const root = fs.statSync(path.dirname(layout.chromeTmpDir));
    expect(root.isDirectory()).toBe(true);
    expect(root.mode & 0o777).toBe(0o700);
    expect(root.uid).toBe(process.getuid?.());

    await removeChromeTmpAlias(layout);
  });

  it("reuses an alias that already points at this session", async () => {
    const layout = layoutFor("brow-00000002");
    await ensureChromeTmpAlias(layout);
    try {
      await expect(ensureChromeTmpAlias(layout)).resolves.toBeUndefined();
      expect(fs.readlinkSync(layout.chromeTmpDir)).toBe(layout.tmpDir);
    } finally {
      await removeChromeTmpAlias(layout);
    }
  });

  it("replaces a dangling alias left by a session directory removed out of band", async () => {
    const layout = layoutFor("brow-00000007");
    const gone = path.join(tmp, "removed-session", "tmp");
    fs.mkdirSync(path.dirname(layout.chromeTmpDir), { recursive: true, mode: 0o700 });
    fs.symlinkSync(gone, layout.chromeTmpDir, "dir");
    expect(fs.existsSync(gone)).toBe(false);

    await ensureChromeTmpAlias(layout);
    try {
      expect(fs.readlinkSync(layout.chromeTmpDir)).toBe(layout.tmpDir);
    } finally {
      await removeChromeTmpAlias(layout);
    }
  });

  it("refuses an alias that points at a live directory that is not this session's", async () => {
    const layout = layoutFor("brow-00000008");
    const foreign = fs.mkdtempSync(path.join(tmp, "live-foreign-"));
    fs.mkdirSync(path.dirname(layout.chromeTmpDir), { recursive: true, mode: 0o700 });
    fs.symlinkSync(foreign, layout.chromeTmpDir, "dir");
    try {
      await expect(ensureChromeTmpAlias(layout)).rejects.toThrow(/already exists/);
      // Left exactly as found.
      expect(fs.readlinkSync(layout.chromeTmpDir)).toBe(foreign);
    } finally {
      fs.unlinkSync(layout.chromeTmpDir);
    }
  });

  it("refuses a real directory sitting at the alias path", async () => {
    const layout = layoutFor("brow-00000009");
    fs.mkdirSync(layout.chromeTmpDir, { recursive: true, mode: 0o700 });
    try {
      await expect(ensureChromeTmpAlias(layout)).rejects.toThrow(/already exists/);
      expect(fs.lstatSync(layout.chromeTmpDir).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(layout.chromeTmpDir, { recursive: true, force: true });
    }
  });

  it("gives two sessions distinct aliases under one root", async () => {
    const a = layoutFor("brow-0000000a");
    const b = layoutFor("brow-0000000b");
    await ensureChromeTmpAlias(a);
    await ensureChromeTmpAlias(b);
    try {
      expect(a.chromeTmpDir).not.toBe(b.chromeTmpDir);
      expect(path.dirname(a.chromeTmpDir)).toBe(path.dirname(b.chromeTmpDir));
      expect(fs.readlinkSync(a.chromeTmpDir)).toBe(a.tmpDir);
      expect(fs.readlinkSync(b.chromeTmpDir)).toBe(b.tmpDir);
    } finally {
      await removeChromeTmpAlias(a);
      // Removing one alias keeps the shared root while a sibling remains.
      expect(fs.existsSync(path.dirname(b.chromeTmpDir))).toBe(true);
      await removeChromeTmpAlias(b);
    }
  });
});

describe("removeChromeTmpAlias", () => {
  it("is a no-op when the alias never existed", async () => {
    const layout = layoutFor("brow-00000003");
    await expect(removeChromeTmpAlias(layout)).resolves.toBeUndefined();
  });

  it("refuses to remove a symlink that points somewhere else", async () => {
    const layout = layoutFor("brow-00000004");
    const foreign = fs.mkdtempSync(path.join(tmp, "foreign-"));
    fs.mkdirSync(path.dirname(layout.chromeTmpDir), { recursive: true, mode: 0o700 });
    fs.symlinkSync(foreign, layout.chromeTmpDir, "dir");
    try {
      await expect(removeChromeTmpAlias(layout)).rejects.toThrow(/unowned/);
      expect(fs.lstatSync(layout.chromeTmpDir).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(foreign)).toBe(true);
    } finally {
      fs.unlinkSync(layout.chromeTmpDir);
    }
  });

  it("refuses to remove a real directory at the alias path", async () => {
    const layout = layoutFor("brow-00000005");
    fs.mkdirSync(layout.chromeTmpDir, { recursive: true, mode: 0o700 });
    const canary = path.join(layout.chromeTmpDir, "canary");
    fs.writeFileSync(canary, "keep");
    try {
      await expect(removeChromeTmpAlias(layout)).rejects.toThrow(/unowned/);
      expect(fs.readFileSync(canary, "utf8")).toBe("keep");
    } finally {
      fs.rmSync(layout.chromeTmpDir, { recursive: true, force: true });
    }
  });

  it("removes an owned alias and leaves the session temp dir contents alone", async () => {
    const layout = layoutFor("brow-00000006");
    await ensureChromeTmpAlias(layout);
    const socketDir = path.join(layout.tmpDir, "com.google.Chrome.test");
    fs.mkdirSync(socketDir);

    await removeChromeTmpAlias(layout);

    expect(fs.existsSync(layout.chromeTmpDir)).toBe(false);
    // Unlinking the alias must never follow it into the session tree.
    expect(fs.existsSync(socketDir)).toBe(true);
  });
});
