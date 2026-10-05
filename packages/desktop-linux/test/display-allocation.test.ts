import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSession, getSession, type EnvLike } from "@pickforge/lab-core";
import {
  allocateDisplay,
  destroyDesktopSession,
  isDisplayAlive,
  startXvfb,
} from "../src/index.js";

const BUN = /[\\/]bun$/.test(process.execPath) ? process.execPath : "bun";
const worker = fileURLToPath(
  new URL("./workers/display-start-worker.ts", import.meta.url),
);
const roots: string[] = [];
const displays = new Set<number>();

function testDisplay(): number {
  const display = 10_000 + Math.floor(Math.random() * 40_000);
  displays.add(display);
  return display;
}

function socketPath(display: number): string {
  return `/tmp/.X11-unix/X${display}`;
}

function lockPath(display: number): string {
  return `/tmp/.X${display}-lock`;
}

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

async function waitForFiles(paths: string[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (paths.some((file) => !fs.existsSync(file))) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for display workers");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function childExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

/**
 * Fake Xvfb for the race test. Each fake appends `<kind> <display> <pid>`
 * lines to `eventLog`: "spawn" on start, "claim" once it holds the X lock and
 * before its socket can be seen, "fail <why>" before it exits without a
 * display, and "overlap" when another fake from this test is alive on the same
 * display. Every record lands before startXvfb can observe the outcome, so the
 * test can read the log as soon as all workers report.
 */
function writeContendedXvfb(
  binDir: string,
  eventLog: string,
  activePrefix: string,
): void {
  const server = path.join(binDir, "fake-xvfb.cjs");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    server,
    [
      'const fs = require("node:fs");',
      'const net = require("node:net");',
      'const display = process.argv[2].slice(1);',
      "const record = (kind, detail = '') => fs.appendFileSync(",
      `  ${JSON.stringify(eventLog)},`,
      "  `${kind} ${display} ${process.pid} ${detail}`.trimEnd() + '\\n',",
      ");",
      "record('spawn');",
      `const active = ${JSON.stringify(activePrefix)} + display;`,
      "let activeOwned = false;",
      "try {",
      '  fs.closeSync(fs.openSync(active, "wx"));',
      "  activeOwned = true;",
      "} catch { record('overlap'); }",
      'const lock = `/tmp/.X${display}-lock`;',
      'const socket = `/tmp/.X11-unix/X${display}`;',
      "let owns = false;",
      "let claimed = false;",
      "const fail = (why, code) => { record('fail', why); process.exit(code); };",
      "const cleanup = () => {",
      "  if (activeOwned) fs.rmSync(active, { force: true });",
      "  activeOwned = false;",
      "  if (!owns) return;",
      "  fs.rmSync(lock, { force: true });",
      "  fs.rmSync(socket, { force: true });",
      "};",
      "const stop = () => {",
      "  if (!claimed) record('fail', 'stopped');",
      "  cleanup();",
      "  process.exit(0);",
      "};",
      'for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);',
      "setTimeout(() => {",
      "  try {",
      '    const fd = fs.openSync(lock, "wx", 0o444);',
      "    fs.writeFileSync(fd, `${process.pid}\\n`);",
      "    fs.closeSync(fd);",
      "  } catch { fail('lock', 17); }",
      "  claimed = true;",
      "  record('claim');",
      '  fs.mkdirSync("/tmp/.X11-unix", { recursive: true });',
      "  const server = net.createServer(() => {});",
      "  server.once('error', () => fail('socket', 18));",
      "  server.listen(socket, () => { owns = true; });",
      "}, 350);",
      "process.on('exit', cleanup);",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "Xvfb"),
    `#!/bin/sh\nexec '${process.execPath}' '${server}' "$@"\n`,
  );
}

function writeStubbornXvfb(binDir: string): void {
  const server = path.join(binDir, "stubborn-xvfb.cjs");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    server,
    [
      'const fs = require("node:fs");',
      'const net = require("node:net");',
      'const display = process.argv[2].slice(1);',
      'fs.writeFileSync(`/tmp/.X${display}-lock`, `${process.pid}\\n`);',
      'fs.mkdirSync("/tmp/.X11-unix", { recursive: true });',
      'net.createServer(() => {}).listen(`/tmp/.X11-unix/X${display}`);',
      'for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "Xvfb"),
    `#!/bin/sh\nexec '${process.execPath}' '${server}' "$@"\n`,
  );
}

/**
 * Read the fake Xvfb event log. Each spawn must end in a held display or a
 * recorded failure, so `unsettled` lists spawns that did neither.
 */
function summarizeDisplayEvents(log: string): {
  overlaps: string[];
  unsettled: string[];
  claimed: string[];
} {
  const outcomes = new Map<string, "claim" | "fail" | undefined>();
  const overlaps: string[] = [];
  for (const line of log.trim().split("\n")) {
    const [kind, display, pid] = line.split(" ");
    const key = `${display} ${pid}`;
    if (kind === "spawn") outcomes.set(key, undefined);
    else if (kind === "overlap") overlaps.push(key);
    else if (kind === "fail") outcomes.set(key, "fail");
    else if (kind === "claim" && outcomes.get(key) !== "fail") {
      outcomes.set(key, "claim");
    }
  }
  const unsettled: string[] = [];
  const claimed: string[] = [];
  for (const [key, outcome] of outcomes) {
    if (outcome === undefined) unsettled.push(key);
    if (outcome === "claim") claimed.push(`:${key.split(" ")[0]}`);
  }
  return { overlaps, unsettled, claimed };
}

afterEach(() => {
  for (const display of displays) {
    fs.rmSync(lockPath(display), { force: true });
    fs.rmSync(socketPath(display), { force: true });
  }
  displays.clear();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("display artifact liveness", () => {
  it("treats a dead lock owner and leftover socket as stale and reusable", () => {
    const display = testDisplay();
    fs.mkdirSync("/tmp/.X11-unix", { recursive: true });
    fs.writeFileSync(lockPath(display), "1073741823\n");
    fs.writeFileSync(socketPath(display), "stale");

    expect(isDisplayAlive(`:${display}`)).toBe(false);
    expect(allocateDisplay({ start: display, maxAttempts: 1 })).toBe(`:${display}`);
  });

  it("does not mistake a stale lock whose pid was reused for a live display", async () => {
    const display = testDisplay();
    const root = makeRoot("pickforge-display-reused-pid-");
    const binDir = path.join(root, "bin");
    const spawned = path.join(root, "spawned");
    writeExecutable(
      path.join(binDir, "Xvfb"),
      `#!/bin/sh\nprintf spawned > '${spawned}'\nexit 9\n`,
    );
    fs.mkdirSync("/tmp/.X11-unix", { recursive: true });
    fs.writeFileSync(lockPath(display), `${process.pid}\n`);
    fs.writeFileSync(socketPath(display), "stale");

    expect(isDisplayAlive(`:${display}`)).toBe(false);
    expect(() =>
      allocateDisplay({ start: display, maxAttempts: 1 }),
    ).toThrow(/No free X display/);
    await expect(
      startXvfb({
        display: `:${display}`,
        logDir: path.join(root, "logs"),
        env: { ...process.env, PATH: binDir },
      }),
    ).rejects.toThrow(/another X server owns it/);
    expect(fs.existsSync(spawned)).toBe(false);
    expect(fs.readFileSync(socketPath(display), "utf8")).toBe("stale");
  });

  it.skipIf(!fs.existsSync("/usr/bin/Xvfb"))(
    "does not spawn over or unlink artifacts for a live unrelated server",
    async () => {
      const display = testDisplay();
      const root = makeRoot("pickforge-display-live-");
      const binDir = path.join(root, "bin");
      const spawned = path.join(root, "spawned");
      writeExecutable(
        path.join(binDir, "Xvfb"),
        `#!/bin/sh\nprintf spawned > '${spawned}'\nexit 9\n`,
      );
      const unrelated = spawn(
        "/usr/bin/Xvfb",
        [`:${display}`, "-screen", "0", "64x64x8", "-nolisten", "tcp"],
        { stdio: "ignore" },
      );
      const unrelatedExit = childExit(unrelated);
      await waitForFiles([socketPath(display), lockPath(display)]);
      const socketIdentity = fs.statSync(socketPath(display)).ino;
      const lockIdentity = fs.statSync(lockPath(display)).ino;

      try {
        expect(isDisplayAlive(`:${display}`)).toBe(true);
        await expect(
          startXvfb({
            display: `:${display}`,
            logDir: path.join(root, "logs"),
            env: { ...process.env, PATH: binDir },
          }),
        ).rejects.toThrow(/another X server owns it/);
        expect(fs.existsSync(spawned)).toBe(false);
        expect(fs.statSync(socketPath(display)).ino).toBe(socketIdentity);
        expect(fs.statSync(lockPath(display)).ino).toBe(lockIdentity);
      } finally {
        unrelated.kill("SIGTERM");
        await unrelatedExit;
      }
    },
  );

  it("returns from destroy with SIGKILL leftovers classified stale and reusable", async () => {
    const display = testDisplay();
    const root = makeRoot("pickforge-display-destroy-");
    const binDir = path.join(root, "bin");
    writeStubbornXvfb(binDir);
    const registryEnv: EnvLike = {
      ...process.env,
      PICKFORGE_HOME: path.join(root, "home"),
    };
    const xvfb = await startXvfb({
      display: `:${display}`,
      logDir: path.join(root, "logs"),
      env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
    });
    const session = await createSession(
      {
        type: "desktop",
        projectDir: path.join(root, "project"),
        status: "running",
        desktop: {
          display: xvfb.display,
          xvfbPid: xvfb.pid,
          xvfbStartTimeTicks: xvfb.startTimeTicks,
        },
      },
      registryEnv,
    );

    await destroyDesktopSession(session.id, registryEnv);

    expect(fs.existsSync(lockPath(display))).toBe(true);
    expect(fs.existsSync(socketPath(display))).toBe(true);
    expect(isDisplayAlive(`:${display}`)).toBe(false);
    expect(allocateDisplay({ start: display, maxAttempts: 1 })).toBe(`:${display}`);
    expect(await getSession(session.id, registryEnv)).toBeUndefined();
  }, 15_000);
});

describe("cross-process display allocation", () => {
  it("starts twelve synchronized sessions without cross-file display collisions", async () => {
    const root = makeRoot("pickforge-display-race-");
    const binDir = path.join(root, "bin");
    const eventLog = path.join(root, "events.log");
    const gate = path.join(root, "gate");
    const release = path.join(root, "release");
    const start = testDisplay();
    const count = 12;
    for (let offset = 0; offset < count + 5; offset += 1) displays.add(start + offset);
    writeContendedXvfb(binDir, eventLog, path.join(root, "active-"));

    const readyFiles = Array.from({ length: count }, (_, index) =>
      path.join(root, `ready-${index}`),
    );
    const resultFiles = Array.from({ length: count }, (_, index) =>
      path.join(root, `result-${index}.json`),
    );
    const children = Array.from({ length: count }, (_, index) =>
      spawn(
        BUN,
        [
          worker,
          gate,
          release,
          readyFiles[index]!,
          resultFiles[index]!,
          path.join(root, `logs-${index}`),
          binDir,
          String(start),
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      ),
    );
    const exits = children.map(childExit);

    try {
      await waitForFiles(readyFiles);
      fs.writeFileSync(gate, "go");
      await waitForFiles(resultFiles);
      const results = resultFiles.map(
        (file) => JSON.parse(fs.readFileSync(file, "utf8")) as {
          ok: boolean;
          display?: string;
          error?: string;
        },
      );
      const log = fs.existsSync(eventLog) ? fs.readFileSync(eventLog, "utf8") : "";
      const context = `results: ${JSON.stringify(results)}\nevents:\n${log}`;
      expect(results.filter((result) => !result.ok), context).toEqual([]);
      const allocated = results.map((result) => result.display);
      expect(new Set(allocated).size, context).toBe(count);
      // A stale or foreign lock or socket on a reserved display makes that
      // spawn fail, and startXvfb then retries the next display. That retry is
      // allowed, but two fakes from this test must never share a display.
      const events = summarizeDisplayEvents(log);
      expect(events.overlaps, context).toEqual([]);
      expect(events.unsettled, context).toEqual([]);
      expect(events.claimed.sort(), context).toEqual([...allocated].sort());
    } finally {
      fs.writeFileSync(release, "release");
      const codes = await Promise.all(exits);
      for (const child of children) child.kill("SIGKILL");
      expect(codes).toEqual(Array(count).fill(0));
    }
  }, 30_000);
});
