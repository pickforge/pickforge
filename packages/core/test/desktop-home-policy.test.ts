import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirHandle } from "../src/dir-handle.js";
import { acquireAgentPermit, releaseAgentPermit, acquireHumanLease, releaseHumanLease, renewHumanLease, readHumanLease, checkHumanLeaseBusy, HumanLeaseDrainTimeoutError } from "../src/takeover.js";
import { beginEvidenceRun, finalizeActiveEvidenceRun } from "../src/evidence.js";
import { createSession, desktopHomePolicy, sessionDataDir, type DesktopSessionInfo } from "../src/session.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-policy-evidence-")); });
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("takeover storage ownership", () => {
  function fixture() {
    const env = { PICKFORGE_HOME: path.join(root, "registry") };
    const session = sessionDataDir("synthetic", env);
    const outside = path.join(root, "outside");
    fs.mkdirSync(session, { recursive: true });
    fs.mkdirSync(outside);
    return { env, session, outside };
  }

  it.each(["session", "permits"])("refuses planted %s directories on acquisition", async (kind) => {
    const { env, session, outside } = fixture();
    const target = kind === "session" ? session : path.join(session, "permits");
    if (kind === "session") fs.renameSync(session, `${session}-original`);
    fs.symlinkSync(outside, target);
    await expect(acquireAgentPermit("synthetic", env)).rejects.toThrow(/symlink/);
    await expect(acquireHumanLease("synthetic", env)).rejects.toThrow(/symlink/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.each(["session", "permits"])("releases the original permit after a %s path swap", async (kind) => {
    const { env, session, outside } = fixture();
    const permit = await acquireAgentPermit("synthetic", env);
    const target = kind === "session" ? session : path.join(session, "permits");
    fs.renameSync(target, `${target}-original`);
    const outsidePermits = kind === "session" ? path.join(outside, "permits") : outside;
    fs.mkdirSync(outsidePermits, { recursive: true });
    const sentinel = path.join(outsidePermits, `${permit.permitId}.json`);
    fs.writeFileSync(sentinel, "untouched");
    fs.symlinkSync(outside, target);
    await releaseAgentPermit(permit);
    await releaseAgentPermit(permit);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched");
    const original = kind === "session" ? path.join(`${target}-original`, "permits") : `${target}-original`;
    expect(fs.readdirSync(original)).toEqual([]);
  });

  it("refuses permit acquisition if the session changes while binding coordination", async () => {
    const { env, session, outside } = fixture();
    const original = DirHandle.prototype.ensureChildDir;
    vi.spyOn(DirHandle.prototype, "ensureChildDir").mockImplementation(async function(this: DirHandle, name, mode) {
      if (name === "permits") {
        fs.renameSync(session, `${session}-original`);
        fs.symlinkSync(outside, session);
      }
      return original.call(this, name, mode);
    });
    await expect(acquireAgentPermit("synthetic", env)).rejects.toThrow(/replaced/);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readdirSync(path.join(`${session}-original`, "permits"))).toEqual([]);
  });

  it("drains the pinned permits and rolls back the pinned lease after a session swap", async () => {
    const { env, session, outside } = fixture();
    const permit = await acquireAgentPermit("synthetic", env);
    try {
      await expect(acquireHumanLease("synthetic", env, {
        drainTimeoutMs: 0,
        _afterCreate() {
          fs.renameSync(session, `${session}-original`);
          fs.symlinkSync(outside, session);
        },
      })).rejects.toThrow(/Timed out/);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.existsSync(path.join(`${session}-original`, "human.lease.json"))).toBe(false);
    } finally { await releaseAgentPermit(permit); }
  });

  it.each(["session", "permits"])("shares the %s identity with separate-process lease and permit users", async (kind) => {
    const { env, session } = fixture();
    const permit = await acquireAgentPermit("synthetic", env);
    const target = kind === "session" ? session : path.join(session, "permits");
    fs.renameSync(target, `${target}-original`);
    fs.mkdirSync(target, { mode: 0o700 });
    try {
      await expect(checkHumanLeaseBusy("synthetic", env)).rejects.toThrow(/identity changed/);
      const modulePath = fileURLToPath(new URL("../src/takeover.ts", import.meta.url));
      const child = spawnSync("bun", ["-e", `
        import { acquireHumanLease, acquireAgentPermit, checkHumanLeaseBusy } from ${JSON.stringify(modulePath)};
        const outcomes = [];
        for (const operation of [acquireHumanLease, acquireAgentPermit, checkHumanLeaseBusy]) {
          try { await operation("synthetic"); outcomes.push("unexpected success"); }
          catch (error) { outcomes.push(error.message); }
        }
        console.log(JSON.stringify(outcomes));
      `], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000 });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(Array(3).fill(expect.stringMatching(/identity changed/)));
      expect(fs.readdirSync(target)).toEqual([]);
    } finally { await releaseAgentPermit(permit); }
  });

  it("drains the held permit directory even if its name is replaced after lease publication", async () => {
    const { env, session } = fixture();
    const permit = await acquireAgentPermit("synthetic", env);
    const permits = path.join(session, "permits");
    try {
      const acquiring = acquireHumanLease("synthetic", env, {
        drainTimeoutMs: 0,
        _afterCreate() {
          fs.renameSync(permits, `${permits}-original`);
          fs.mkdirSync(permits, { mode: 0o700 });
        },
      });
      await expect(acquiring).rejects.toMatchObject({
        constructor: HumanLeaseDrainTimeoutError, pendingPermitIds: [permit.permitId],
      });
      expect(fs.existsSync(path.join(session, "human.lease.json"))).toBe(false);
      expect(fs.readdirSync(permits)).toEqual([]);
    } finally { await releaseAgentPermit(permit); }
    expect(fs.readdirSync(`${permits}-original`)).toEqual([]);
    await expect(acquireHumanLease("synthetic", env)).rejects.toThrow(/identity changed/);
  });

  it.each(["session", "permits"])("does not recreate a missing bound %s directory", async (kind) => {
    const { env, session } = fixture();
    const permit = await acquireAgentPermit("synthetic", env);
    const target = kind === "session" ? session : path.join(session, "permits");
    fs.renameSync(target, `${target}-original`);
    try {
      await expect(acquireHumanLease("synthetic", env)).rejects.toThrow();
      await expect(checkHumanLeaseBusy("synthetic", env)).rejects.toThrow();
      expect(fs.existsSync(target)).toBe(false);
    } finally { await releaseAgentPermit(permit); }
  });

  it("refuses lease reads, renewal and release through a swapped session", async () => {
    const { env, session, outside } = fixture();
    const lease = await acquireHumanLease("synthetic", env);
    const raw = fs.readFileSync(path.join(session, "human.lease.json"), "utf8");
    fs.writeFileSync(path.join(outside, "human.lease.json"), raw);
    fs.renameSync(session, `${session}-original`);
    fs.symlinkSync(outside, session);
    await expect(readHumanLease("synthetic", env)).rejects.toThrow(/symlink/);
    await expect(renewHumanLease("synthetic", lease.leaseId, env)).rejects.toThrow(/symlink/);
    await expect(releaseHumanLease("synthetic", lease.leaseId, env)).rejects.toThrow(/symlink/);
    expect(fs.readFileSync(path.join(outside, "human.lease.json"), "utf8")).toBe(raw);
  });
});

describe("shared atomic write ownership", () => {
  it("writes and preserves mode on one open file when the temporary entry changes", async () => {
    const destination = path.join(root, "lease.json");
    const outside = path.join(root, "synthetic-outside");
    fs.writeFileSync(destination, "original lease");
    fs.chmodSync(destination, 0o640);
    fs.writeFileSync(outside, "untouched");
    fs.chmodSync(outside, 0o644);
    const openFile = DirHandle.prototype.openFile;
    let temporary = "";
    vi.spyOn(DirHandle.prototype, "openFile").mockImplementation(async function(this: DirHandle, name, flags, mode) {
      const file = await openFile.call(this, name, flags, mode);
      const write = file.writeFile.bind(file);
      vi.spyOn(file, "writeFile").mockImplementation(async (...args) => {
        await write(...args);
        temporary = path.join(root, name);
        fs.renameSync(temporary, `${temporary}-original`);
        fs.symlinkSync(outside, temporary);
      });
      return file;
    });
    const dir = await DirHandle.open(root);
    try {
      await expect(dir.writeFileAtomic("lease.json", "new lease")).rejects.toThrow(/replaced/);
    } finally { await dir.close(); }
    expect(fs.readFileSync(destination, "utf8")).toBe("original lease");
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
    expect(fs.statSync(`${temporary}-original`).mode & 0o777).toBe(0o640);
    expect(fs.lstatSync(temporary).isSymbolicLink()).toBe(true);
  });

  it("checks the published entry before reporting a successful atomic write", async () => {
    const destination = path.join(root, "lease.json");
    const outside = path.join(root, "synthetic-outside");
    fs.writeFileSync(outside, "untouched");
    fs.chmodSync(outside, 0o644);
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      fs.renameSync(destination, `${destination}-original`);
      fs.symlinkSync(outside, destination);
    });
    const dir = await DirHandle.open(root);
    try {
      await expect(dir.writeFileAtomic("lease.json", "new lease")).rejects.toThrow(/replaced/);
    } finally { await dir.close(); }
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(`${destination}-original`, "utf8")).toBe("new lease");
  });

  it("preserves the existing file mode and removes staging entries on success", async () => {
    fs.writeFileSync(path.join(root, "lease.json"), "old");
    fs.chmodSync(path.join(root, "lease.json"), 0o640);
    const dir = await DirHandle.open(root);
    try { await dir.writeFileAtomic("lease.json", "new"); }
    finally { await dir.close(); }
    expect(fs.statSync(path.join(root, "lease.json")).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(path.join(root, "lease.json"), "utf8")).toBe("new");
    expect(fs.readdirSync(root)).toEqual(["lease.json"]);
  });
});

describe("desktop home policy evidence", () => {
  it.each(["browser", "android"] as const)("keeps omitted metadata absent for %s evidence", async (type) => {
    const env = { PICKFORGE_HOME: path.join(root, "registry") };
    const session = await createSession({ type, projectDir: root }, env);
    const { run } = await beginEvidenceRun(root, session.id, {}, env);
    expect(run.manifest.meta).toBeUndefined();
    await finalizeActiveEvidenceRun(root, session.id, "completed", env);
  });

  it.each([
    ["private", "private"], ["inherit", "inherit"], [undefined, "legacy-inherit"],
    [null, "unknown"], ["untrusted-secret-value", "unknown"],
  ])("records %j as %s without accepting caller policy metadata", async (stored, expected) => {
    const env = { HOME: path.join(root, "synthetic-host"), PICKFORGE_HOME: path.join(root, "registry") };
    const desktop = { display: ":987", ...(stored === undefined ? {} : { homePolicy: stored }) } as DesktopSessionInfo;
    const session = await createSession({ type: "desktop", projectDir: root, desktop }, env);
    expect(desktopHomePolicy(desktop)).toBe(expected);
    const { run } = await beginEvidenceRun(root, session.id, {
      meta: { desktopHomePolicy: "forged", other: "kept" },
      device: { kind: "desktop", viewport: { width: 400, height: 300 } },
    }, env);
    expect(run.manifest.meta).toEqual({ desktopHomePolicy: expected, other: "kept" });
    const adopted = await beginEvidenceRun(root, session.id, { meta: { desktopHomePolicy: "forged-again" } }, env);
    expect(adopted.adopted).toBe(true);
    expect(adopted.run.manifest.meta?.desktopHomePolicy).toBe(expected);
    await finalizeActiveEvidenceRun(root, session.id, "completed", env);
    const text = fs.readFileSync(path.join(run.dir, "manifest.json"), "utf8");
    expect(JSON.parse(text).meta.desktopHomePolicy).toBe(expected);
    expect(text).not.toContain("untrusted-secret-value");
    expect(text).not.toContain(env.HOME);
    expect(text).not.toContain("forged");
  });
});
