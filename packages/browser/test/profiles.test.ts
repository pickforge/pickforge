import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirHandle, createSession, readProcessStartTicks, updateSession, type EnvLike } from "@pickforge/lab-core";
import { namedProfileBrowserEndpoint } from "../src/profiles.js";
import {
  browserProfileDir,
  claimBrowserProfile,
  deleteBrowserProfile,
  listBrowserProfiles,
  releaseBrowserProfile,
} from "../src/index.js";

let tmp: string;
let env: EnvLike;
const sessionId = "brow-12345678";
const deadPid = 2_147_483_647;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-profiles-"));
  env = { PICKFORGE_HOME: path.join(tmp, "lab") };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function abandonOwner(name: string): void {
  const lock = path.join(env.PICKFORGE_HOME!, "profiles", `.${name}.lock`);
  const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
  owner.process = { pid: deadPid, startTicks: 1 };
  fs.writeFileSync(lock, JSON.stringify(owner));
}

async function healthyProfiles() {
  return (await listBrowserProfiles(env)).map((profile) => {
    if ("error" in profile) throw new Error(profile.error);
    return profile;
  });
}

async function seedProfile(): Promise<string> {
  const dir = await claimBrowserProfile("ops", sessionId, env);
  await releaseBrowserProfile("ops", sessionId, env);
  return dir;
}

describe("persistent browser profiles", () => {
  it("uses the registry override and the supplied HOME default without touching the real home", () => {
    expect(browserProfileDir("ops", env)).toBe(path.join(tmp, "lab", "profiles", "ops"));
    expect(browserProfileDir("ops", { HOME: tmp })).toBe(path.join(tmp, ".pickforge", "lab", "profiles", "ops"));
    expect(browserProfileDir("ops", { HOME: tmp, PICKFORGE_HOME: "" })).toBe(path.join(tmp, ".pickforge", "lab", "profiles", "ops"));
  });

  it.each(["", "../ops", "a/b", "a\\b", "Ops", "-ops", ".", "a b", "a".repeat(33), "ops\n"])(
    "refuses invalid name %j without creating directories", async (name) => {
      await expect(claimBrowserProfile(name, sessionId, env)).rejects.toThrow("Invalid browser profile name");
      expect(fs.existsSync(env.PICKFORGE_HOME!)).toBe(false);
    },
  );

  it("creates private directories and lists size, last use, and the holder without changing state", async () => {
    expect(await listBrowserProfiles(env)).toEqual([]);
    const dir = await claimBrowserProfile("ops", sessionId, env);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(dir)).mode & 0o777).toBe(0o700);
    fs.mkdirSync(path.join(dir, "Default"));
    fs.writeFileSync(path.join(dir, "Default", "Cookies"), "private-cookie");
    const outside = path.join(tmp, "outside");
    fs.writeFileSync(outside, "should not be read");
    fs.symlinkSync(outside, path.join(dir, "link"));
    const before = fs.readdirSync(path.dirname(dir));
    const [profile] = await healthyProfiles();
    expect(profile).toMatchObject({ name: "ops", holdingSession: sessionId });
    expect(profile.sizeBytes).toBe("private-cookie".length + fs.lstatSync(path.join(dir, "link")).size);
    expect(Date.parse(profile.lastUsedAt)).toBeGreaterThan(Date.now() - 10_000);
    expect(fs.readdirSync(path.dirname(dir))).toEqual(before);
    await releaseBrowserProfile("ops", "brow-other", env);
    expect((await healthyProfiles())[0].holdingSession).toBe(sessionId);
    await releaseBrowserProfile("ops", sessionId, env);
    expect((await healthyProfiles())[0].holdingSession).toBeNull();
    expect(fs.readFileSync(path.join(dir, "Default", "Cookies"), "utf8")).toBe("private-cookie");
  });

  it.each(["profile", "root"])("refuses a symlink at the %s directory", async (which) => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.mkdirSync(env.PICKFORGE_HOME!, { mode: 0o700 });
    const root = path.join(env.PICKFORGE_HOME!, "profiles");
    if (which === "root") fs.symlinkSync(outside, root);
    else {
      fs.mkdirSync(root, { mode: 0o700 });
      fs.symlinkSync(outside, path.join(root, "ops"));
    }
    const message = which === "root" ? /symlink/ : 'Refusing browser profile "ops": it is a symlink';
    await expect(claimBrowserProfile("ops", sessionId, env)).rejects.toThrow(message);
    if (which === "root") await expect(listBrowserProfiles(env)).rejects.toThrow(message);
    else expect(await listBrowserProfiles(env)).toEqual([{
      name: "ops", error: message,
    }]);
    await expect(deleteBrowserProfile("ops", env)).rejects.toThrow(message);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.each([0o750, 0o701, 0o720, 0o704])( "refuses group or other permission bits (%s)", async (mode) => {
    const dir = await seedProfile();
    fs.chmodSync(dir, mode);
    await expect(claimBrowserProfile("ops", sessionId, env)).rejects.toThrow("mode 0700");
    expect(await listBrowserProfiles(env)).toEqual([{
      name: "ops", error: expect.stringContaining("mode 0700"),
    }]);
    await expect(deleteBrowserProfile("ops", env)).rejects.toThrow("mode 0700");
    expect(fs.statSync(dir).mode & 0o777).toBe(mode);
  });

  it("refuses a writable profile root or parent without changing its permissions", async () => {
    const dir = await seedProfile();
    const root = path.dirname(dir);
    fs.chmodSync(root, 0o755);
    await expect(claimBrowserProfile("ops", sessionId, env)).rejects.toThrow("mode 0700");
    expect(fs.statSync(root).mode & 0o777).toBe(0o755);
    fs.chmodSync(root, 0o700);
    fs.chmodSync(env.PICKFORGE_HOME!, 0o777);
    await expect(claimBrowserProfile("ops", sessionId, env)).rejects.toThrow("unsafe browser profile parent");
  });

  it("refuses a symlink or malformed profile lock without reading its target", async () => {
    const dir = await seedProfile();
    const lock = path.join(path.dirname(dir), ".ops.lock");
    const outside = path.join(tmp, "outside");
    fs.writeFileSync(outside, "untouched");
    fs.symlinkSync(outside, lock);
    await expect(claimBrowserProfile("ops", sessionId, env)).rejects.toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    fs.unlinkSync(lock);
    for (const owner of [{}, { sessionId, token: "00000000-0000-0000-0000-000000000000", process: null }]) {
      const contents = JSON.stringify(owner);
      fs.writeFileSync(lock, contents, { mode: 0o600 });
      await expect(claimBrowserProfile("ops", sessionId, env)).rejects.toThrow("Invalid browser profile lock");
      expect(fs.readFileSync(lock, "utf8")).toBe(contents);
    }
  });

  it("refuses a foreign uid from the opened directory's fstat", async () => {
    await seedProfile();
    // Changing real ownership needs privileges. Simulate only the kernel fstat result.
    const open = DirHandle.prototype.openChild;
    vi.spyOn(DirHandle.prototype, "openChild").mockImplementation(async function (this: DirHandle, name) {
      const dir = await open.call(this, name);
      if (name === "ops") dir.stat.uid = process.getuid!() + 1;
      return dir;
    });
    await expect(claimBrowserProfile("ops", sessionId, env)).rejects.toThrow("owned by this user");
  });

  it("allows exactly one concurrent claim and names its session in refusals", async () => {
    const ids = Array.from({ length: 8 }, (_, n) => `brow-${n.toString().padStart(8, "0")}`);
    const results = await Promise.allSettled(ids.map((id) => claimBrowserProfile("ops", id, env)));
    const winner = results.findIndex((result) => result.status === "fulfilled");
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason.message).toContain(ids[winner]);
    }
    await expect(deleteBrowserProfile("ops", env)).rejects.toThrow(ids[winner]);
    await releaseBrowserProfile("ops", ids[winner], env);
    await claimBrowserProfile("ops", sessionId, env);
  });

  it("recovers a dead creator's hold and clears singleton entries without following them", async () => {
    const dir = await claimBrowserProfile("ops", sessionId, env);
    fs.writeFileSync(path.join(dir, "Cookies"), "keep");
    const outside = path.join(tmp, "outside");
    fs.writeFileSync(outside, "keep outside");
    fs.symlinkSync(`${os.hostname()}-${deadPid}`, path.join(dir, "SingletonLock"));
    fs.symlinkSync(outside, path.join(dir, "SingletonSocket"));
    fs.symlinkSync("old-cookie", path.join(dir, "SingletonCookie"));
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "old port");
    abandonOwner("ops");
    expect((await healthyProfiles())[0].holdingSession).toBeNull();
    await claimBrowserProfile("ops", "brow-87654321", env);
    expect(fs.readdirSync(dir)).toEqual(["Cookies"]);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep outside");
    expect(fs.readFileSync(path.join(dir, "Cookies"), "utf8")).toBe("keep");
  });

  it("recovers a crash in the middle of releasing the hold", async () => {
    await claimBrowserProfile("ops", sessionId, env);
    abandonOwner("ops");
    const root = path.join(env.PICKFORGE_HOME!, "profiles");
    const owner = JSON.parse(fs.readFileSync(path.join(root, ".ops.lock"), "utf8"));
    const sentinel = path.join(root, `.ops.lock.${owner.token}`);
    fs.renameSync(sentinel, `${sentinel}.removing-${deadPid}-1`);
    await claimBrowserProfile("ops", "brow-87654321", env);
    expect((await healthyProfiles())[0].holdingSession).toBe("brow-87654321");
    expect(fs.readdirSync(root).some((name) => name.includes(".removing-"))).toBe(false);
  });

  it("finishes an interrupted release even when the original creator remains live", async () => {
    await claimBrowserProfile("ops", sessionId, env);
    const root = path.join(env.PICKFORGE_HOME!, "profiles");
    const owner = JSON.parse(fs.readFileSync(path.join(root, ".ops.lock"), "utf8"));
    const sentinel = path.join(root, `.ops.lock.${owner.token}`);
    fs.renameSync(sentinel, `${sentinel}.removing-${deadPid}-1`);
    await releaseBrowserProfile("ops", sessionId, env);
    expect((await healthyProfiles())[0].holdingSession).toBeNull();
    await claimBrowserProfile("ops", "brow-87654321", env);
  });

  it("keeps a hold when the creator died but a recorded process is live", async () => {
    const record = await createSession({ type: "browser", projectDir: tmp }, env);
    await claimBrowserProfile("ops", record.id, env);
    abandonOwner("ops");
    await updateSession(record.id, { desktop: { display: ":12345", xvfbPid: process.pid, xvfbStartTimeTicks: readProcessStartTicks(process.pid) } }, env);
    await expect(claimBrowserProfile("ops", sessionId, env)).rejects.toThrow(record.id);
    await expect(deleteBrowserProfile("ops", env)).rejects.toThrow(record.id);
  });

  it("refuses an unrecorded live browser after its creator crashes", async () => {
    const dir = await claimBrowserProfile("ops", sessionId, env);
    abandonOwner("ops");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${dir}`], { stdio: "ignore" });
    await once(child, "spawn");
    try {
      await expect(claimBrowserProfile("ops", "brow-87654321", env)).rejects.toThrow(sessionId);
      await expect(deleteBrowserProfile("ops", env)).rejects.toThrow(sessionId);
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await claimBrowserProfile("ops", "brow-87654321", env);
  });

  it.each(["unknown"])(
    "keeps singleton files until their owner is confirmed dead (%s)", async (target) => {
      const dir = await seedProfile();
      fs.symlinkSync(target, path.join(dir, "SingletonLock"));
      fs.writeFileSync(path.join(dir, "SingletonCookie"), "keep");
      await expect(claimBrowserProfile("ops", sessionId, env)).rejects.toThrow("not confirmed dead");
      expect(fs.readlinkSync(path.join(dir, "SingletonLock"))).toBe(target);
      expect(fs.readFileSync(path.join(dir, "SingletonCookie"), "utf8")).toBe("keep");
    },
  );

  it.each([`${os.hostname()}-${process.pid}`, `old-host-${process.pid}`, "other-host-999999"])(
    "clears singleton entries when the PID or hostname no longer identifies Chrome (%s)", async (target) => {
      const dir = await seedProfile();
      fs.symlinkSync(target, path.join(dir, "SingletonLock"));
      await claimBrowserProfile("ops", sessionId, env);
      expect(fs.existsSync(path.join(dir, "SingletonLock"))).toBe(false);
    },
  );

  it("ignores a singleton PID hidden by proc permissions during claim and delete", async () => {
    const dir = await seedProfile();
    const readFile = fs.promises.readFile;
    vi.spyOn(fs.promises, "readFile").mockImplementation(((location: string, ...args: unknown[]) =>
      location === `/proc/${process.pid}/cmdline`
        ? Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }))
        : Reflect.apply(readFile, fs.promises, [location, ...args])) as typeof readFile);
    fs.symlinkSync(`old-host-${process.pid}`, path.join(dir, "SingletonLock"));
    await claimBrowserProfile("ops", sessionId, env);
    expect(fs.existsSync(path.join(dir, "SingletonLock"))).toBe(false);
    await releaseBrowserProfile("ops", sessionId, env);
    fs.symlinkSync(`old-host-${process.pid}`, path.join(dir, "SingletonLock"));
    await deleteBrowserProfile("ops", env);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it.each([
    ["chrome", false, false],
    ["chrome", true, false],
    ["brave", false, false],
    ["chrome-headless-shell", true, false],
    ["brave", true, true],
  ])("keeps a singleton for %s with linked home %s and resolved argv %s", async (binary, linked, resolved) => {
    const realDir = await seedProfile();
    if (linked) {
      const link = path.join(tmp, "linked-home");
      fs.symlinkSync(env.PICKFORGE_HOME!, link);
      env.PICKFORGE_HOME = link;
    }
    const dir = browserProfileDir("ops", env);
    fs.symlinkSync(`old-host-${process.pid}`, path.join(dir, "SingletonLock"));
    const readFile = fs.promises.readFile;
    const readdir = fs.promises.readdir;
    vi.spyOn(fs.promises, "readdir").mockImplementation(((location: string, ...args: unknown[]) =>
      location === "/proc" ? Promise.resolve([]) : Reflect.apply(readdir, fs.promises, [location, ...args])) as typeof readdir);
    vi.spyOn(fs.promises, "readFile").mockImplementation(((location: string, ...args: unknown[]) =>
      location === `/proc/${process.pid}/cmdline`
        ? Promise.resolve(`/opt/browser/${binary}\0--user-data-dir=${resolved ? realDir : dir}\0`)
        : Reflect.apply(readFile, fs.promises, [location, ...args])) as typeof readFile);
    await expect(claimBrowserProfile("ops", sessionId, env)).rejects.toThrow('browser profile "ops": SingletonLock');
    expect(fs.readlinkSync(path.join(dir, "SingletonLock"))).toBe(`old-host-${process.pid}`);
    await expect(deleteBrowserProfile("ops", env)).rejects.toThrow('browser profile "ops": SingletonLock');
  });

  it.each(["browser", "xvfb"])("recovers a hold when the recorded %s PID was reused", async (leg) => {
    const record = await createSession({ type: "browser", projectDir: tmp }, env);
    await claimBrowserProfile("ops", record.id, env);
    abandonOwner("ops");
    const wrongTicks = readProcessStartTicks(process.pid)! + 1;
    await updateSession(record.id, leg === "browser" ? {
      browser: { browserPid: process.pid, browserStartTimeTicks: wrongTicks, binaryPath: "/chrome", profileMode: "named", profileDir: browserProfileDir("ops", env) },
    } : {
      desktop: { display: ":12345", xvfbPid: process.pid, xvfbStartTimeTicks: wrongTicks },
    }, env);
    expect((await healthyProfiles())[0].holdingSession).toBeNull();
    await claimBrowserProfile("ops", sessionId, env);
    expect((await healthyProfiles())[0].holdingSession).toBe(sessionId);
  });

  it("lists a profile when a cache directory vanishes between stat and open", async () => {
    const dir = await seedProfile();
    fs.mkdirSync(path.join(dir, "Cache"));
    fs.writeFileSync(path.join(dir, "Cookies"), "keep");
    const openChild = DirHandle.prototype.openChild;
    vi.spyOn(DirHandle.prototype, "openChild").mockImplementation(async function (this: DirHandle, name) {
      if (name === "Cache") fs.rmdirSync(this.resolve(name));
      return openChild.call(this, name);
    });
    expect(await listBrowserProfiles(env)).toEqual([expect.objectContaining({ name: "ops", sizeBytes: 4 })]);
  });

  it("keeps permission failures during the size walk visible", async () => {
    const dir = await seedProfile();
    fs.mkdirSync(path.join(dir, "Cache"));
    const openChild = DirHandle.prototype.openChild;
    vi.spyOn(DirHandle.prototype, "openChild").mockImplementation(async function (this: DirHandle, name) {
      if (name === "Cache") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return openChild.call(this, name);
    });
    expect(await listBrowserProfiles(env)).toEqual([{ name: "ops", error: "permission denied" }]);
  });

  it("lists healthy profiles alongside unsafe entries without opening symlink targets", async () => {
    const dir = await seedProfile();
    const root = path.dirname(dir);
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "linked"));
    fs.mkdirSync(path.join(root, "unsafe"), { mode: 0o750 });
    expect(await listBrowserProfiles(env)).toEqual([
      { name: "linked", error: 'Refusing browser profile "linked": it is a symlink' },
      expect.objectContaining({ name: "ops", sizeBytes: 0 }),
      { name: "unsafe", error: expect.stringContaining("mode 0700") },
    ]);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("reports a missing profile before creating any deletion hold", async () => {
    const dir = await seedProfile();
    const openFile = vi.spyOn(DirHandle.prototype, "openFile");
    await expect(deleteBrowserProfile("missing", env)).rejects.toThrow("Browser profile not found: missing");
    expect(openFile).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.dirname(dir))).toEqual(["ops"]);
  });

  it("deletes an unused profile without following its links", async () => {
    const dir = await seedProfile();
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep"), "keep");
    fs.symlinkSync(outside, path.join(dir, "outside"));
    await deleteBrowserProfile("ops", env);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("keep");
    expect(await listBrowserProfiles(env)).toEqual([]);
    await expect(deleteBrowserProfile("missing", env)).rejects.toThrow();
  });
});

describe("named profile close endpoint", () => {
  it.each([
    ["45678\n/devtools/browser/launch-guid\n", "ws://127.0.0.1:45678/devtools/browser/launch-guid"],
    ["45679\n/devtools/browser/launch-guid\n", undefined],
    ["45678\n", undefined],
    ["45678\n/devtools/page/launch-guid\n", undefined],
    ["45678\n/devtools/browser/guid?redirect=other\n", undefined],
  ])("validates the recorded port and browser path in %j", async (content, expected) => {
    const dir = await seedProfile();
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), content!);
    expect((await namedProfileBrowserEndpoint("ops", 45678, env))?.href).toBe(expected);
  });

  it("refuses a missing DevToolsActivePort file", async () => {
    await seedProfile();
    await expect(namedProfileBrowserEndpoint("ops", 45678, env)).rejects.toThrow();
  });

  it("refuses a symlinked DevToolsActivePort file", async () => {
    const dir = await seedProfile();
    const outside = path.join(tmp, "outside-port");
    fs.writeFileSync(outside, "45678\n/devtools/browser/outside-guid\n");
    fs.symlinkSync(outside, path.join(dir, "DevToolsActivePort"));
    await expect(namedProfileBrowserEndpoint("ops", 45678, env)).rejects.toThrow("not a regular file");
  });

  it("refuses a symlinked profile directory", async () => {
    const dir = await seedProfile();
    fs.renameSync(dir, `${dir}-moved`);
    fs.symlinkSync(`${dir}-moved`, dir);
    await expect(namedProfileBrowserEndpoint("ops", 45678, env)).rejects.toThrow("it is a symlink");
  });

  it("reads through the pinned directory if the profile path is replaced", async () => {
    const dir = await seedProfile();
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "45678\n/devtools/browser/original-guid\n");
    const outside = path.join(tmp, "outside-profile");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "DevToolsActivePort"), "45678\n/devtools/browser/replaced-guid\n");
    const openFile = DirHandle.prototype.openFile;
    vi.spyOn(DirHandle.prototype, "openFile").mockImplementation(async function (this: DirHandle, name, flags, mode) {
      if (name === "DevToolsActivePort") {
        fs.renameSync(dir, `${dir}-moved`);
        fs.symlinkSync(outside, dir);
      }
      return openFile.call(this, name, flags, mode);
    });
    expect((await namedProfileBrowserEndpoint("ops", 45678, env))?.href)
      .toBe("ws://127.0.0.1:45678/devtools/browser/original-guid");
  });
});
