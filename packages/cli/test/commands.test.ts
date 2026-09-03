import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureCliBuilt } from "./build-once.js";

const cliPath = fileURLToPath(new URL("../dist/picklab.js", import.meta.url));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FAKE_SERIAL = "emulator-5554";
const AUTO_ALLOCATED_SERIAL = "emulator-5556";
const PLANTED_TOKEN = `ghp_${"a".repeat(36)}`;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJson(result: CliResult): Record<string, any> {
  try {
    return JSON.parse(result.stdout) as Record<string, any>;
  } catch (error) {
    throw new Error(
      `CLI did not print JSON (${(error as Error).message}); ` +
        `stdout: ${result.stdout}; stderr: ${result.stderr}`,
    );
  }
}

function writeScript(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

interface EnvOptions {
  realPath?: boolean;
  bins?: Record<string, string>;
  extra?: Record<string, string>;
}

function makeEnv(opts: EnvOptions = {}): Record<string, string> {
  const home = path.join(tmpDir, "home");
  const bin = path.join(tmpDir, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(opts.bins ?? {})) {
    writeScript(path.join(bin, name), body);
  }
  const pathParts = [bin];
  if (opts.realPath === true) {
    pathParts.push(process.env.PATH ?? "");
  }
  return {
    HOME: home,
    PICKLAB_HOME: path.join(home, ".picklab"),
    // Default new runs to the pre-#34 project-local layout so existing
    // fixtures/assertions in this file keep working; tests that exercise the
    // new "home" default explicitly override this via opts.extra.
    PICKLAB_STORAGE_MODE: "project-local",
    PATH: pathParts.join(":"),
    ...(opts.extra ?? {}),
  };
}

function makeProjectDir(name = "project"): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDesktopSessionRecord(
  env: Record<string, string>,
  projectDir: string,
  display = ":987",
): string {
  const id = "desk-12345678";
  const dir = path.join(env.PICKLAB_HOME, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    `${JSON.stringify({
      id,
      type: "desktop",
      createdAt: "2026-06-09T12:00:00.000Z",
      status: "running",
      projectDir,
      desktop: { display, xvfbPid: 999_999_999 },
    })}\n`,
  );
  return id;
}

function stopTestProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The test command has already exited.
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("timed out waiting for test condition");
}

function fakeAdbEnv(): { env: Record<string, string>; adbLog: string } {
  const adbLog = path.join(tmpDir, "adb.log");
  const body = [
    `printf '%s\\n' "$*" >> "${adbLog}"`,
    'case "$*" in',
    "  *\"screencap -p\"*) printf '\\211PNG\\r\\n\\032\\n' ;;",
    '  *"uiautomator dump"*) echo "UI hierchary dumped to: /sdcard/picklab-ui.xml" ;;',
    `  *"cat /sdcard/picklab-ui.xml"*) printf '<?xml version="1.0"?><hierarchy rotation="0"><node text="token=${PLANTED_TOKEN}" /></hierarchy>' ;;`,
    `  *"logcat -d"*) printf 'I/Auth( 123): authToken=${PLANTED_TOKEN}\\nI/App( 123): started\\n' ;;`,
    '  *"install -r"*) echo Success ;;',
    '  *monkey*) echo "Events injected: 1" ;;',
    "esac",
    "exit 0",
  ].join("\n");
  return { env: makeEnv({ bins: { adb: body } }), adbLog };
}

function adbLogLines(adbLog: string): string[] {
  if (!fs.existsSync(adbLog)) {
    return [];
  }
  return fs.readFileSync(adbLog, "utf8").trim().split("\n");
}

interface FakeAndroidSdk {
  sdk: string;
  adbLog: string;
  pidFile: string;
}

function makeFakeAndroidSdk(
  opts: { emulatorExits?: boolean; bootCompleted?: "0" | "1" } = {},
): FakeAndroidSdk {
  const root = path.join(tmpDir, "sdk");
  const pidFile = path.join(root, "emulator.pid");
  const adbLog = path.join(root, "adb.log");
  writeScript(
    path.join(root, "emulator", "emulator"),
    opts.emulatorExits === true
      ? "exit 1"
      : `echo $$ > "${pidFile}"\nPATH=/usr/bin:/bin\nexec sleep 120`,
  );
  writeScript(
    path.join(root, "platform-tools", "adb"),
    [
      `printf '%s\\n' "$*" >> "${adbLog}"`,
      'case "$*" in',
      `  *getprop*) echo ${opts.bootCompleted ?? "1"} ;;`,
      '  devices) printf "List of devices attached\\n" ;;',
      `  *"emu kill"*) [ -f "${pidFile}" ] && kill "$(cat "${pidFile}")" 2>/dev/null ;;`,
      "esac",
      "exit 0",
    ].join("\n"),
  );
  return { sdk: root, adbLog, pidFile };
}

function writeSyntheticRun(
  projectDir: string,
  runId: string,
  overrides: Record<string, unknown> = {},
): void {
  const dir = path.join(projectDir, ".picklab", "runs", runId);
  fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  const manifest = {
    runId,
    slug: "synthetic",
    createdAt: "2026-06-09T12:00:00.000Z",
    status: "completed",
    artifacts: [
      {
        type: "screenshot",
        name: "screenshot.png",
        path: "screenshots/screenshot.png",
        createdAt: "2026-06-09T12:00:01.000Z",
      },
    ],
    ...overrides,
  };
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

let tmpDir: string;
const cleanupEnvs: Array<Record<string, string>> = [];

beforeAll(async () => {
  await ensureCliBuilt();
}, 300_000);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "picklab-cmd-"));
});

afterEach(async () => {
  while (cleanupEnvs.length > 0) {
    const env = cleanupEnvs.pop() as Record<string, string>;
    await runCli(["session", "destroy", "--all"], env).catch(() => {});
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 60_000);

describe("picklab session (desktop)", () => {
  it(
    "creates, reports, and destroys a desktop session",
    async () => {
      const env = makeEnv({ realPath: true });
      cleanupEnvs.push(env);

      const created = await runCli(
        ["session", "create", "--type", "desktop", "--json"],
        env,
        tmpDir,
      );
      expect(created.code).toBe(0);
      const createReport = parseJson(created);
      expect(createReport.ok).toBe(true);
      expect(createReport.errors).toEqual([]);
      expect(createReport.sessions).toHaveLength(1);
      const session = createReport.sessions[0];
      expect(session.id).toMatch(/^desk-[0-9a-f]+$/);
      expect(session.type).toBe("desktop");
      expect(session.display).toMatch(/^:\d+$/);

      const status = await runCli(
        ["session", "status", session.id, "--json"],
        env,
      );
      expect(status.code).toBe(0);
      const statusReport = parseJson(status);
      expect(statusReport.sessions[0].status).toBe("running");
      expect(statusReport.sessions[0].desktop.display).toBe(session.display);
      expect(statusReport.sessions[0].desktop.xvfbAlive).toBe(true);
      expect(statusReport.sessions[0].desktop.displayAlive).toBe(true);

      const all = parseJson(await runCli(["session", "status", "--json"], env));
      expect(all.sessions.map((entry: any) => entry.id)).toContain(session.id);

      const destroyed = await runCli(
        ["session", "destroy", session.id, "--json"],
        env,
      );
      expect(destroyed.code).toBe(0);
      expect(parseJson(destroyed).destroyed).toEqual([session.id]);

      const after = await runCli(
        ["session", "status", session.id, "--json"],
        env,
      );
      expect(after.code).toBe(1);
      const afterReport = parseJson(after);
      expect(afterReport.ok).toBe(false);
      expect(afterReport.errors.join("\n")).toContain("not found");
    },
    60_000,
  );

  it("reports an empty session list", async () => {
    const env = makeEnv();
    const result = await runCli(["session", "status", "--json"], env);
    expect(result.code).toBe(0);
    expect(parseJson(result).sessions).toEqual([]);
  });

  it("watch gives a create hint when no desktop session exists", async () => {
    const env = makeEnv();
    const result = await runCli(["watch", "--json"], env, tmpDir);
    expect(result.code).toBe(1);
    expect(parseJson(result).errors.join("\n")).toContain(
      "picklab session create --type desktop",
    );
  });

  it("fails destroy without an id or --all", async () => {
    const env = makeEnv();
    const result = await runCli(["session", "destroy", "--json"], env);
    expect(result.code).toBe(1);
    expect(parseJson(result).errors.join("\n")).toContain("--all");
  });

  it("fails destroy for an unknown session id", async () => {
    const env = makeEnv();
    const result = await runCli(
      ["session", "destroy", "desk-ffffffff", "--json"],
      env,
    );
    expect(result.code).toBe(1);
    expect(parseJson(result).errors.join("\n")).toContain("not found");
  });

  it(
    "lists candidates when the default desktop session is ambiguous",
    async () => {
      const env = makeEnv({ realPath: true });
      cleanupEnvs.push(env);
      const first = parseJson(
        await runCli(
          ["session", "create", "--type", "desktop", "--json"],
          env,
          tmpDir,
        ),
      ).sessions[0];
      const second = parseJson(
        await runCli(
          ["session", "create", "--type", "desktop", "--json"],
          env,
          tmpDir,
        ),
      ).sessions[0];

      const click = await runCli(
        ["desktop", "click", "1", "1", "--json"],
        env,
        tmpDir,
      );
      expect(click.code).toBe(1);
      const clickReport = parseJson(click);
      expect(clickReport.errors.join("\n")).toContain("--session");
      expect(clickReport.errors.join("\n")).toContain(first.id);
      expect(clickReport.errors.join("\n")).toContain(second.id);

      const watch = await runCli(["watch", "--json"], env, tmpDir);
      expect(watch.code).toBe(1);
      expect(parseJson(watch).errors.join("\n")).toContain(
        "Multiple running desktop sessions",
      );

      const destroyed = await runCli(
        ["session", "destroy", "--all", "--json"],
        env,
      );
      expect(destroyed.code).toBe(0);
      expect(parseJson(destroyed).destroyed.sort()).toEqual(
        [first.id, second.id].sort(),
      );
    },
    60_000,
  );

  it(
    "cleans up the desktop leg when the android leg of desktop+android fails",
    async () => {
      const { sdk } = makeFakeAndroidSdk({
        emulatorExits: true,
        bootCompleted: "0",
      });
      const env = makeEnv({ realPath: true, extra: { ANDROID_HOME: sdk } });
      cleanupEnvs.push(env);

      const result = await runCli(
        ["session", "create", "--type", "desktop+android", "--json"],
        env,
        tmpDir,
      );
      expect(result.code).toBe(1);
      const report = parseJson(result);
      expect(report.ok).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);

      const status = parseJson(await runCli(["session", "status", "--json"], env));
      const desktops = status.sessions.filter(
        (entry: any) => entry.type === "desktop",
      );
      expect(desktops).toEqual([]);
    },
    60_000,
  );
  it(
    "watches with exact viewer argv and leaves VNC alive after viewer exit",
    async () => {
      const viewerArgs = path.join(tmpDir, "viewer-args");
      const env = makeEnv({
        realPath: true,
        bins: {
          "remote-viewer":
            `printf 'viewer noise\\n'; printf '%s\\n' \"$@\" > \"${viewerArgs}\"`,
        },
        extra: { DISPLAY: ":0" },
      });
      cleanupEnvs.push(env);
      const created = parseJson(
        await runCli(
          ["session", "create", "--type", "desktop", "--json"],
          env,
          tmpDir,
        ),
      ).sessions[0];

      const watched = parseJson(
        await runCli(
          ["watch", "--session", created.id, "--json"],
          env,
          tmpDir,
        ),
      );
      expect(watched.ok).toBe(true);
      expect(watched.opened).toBe(true);
      expect(watched.endpoint).toBe(
        `vnc://127.0.0.1:${watched.vncPort}`,
      );
      expect(fs.readFileSync(viewerArgs, "utf8").trim().split("\n")).toEqual([
        watched.endpoint,
      ]);

      const headlessEnv = { ...env };
      delete headlessEnv.DISPLAY;
      const headless = parseJson(
        await runCli(
          ["watch", "--session", created.id, "--json"],
          headlessEnv,
          tmpDir,
        ),
      );
      expect(headless.opened).toBe(false);
      expect(headless.endpoint).toBe(watched.endpoint);
      expect(headless.guidance).toContain("No graphical host session");
      expect(headless.guidance).toContain("ssh -N -L");

      const status = parseJson(
        await runCli(["session", "status", created.id, "--json"], env),
      ).sessions[0];
      expect(status.status).toBe("running");
      expect(status.desktop.xvfbAlive).toBe(true);
      expect(status.desktop.vncAlive).toBe(true);
      expect(status.desktop.vncViewOnly).toBe(true);
      expect(status.viewer).toMatchObject({
        endpoint: watched.endpoint,
        ready: true,
        readOnly: true,
      });
    },
    60_000,
  );

  it(
    "applies auto/manual viewer mode with one-shot overrides",
    async () => {
      const opens = path.join(tmpDir, "viewer-opens");
      const env = makeEnv({
        realPath: true,
        bins: {
          "remote-viewer": `printf '%s\\n' \"$1\" >> \"${opens}\"; sleep 3`,
        },
        extra: { DISPLAY: ":0" },
      });
      cleanupEnvs.push(env);
      const projectDir = makeProjectDir();
      const configPath = path.join(projectDir, ".picklab", "config.json");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ viewer: { mode: "auto" } }));

      const automaticStartedAt = Date.now();
      const automatic = parseJson(
        await runCli(
          ["session", "create", "--type", "desktop", "--json"],
          env,
          projectDir,
        ),
      );
      expect(automatic.viewer.opened).toBe(true);
      expect(Date.now() - automaticStartedAt).toBeLessThan(2_500);
      await waitFor(() => fs.existsSync(opens));
      expect(fs.readFileSync(opens, "utf8").trim().split("\n")).toHaveLength(1);

      const disabled = parseJson(
        await runCli(
          [
            "session",
            "create",
            "--type",
            "desktop",
            "--no-viewer",
            "--json",
          ],
          env,
          projectDir,
        ),
      );
      expect(disabled.viewer).toBeUndefined();
      expect(fs.readFileSync(opens, "utf8").trim().split("\n")).toHaveLength(1);

      const beforeConflict = parseJson(
        await runCli(["session", "status", "--json"], env),
      ).sessions.length;
      const conflict = await runCli(
        [
          "session",
          "create",
          "--type",
          "desktop",
          "--vnc-control",
          "--viewer",
          "--json",
        ],
        env,
        projectDir,
      );
      expect(conflict.code).toBe(1);
      expect(parseJson(conflict).errors.join("\n")).toContain(
        "--viewer cannot be combined with --vnc-control",
      );
      expect(
        parseJson(await runCli(["session", "status", "--json"], env)).sessions,
      ).toHaveLength(beforeConflict);

      const controlled = parseJson(
        await runCli(
          [
            "session",
            "create",
            "--type",
            "desktop",
            "--vnc-control",
            "--json",
          ],
          env,
          projectDir,
        ),
      );
      expect(controlled.ok).toBe(true);
      expect(controlled.viewer).toMatchObject({
        opened: false,
        suppressed: true,
      });
      expect(controlled.viewer.reason).toContain("--vnc-control");
      expect(fs.readFileSync(opens, "utf8").trim().split("\n")).toHaveLength(1);

      fs.writeFileSync(
        configPath,
        JSON.stringify({ viewer: { mode: "manual" } }),
      );
      const enabled = parseJson(
        await runCli(
          [
            "session",
            "create",
            "--type",
            "desktop",
            "--viewer",
            "--json",
          ],
          env,
          projectDir,
        ),
      );
      expect(enabled.viewer.opened).toBe(true);
      await waitFor(
        () =>
          fs.existsSync(opens) &&
          fs.readFileSync(opens, "utf8").trim().split("\n").length === 2,
      );
      expect(fs.readFileSync(opens, "utf8").trim().split("\n")).toHaveLength(2);
    },
    60_000,
  );


  it(
    "reports a created session when the requested viewer attach fails",
    async () => {
      const env = makeEnv({
        realPath: true,
        bins: {
          x11vnc: "exit 1",
          "remote-viewer": "exit 0",
        },
        extra: { DISPLAY: ":0" },
      });
      cleanupEnvs.push(env);
      const result = await runCli(
        [
          "session",
          "create",
          "--type",
          "desktop",
          "--viewer",
          "--json",
        ],
        env,
        tmpDir,
      );
      expect(result.code).toBe(1);
      const report = parseJson(result);
      expect(report.ok).toBe(false);
      expect(report.sessions).toHaveLength(1);
      expect(report.viewer).toMatchObject({
        sessionId: report.sessions[0].id,
        opened: false,
      });
      expect(report.errors.join("\n")).toContain(
        `Viewer failed after creating session ${report.sessions[0].id}`,
      );
      const status = parseJson(
        await runCli(
          ["session", "status", report.sessions[0].id, "--json"],
          env,
        ),
      );
      expect(status.sessions[0].status).toBe("running");
    },
    60_000,
  );
});

describe("picklab desktop", () => {
  it("prints an eval-ready isolated environment in text and JSON", async () => {
    const projectDir = makeProjectDir();
    const env = makeEnv({
      extra: {
        WAYLAND_DISPLAY: "wayland-0",
        WAYLAND_SOCKET: "42",
        WAYLAND_DEBUG: "client",
        SECRET_TOKEN: "do-not-print",
      },
    });
    const id = writeDesktopSessionRecord(env, projectDir, ":98");

    const json = await runCli(
      ["desktop", "env", "--session", id, "--json"],
      env,
      projectDir,
    );
    expect(json.code).toBe(0);
    const report = parseJson(json);
    expect(report.unset).toEqual(["WAYLAND_DEBUG", "WAYLAND_SOCKET"]);
    expect(report.exports).toEqual({
      DISPLAY: ":98",
      WAYLAND_DISPLAY: "picklab-no-wayland",
      GDK_BACKEND: "x11",
      QT_QPA_PLATFORM: "xcb",
      SDL_VIDEODRIVER: "x11",
      WINIT_UNIX_BACKEND: "x11",
      XDG_SESSION_TYPE: "x11",
    });
    expect(report.script).not.toContain("do-not-print");

    const text = await runCli(
      ["desktop", "env", "--session", id],
      env,
      projectDir,
    );
    expect(text.code).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout.trim()).toBe(report.script);

    const evaluated = spawnSync(
      "/bin/sh",
      [
        "-c",
        'eval "$1"; printf "%s\\n" "$DISPLAY" "${WAYLAND_DISPLAY-unset}" "$GDK_BACKEND" "$QT_QPA_PLATFORM"',
        "sh",
        text.stdout,
      ],
      { env, encoding: "utf8" },
    );
    expect(evaluated.status).toBe(0);
    expect(evaluated.stdout).toBe(":98\npicklab-no-wayland\nx11\nxcb\n");
  });

  it("executes argv in the isolated environment and reports its process group", async () => {
    const projectDir = makeProjectDir();
    const capture = path.join(tmpDir, "exec-environment.txt");
    const command = path.join(tmpDir, "capture-exec");
    const searchMarker = path.join(tmpDir, "xdotool-searched");
    const env = makeEnv({
      bins: {
        xdotool:
          'case "$1" in\n  search)\n' +
          `    if [ -f "${searchMarker}" ]; then echo 4242; else : > "${searchMarker}"; exit 1; fi ;;\n` +
          "  getwindowname) echo picklab-fake-window ;;\nesac",
      },
      extra: {
        WAYLAND_DISPLAY: "wayland-0",
        WAYLAND_SOCKET: "42",
      },
    });
    const id = writeDesktopSessionRecord(env, projectDir, ":97");
    writeScript(
      command,
      "printf 'DISPLAY=%s\\nWAYLAND_DISPLAY=%s\\nWAYLAND_SOCKET=%s\\nGDK_BACKEND=%s\\nQT_QPA_PLATFORM=%s\\nSDL_VIDEODRIVER=%s\\nWINIT_UNIX_BACKEND=%s\\nXDG_SESSION_TYPE=%s\\n' " +
        '"$DISPLAY" "${WAYLAND_DISPLAY-unset}" "${WAYLAND_SOCKET-unset}" "$GDK_BACKEND" "$QT_QPA_PLATFORM" "$SDL_VIDEODRIVER" "$WINIT_UNIX_BACKEND" "$XDG_SESSION_TYPE" ' +
        `> "${capture}"\n` +
        `printf 'ARG=%s\\n' "$@" >> "${capture}"\n` +
        "exec /bin/sleep 30",
    );

    const result = await runCli(
      [
        "desktop",
        "exec",
        "--session",
        id,
        "--window-timeout",
        "1000",
        "--json",
        "--",
        command,
        "hello world",
        "$(not-expanded)",
      ],
      env,
      projectDir,
    );
    const report = parseJson(result);
    try {
      expect(result.code).toBe(0);
      expect(report.processGroupId).toBe(report.pid);
      expect(report.windowCount).toBe(1);
      expect(report.windows).toEqual([
        { id: "4242", name: "picklab-fake-window" },
      ]);
      expect(fs.readFileSync(capture, "utf8")).toBe(
        "DISPLAY=:97\n" +
          "WAYLAND_DISPLAY=picklab-no-wayland\nWAYLAND_SOCKET=unset\n" +
          "GDK_BACKEND=x11\nQT_QPA_PLATFORM=xcb\n" +
          "SDL_VIDEODRIVER=x11\nWINIT_UNIX_BACKEND=x11\n" +
          "XDG_SESSION_TYPE=x11\n" +
          "ARG=hello world\nARG=$(not-expanded)\n",
      );
    } finally {
      if (typeof report.pid === "number") stopTestProcessGroup(report.pid);
    }
  });

  it("reports a possible real-desktop escape when exec finds no window", async () => {
    const projectDir = makeProjectDir();
    const pidFile = path.join(tmpDir, "windowless.pid");
    const command = path.join(tmpDir, "windowless-command");
    const env = makeEnv({ bins: { xdotool: "exit 1" } });
    const id = writeDesktopSessionRecord(env, projectDir, ":96");
    writeScript(command, `echo $$ > "${pidFile}"\nexec /bin/sleep 30`);

    const result = await runCli(
      [
        "desktop",
        "exec",
        "--session",
        id,
        "--window-timeout",
        "100",
        "--json",
        "--",
        command,
      ],
      env,
      projectDir,
    );
    try {
      expect(result.code).toBe(1);
      const errors = parseJson(result).errors.join("\n");
      expect(errors).toContain("may have escaped the lab");
      expect(errors).toContain("opened on your real desktop");
      expect(errors).toMatch(/kill -- -\d+/);
      expect(errors).toContain("picklab desktop env --session <id>");
    } finally {
      if (fs.existsSync(pidFile)) {
        stopTestProcessGroup(Number(fs.readFileSync(pidFile, "utf8").trim()));
      }
    }
  });

  it(
    "screenshots into a run directory with a manifest entry",
    async () => {
      const env = makeEnv({ realPath: true });
      cleanupEnvs.push(env);
      const projectDir = makeProjectDir();
      await runCli(
        ["session", "create", "--type", "desktop", "--json"],
        env,
        projectDir,
      );

      const result = await runCli(
        ["desktop", "screenshot", "--json", "--project-dir", projectDir],
        env,
      );
      expect(result.code).toBe(0);
      const report = parseJson(result);
      expect(report.ok).toBe(true);
      expect(report.windowCount).toBe(0);
      expect(report.warnings).toEqual([
        expect.stringContaining("may have escaped the lab"),
      ]);
      expect(report.runId).toMatch(/-desktop/);
      expect(report.path).toContain(
        path.join(projectDir, ".picklab", "runs", report.runId, "screenshots"),
      );
      const data = fs.readFileSync(report.path);
      expect(data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(report.runDir, "manifest.json"), "utf8"),
      );
      expect(manifest.status).toBe("completed");
      expect(manifest.artifacts).toHaveLength(1);
      expect(manifest.artifacts[0].type).toBe("screenshot");
      expect(manifest.artifacts[0].path).toBe(
        path.join("screenshots", "screenshot.png"),
      );

      const out = path.join(tmpDir, "explicit", "shot.png");
      const outResult = await runCli(
        ["desktop", "screenshot", "--out", out, "--json"],
        env,
        projectDir,
      );
      expect(outResult.code).toBe(0);
      expect(parseJson(outResult).path).toBe(out);
      const outData = fs.readFileSync(out);
      expect(outData.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(
        true,
      );
    },
    60_000,
  );

  it(
    "launches an app and drives click, type, and key input",
    async () => {
      const env = makeEnv({ realPath: true });
      cleanupEnvs.push(env);
      await runCli(
        ["session", "create", "--type", "desktop", "--json"],
        env,
        tmpDir,
      );

      const launched = await runCli(
        [
          "desktop",
          "launch",
          "--json",
          "--wait-window",
          "xterm",
          "--",
          "xterm",
          "-xrm",
          "XTerm.vt100.allowTitleOps: false",
        ],
        env,
        tmpDir,
      );
      expect(launched.code).toBe(0);
      const launchReport = parseJson(launched);
      expect(launchReport.pid).toBeGreaterThan(0);
      expect(fs.existsSync(launchReport.logPath)).toBe(true);
      expect(launchReport.window.name).toContain("xterm");

      const click = await runCli(
        ["desktop", "click", "20", "20", "--json"],
        env,
        tmpDir,
      );
      expect(click.code).toBe(0);
      expect(parseJson(click).ok).toBe(true);

      const moved = await runCli(
        ["desktop", "move", "120", "80", "--json"],
        env,
        tmpDir,
      );
      expect(moved.code).toBe(0);
      const moveReport = parseJson(moved);
      expect(moveReport.ok).toBe(true);
      expect(moveReport.x).toBe(120);
      expect(moveReport.y).toBe(80);

      const scrolled = await runCli(
        ["desktop", "scroll", "--at", "100,100", "--json", "--", "-1", "2"],
        env,
        tmpDir,
      );
      expect(scrolled.code).toBe(0);
      const scrollReport = parseJson(scrolled);
      expect(scrollReport.ok).toBe(true);
      expect(scrollReport.deltaX).toBe(-1);
      expect(scrollReport.deltaY).toBe(2);
      expect(scrollReport.x).toBe(100);
      expect(scrollReport.y).toBe(100);

      const dragged = await runCli(
        [
          "desktop",
          "drag",
          "30",
          "30",
          "160",
          "120",
          "--duration",
          "200",
          "--json",
        ],
        env,
        tmpDir,
      );
      expect(dragged.code).toBe(0);
      const dragReport = parseJson(dragged);
      expect(dragReport.ok).toBe(true);
      expect(dragReport.fromX).toBe(30);
      expect(dragReport.toY).toBe(120);
      expect(dragReport.button).toBe(1);

      const doubleClicked = await runCli(
        ["desktop", "double-click", "40", "40", "--json"],
        env,
        tmpDir,
      );
      expect(doubleClicked.code).toBe(0);
      const doubleReport = parseJson(doubleClicked);
      expect(doubleReport.ok).toBe(true);
      expect(doubleReport.button).toBe(1);

      const typed = await runCli(
        ["desktop", "type", "echo hi", "--json"],
        env,
        tmpDir,
      );
      expect(typed.code).toBe(0);
      expect(parseJson(typed).length).toBe(7);

      const keyed = await runCli(
        ["desktop", "key", "Return", "--json"],
        env,
        tmpDir,
      );
      expect(keyed.code).toBe(0);
      expect(parseJson(keyed).key).toBe("Return");
    },
    60_000,
  );

  it("rejects out-of-range --button values", async () => {
    const env = makeEnv();
    for (const button of ["0", "10"]) {
      const result = await runCli(
        ["desktop", "click", "1", "1", "--button", button, "--json"],
        env,
      );
      expect(result.code).toBe(1);
      expect(parseJson(result).errors.join("\n")).toContain(
        "between 1 and 9",
      );
    }
  });

  it("rejects invalid move coordinates", async () => {
    const env = makeEnv();
    for (const coords of [["-1", "5"], ["1.5", "5"], ["x", "5"]]) {
      const result = await runCli(
        ["desktop", "move", "--json", "--", ...coords],
        env,
      );
      expect(result.code).toBe(1);
      expect(parseJson(result).errors.join("\n")).toContain(
        "non-negative integer",
      );
    }
  });

  it("rejects invalid scroll deltas and --at positions", async () => {
    const env = makeEnv();
    for (const deltas of [["0.5", "1"], ["1", "abc"]]) {
      const result = await runCli(
        ["desktop", "scroll", "--json", "--", ...deltas],
        env,
      );
      expect(result.code).toBe(1);
      expect(parseJson(result).errors.join("\n")).toContain(
        "expected an integer",
      );
    }
    for (const delta of [["101", "0"], ["0", "-101"]]) {
      const result = await runCli(
        ["desktop", "scroll", "--json", "--", ...delta],
        env,
      );
      expect(result.code).toBe(1);
      expect(parseJson(result).errors.join("\n")).toContain(
        "at most 100 wheel steps",
      );
    }
    const zero = await runCli(
      ["desktop", "scroll", "0", "0", "--json"],
      env,
    );
    expect(zero.code).toBe(1);
    expect(parseJson(zero).errors.join("\n")).toContain("non-zero");

    const badAt = await runCli(
      ["desktop", "scroll", "0", "1", "--at", "10;20", "--json"],
      env,
    );
    expect(badAt.code).toBe(1);
    expect(parseJson(badAt).errors.join("\n")).toContain('--at "10;20"');
  }, 30_000);

  it("rejects invalid drag buttons and durations", async () => {
    const env = makeEnv();
    const badButton = await runCli(
      ["desktop", "drag", "0", "0", "1", "1", "--button", "10", "--json"],
      env,
    );
    expect(badButton.code).toBe(1);
    expect(parseJson(badButton).errors.join("\n")).toContain(
      "between 1 and 9",
    );

    for (const duration of ["-1", "10001", "1.5"]) {
      const result = await runCli(
        [
          "desktop",
          "drag",
          "0",
          "0",
          "1",
          "1",
          "--json",
          "--duration",
          duration,
        ],
        env,
      );
      expect(result.code).toBe(1);
      expect(parseJson(result).errors.join("\n")).toContain("--duration");
    }
  });

  it("rejects invalid double-click buttons and intervals", async () => {
    const env = makeEnv();
    const badButton = await runCli(
      ["desktop", "double-click", "1", "1", "--button", "0", "--json"],
      env,
    );
    expect(badButton.code).toBe(1);
    expect(parseJson(badButton).errors.join("\n")).toContain(
      "between 1 and 9",
    );

    for (const interval of ["-1", "2001", "0.5"]) {
      const result = await runCli(
        [
          "desktop",
          "double-click",
          "1",
          "1",
          "--json",
          "--interval",
          interval,
        ],
        env,
      );
      expect(result.code).toBe(1);
      expect(parseJson(result).errors.join("\n")).toContain("--interval");
    }
  });

  it("fails actionably when no desktop session is running", async () => {
    const env = makeEnv();
    const result = await runCli(["desktop", "click", "1", "1", "--json"], env);
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.errors.join("\n")).toContain("No running desktop session");
    expect(report.errors.join("\n")).toContain("session create --type desktop");
  });
});

describe("picklab android (fake adb)", () => {
  it("threads the serial through install-apk", async () => {
    const { env, adbLog } = fakeAdbEnv();
    const apk = path.join(tmpDir, "app.apk");
    fs.writeFileSync(apk, "apk");
    const result = await runCli(
      ["android", "install-apk", apk, "--serial", FAKE_SERIAL, "--json"],
      env,
    );
    expect(result.code).toBe(0);
    expect(parseJson(result).apkPath).toBe(apk);
    expect(adbLogLines(adbLog)).toEqual([
      `-s ${FAKE_SERIAL} install -r ${apk}`,
    ]);
  });

  it("launches apps via monkey and am start", async () => {
    const { env, adbLog } = fakeAdbEnv();
    const monkey = await runCli(
      [
        "android",
        "launch-app",
        "com.example.app",
        "--serial",
        FAKE_SERIAL,
        "--json",
      ],
      env,
    );
    expect(monkey.code).toBe(0);
    const activity = await runCli(
      [
        "android",
        "launch-app",
        "com.example.app",
        "--activity",
        ".MainActivity",
        "--serial",
        FAKE_SERIAL,
        "--json",
      ],
      env,
    );
    expect(activity.code).toBe(0);
    expect(adbLogLines(adbLog)).toEqual([
      `-s ${FAKE_SERIAL} shell monkey -p com.example.app -c android.intent.category.LAUNCHER 1`,
      `-s ${FAKE_SERIAL} shell am start -n com.example.app/.MainActivity`,
    ]);
  });

  it("taps, types, and presses back/home with exact adb argv", async () => {
    const { env, adbLog } = fakeAdbEnv();
    for (const args of [
      ["android", "tap", "100", "200"],
      ["android", "type", "hello world"],
      ["android", "back"],
      ["android", "home"],
    ]) {
      const result = await runCli(
        [...args, "--serial", FAKE_SERIAL, "--json"],
        env,
      );
      expect(result.code).toBe(0);
    }
    expect(adbLogLines(adbLog)).toEqual([
      `-s ${FAKE_SERIAL} shell input tap 100 200`,
      `-s ${FAKE_SERIAL} shell input text hello%sworld`,
      `-s ${FAKE_SERIAL} shell input keyevent KEYCODE_BACK`,
      `-s ${FAKE_SERIAL} shell input keyevent KEYCODE_HOME`,
    ]);
  });

  it("screenshots the device into a run directory", async () => {
    const { env, adbLog } = fakeAdbEnv();
    const projectDir = makeProjectDir();
    const result = await runCli(
      [
        "android",
        "screenshot",
        "--serial",
        FAKE_SERIAL,
        "--project-dir",
        projectDir,
        "--json",
      ],
      env,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.runId).toMatch(/-android/);
    const data = fs.readFileSync(report.path);
    expect(data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(report.runDir, "manifest.json"), "utf8"),
    );
    expect(manifest.status).toBe("completed");
    expect(manifest.artifacts[0].type).toBe("screenshot");
    expect(adbLogLines(adbLog)).toEqual([
      `-s ${FAKE_SERIAL} exec-out screencap -p`,
    ]);
  });

  it("dumps the ui tree to stdout and to a file with secrets redacted", async () => {
    const { env, adbLog } = fakeAdbEnv();
    const result = await runCli(
      ["android", "ui-tree", "--serial", FAKE_SERIAL],
      env,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("<hierarchy");
    expect(result.stdout).toContain("</hierarchy>");
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain(PLANTED_TOKEN);

    const json = await runCli(
      ["android", "ui-tree", "--serial", FAKE_SERIAL, "--json"],
      env,
    );
    expect(json.code).toBe(0);
    const jsonReport = parseJson(json);
    expect(jsonReport.xml).toContain("[REDACTED]");
    expect(jsonReport.xml).toContain("</hierarchy>");
    expect(jsonReport.xml).not.toContain(PLANTED_TOKEN);

    const out = path.join(tmpDir, "ui.xml");
    const fileResult = await runCli(
      ["android", "ui-tree", "--serial", FAKE_SERIAL, "--out", out, "--json"],
      env,
    );
    expect(fileResult.code).toBe(0);
    expect(parseJson(fileResult).path).toBe(out);
    const fileContents = fs.readFileSync(out, "utf8");
    expect(fileContents).toContain("<hierarchy");
    expect(fileContents).toContain("</hierarchy>");
    expect(fileContents).toContain("[REDACTED]");
    expect(fileContents).not.toContain(PLANTED_TOKEN);

    expect(adbLogLines(adbLog)).toEqual([
      `-s ${FAKE_SERIAL} shell uiautomator dump /sdcard/picklab-ui.xml`,
      `-s ${FAKE_SERIAL} exec-out cat /sdcard/picklab-ui.xml`,
      `-s ${FAKE_SERIAL} shell rm -f /sdcard/picklab-ui.xml`,
      `-s ${FAKE_SERIAL} shell uiautomator dump /sdcard/picklab-ui.xml`,
      `-s ${FAKE_SERIAL} exec-out cat /sdcard/picklab-ui.xml`,
      `-s ${FAKE_SERIAL} shell rm -f /sdcard/picklab-ui.xml`,
      `-s ${FAKE_SERIAL} shell uiautomator dump /sdcard/picklab-ui.xml`,
      `-s ${FAKE_SERIAL} exec-out cat /sdcard/picklab-ui.xml`,
      `-s ${FAKE_SERIAL} shell rm -f /sdcard/picklab-ui.xml`,
    ]);
  });

  it("redacts secrets from logcat output", async () => {
    const { env, adbLog } = fakeAdbEnv();
    const result = await runCli(
      ["android", "logcat", "--serial", FAKE_SERIAL],
      env,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain("ghp_");
    expect(result.stdout).toContain("I/App( 123): started");

    const limited = await runCli(
      ["android", "logcat", "--serial", FAKE_SERIAL, "--lines", "50", "--json"],
      env,
    );
    expect(limited.code).toBe(0);
    const report = parseJson(limited);
    expect(report.output).toContain("[REDACTED]");
    expect(report.output).not.toContain("ghp_");

    const cleared = await runCli(
      ["android", "logcat", "--serial", FAKE_SERIAL, "--clear", "--json"],
      env,
    );
    expect(cleared.code).toBe(0);
    expect(parseJson(cleared).cleared).toBe(true);

    expect(adbLogLines(adbLog)).toEqual([
      `-s ${FAKE_SERIAL} logcat -d -t 500`,
      `-s ${FAKE_SERIAL} logcat -d -t 50`,
      `-s ${FAKE_SERIAL} logcat -c`,
    ]);
  });

  it("passes raw adb commands through, threading the serial when given", async () => {
    const { env, adbLog } = fakeAdbEnv();
    const targeted = await runCli(
      ["android", "adb", "--serial", FAKE_SERIAL, "--", "shell", "ls", "/sdcard"],
      env,
    );
    expect(targeted.code).toBe(0);

    const raw = await runCli(["android", "adb", "--", "devices"], env);
    expect(raw.code).toBe(0);

    expect(adbLogLines(adbLog)).toEqual([
      `-s ${FAKE_SERIAL} shell ls /sdcard`,
      "devices",
    ]);
  });

  it("fails closed on ambiguous default android sessions instead of running raw adb", async () => {
    const { env, adbLog } = fakeAdbEnv();
    const projectDir = makeProjectDir();
    const sessionsDir = path.join(env.PICKLAB_HOME, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (const [id, serial] of [
      ["andr-11111111", "emulator-5554"],
      ["andr-22222222", "emulator-5556"],
    ]) {
      fs.writeFileSync(
        path.join(sessionsDir, `${id}.json`),
        `${JSON.stringify({
          id,
          type: "android",
          createdAt: "2026-06-09T12:00:00.000Z",
          status: "running",
          projectDir,
          android: { avdName: "picklab-avd", serial, consolePort: 5554 },
        })}\n`,
      );
    }
    const result = await runCli(
      [
        "android",
        "adb",
        "--json",
        "--project-dir",
        projectDir,
        "--",
        "devices",
      ],
      env,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain(
      "Multiple running android sessions",
    );
    expect(adbLogLines(adbLog)).toEqual([]);
  });

  it("fails closed when another project owns the only android session", async () => {
    const { env, adbLog } = fakeAdbEnv();
    const ownerProject = makeProjectDir("owner");
    const otherProject = makeProjectDir("other");
    const sessionsDir = path.join(env.PICKLAB_HOME, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "andr-33333333.json"),
      `${JSON.stringify({
        id: "andr-33333333",
        type: "android",
        createdAt: "2026-06-09T12:00:00.000Z",
        status: "running",
        projectDir: ownerProject,
        android: { avdName: "picklab-avd", serial: FAKE_SERIAL, consolePort: 5554 },
      })}\n`,
    );
    const result = await runCli(
      ["android", "adb", "--json", "--project-dir", otherProject, "--", "devices"],
      env,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain(
      "other projects have running android sessions",
    );
    expect(adbLogLines(adbLog)).toEqual([]);
  });

  it("rejects --session together with --serial", async () => {
    const { env } = fakeAdbEnv();
    const result = await runCli(
      [
        "android",
        "tap",
        "1",
        "2",
        "--session",
        "andr-12345678",
        "--serial",
        FAKE_SERIAL,
        "--json",
      ],
      env,
    );
    expect(result.code).toBe(1);
    expect(parseJson(result).errors.join("\n")).toContain("not both");
  });

  it("rejects a desktop session id passed to an android command", async () => {
    const { env } = fakeAdbEnv();
    const sessionsDir = path.join(env.PICKLAB_HOME, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "desk-12345678.json"),
      `${JSON.stringify({
        id: "desk-12345678",
        type: "desktop",
        createdAt: "2026-06-09T12:00:00.000Z",
        status: "running",
        projectDir: tmpDir,
        desktop: { display: ":99" },
      })}\n`,
    );
    const result = await runCli(
      ["android", "tap", "1", "2", "--session", "desk-12345678", "--json"],
      env,
    );
    expect(result.code).toBe(1);
    const errors = parseJson(result).errors.join("\n");
    expect(errors).toContain('type "desktop"');
    expect(errors).toContain("needs a android session");
  });

  it("rejects --out together with --run for screenshots", async () => {
    const { env, adbLog } = fakeAdbEnv();
    const result = await runCli(
      [
        "android",
        "screenshot",
        "--serial",
        FAKE_SERIAL,
        "--out",
        path.join(tmpDir, "x.png"),
        "--run",
        "slug",
        "--json",
      ],
      env,
    );
    expect(result.code).toBe(1);
    expect(parseJson(result).errors.join("\n")).toContain(
      "either --out or --run",
    );
    expect(adbLogLines(adbLog)).toEqual([]);
  });

  it("fails actionably when no android session or serial is given", async () => {
    const { env } = fakeAdbEnv();
    const result = await runCli(["android", "tap", "1", "2", "--json"], env);
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.errors.join("\n")).toContain("No running android session");
  });
});

describe("picklab android session lifecycle (fake sdk)", () => {
  it(
    "starts an emulator session, resolves it implicitly, and destroys it",
    async () => {
      const { sdk, adbLog, pidFile } = makeFakeAndroidSdk();
      const env = makeEnv({ extra: { ANDROID_HOME: sdk } });
      const projectDir = makeProjectDir();

      const started = await runCli(
        ["android", "start", "--json", "--project-dir", projectDir],
        env,
      );
      expect(started.code).toBe(0);
      const startReport = parseJson(started);
      expect(startReport.ok).toBe(true);
      const session = startReport.sessions[0];
      expect(session.id).toMatch(/^andr-[0-9a-f]+$/);
      expect(session.type).toBe("android");
      expect(session.avdName).toBe("picklab-avd");
      expect(session.serial).toBe(AUTO_ALLOCATED_SERIAL);

      const tap = await runCli(
        ["android", "tap", "10", "20", "--json", "--project-dir", projectDir],
        env,
      );
      expect(tap.code).toBe(0);
      expect(parseJson(tap).sessionId).toBe(session.id);
      expect(adbLogLines(adbLog)).toContain(
        `-s ${AUTO_ALLOCATED_SERIAL} shell input tap 10 20`,
      );

      const status = parseJson(
        await runCli(["session", "status", session.id, "--json"], env),
      );
      expect(status.sessions[0].android.emulatorAlive).toBe(true);
      expect(status.sessions[0].android.serial).toBe(AUTO_ALLOCATED_SERIAL);

      const destroyed = await runCli(
        ["session", "destroy", session.id, "--json"],
        env,
      );
      expect(destroyed.code).toBe(0);
      expect(parseJson(destroyed).destroyed).toEqual([session.id]);
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      expect(() => process.kill(pid, 0)).toThrow();

      const after = await runCli(["session", "status", "--json"], env);
      expect(parseJson(after).sessions).toEqual([]);
    },
    60_000,
  );

  it(
    "ignores auto viewer mode for Android-only sessions but rejects an explicit viewer",
    async () => {
      const { sdk } = makeFakeAndroidSdk();
      const env = makeEnv({ extra: { ANDROID_HOME: sdk } });
      cleanupEnvs.push(env);
      const projectDir = makeProjectDir();
      const configPath = path.join(projectDir, ".picklab", "config.json");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ viewer: { mode: "auto" } }));

      const automatic = await runCli(
        ["session", "create", "--type", "android", "--json"],
        env,
        projectDir,
      );
      expect(automatic.code).toBe(0);
      const automaticReport = parseJson(automatic);
      expect(automaticReport.sessions[0].type).toBe("android");
      expect(automaticReport.viewer).toBeUndefined();

      const explicit = await runCli(
        ["session", "create", "--type", "android", "--viewer", "--json"],
        env,
        projectDir,
      );
      expect(explicit.code).toBe(1);
      expect(parseJson(explicit).errors.join("\n")).toContain(
        "--viewer requires a desktop-capable session type",
      );
    },
    60_000,
  );
});

describe("picklab artifacts", () => {
  it("lists runs with artifact counts", async () => {
    const env = makeEnv();
    const projectDir = makeProjectDir();
    writeSyntheticRun(projectDir, "20260609-110000-synthetic", {
      createdAt: "2026-06-09T11:00:00.000Z",
      artifacts: [],
      status: "failed",
    });
    writeSyntheticRun(projectDir, "20260609-120000-synthetic");

    const result = await runCli(
      ["artifacts", "list", "--json", "--project-dir", projectDir],
      env,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.runs).toEqual([
      {
        runId: "20260609-120000-synthetic",
        slug: "synthetic",
        createdAt: "2026-06-09T12:00:00.000Z",
        status: "completed",
        artifacts: 1,
      },
      {
        runId: "20260609-110000-synthetic",
        slug: "synthetic",
        createdAt: "2026-06-09T11:00:00.000Z",
        status: "failed",
        artifacts: 0,
      },
    ]);
  });

  it("lists an empty project", async () => {
    const env = makeEnv();
    const projectDir = makeProjectDir();
    const result = await runCli(
      ["artifacts", "list", "--json", "--project-dir", projectDir],
      env,
    );
    expect(result.code).toBe(0);
    expect(parseJson(result).runs).toEqual([]);
  });

  it("renders a markdown report for the latest run by default", async () => {
    const env = makeEnv();
    const projectDir = makeProjectDir();
    writeSyntheticRun(projectDir, "20260609-110000-synthetic", {
      createdAt: "2026-06-09T11:00:00.000Z",
    });
    writeSyntheticRun(projectDir, "20260609-120000-synthetic", {
      sessionId: "desk-12345678",
      evidenceVersion: 1,
      actionLog: "actions.jsonl",
    });
    fs.writeFileSync(
      path.join(
        projectDir,
        ".picklab",
        "runs",
        "20260609-120000-synthetic",
        "actions.jsonl",
      ),
      [
        JSON.stringify({
          actionId: "second",
          source: "mcp",
          tool: "desktop_type",
          startedAt: "2026-06-09T12:00:04.000Z",
          status: "error",
          error: `Authorization: Bearer ${PLANTED_TOKEN}`,
        }),
        JSON.stringify({
          actionId: "first",
          source: "mcp",
          tool: "desktop_click",
          startedAt: "2026-06-09T12:00:03.000Z",
          status: "ok",
        }),
        "",
      ].join("\n"),
    );

    const result = await runCli(
      ["artifacts", "report", "--project-dir", projectDir],
      env,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# PickLab run 20260609-120000-synthetic");
    expect(result.stdout).toContain("- Status: completed");
    expect(result.stdout).toContain("- Session: desk-12345678");
    expect(result.stdout).toContain(
      "- [screenshot] screenshot.png — screenshots/screenshot.png",
    );
    expect(result.stdout.indexOf("Step 1 — mcp / desktop_click")).toBeLessThan(
      result.stdout.indexOf("Step 2 — mcp / desktop_type"),
    );
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain(PLANTED_TOKEN);

    const specific = await runCli(
      [
        "artifacts",
        "report",
        "20260609-110000-synthetic",
        "--project-dir",
        projectDir,
        "--json",
      ],
      env,
    );
    expect(specific.code).toBe(0);
    const report = parseJson(specific);
    expect(report.manifest.runId).toBe("20260609-110000-synthetic");
    expect(report.dir).toBe(
      path.join(projectDir, ".picklab", "runs", "20260609-110000-synthetic"),
    );

    const legacy = await runCli(
      [
        "artifacts",
        "report",
        "20260609-110000-synthetic",
        "--project-dir",
        projectDir,
      ],
      env,
    );
    expect(legacy.code).toBe(0);
    expect(legacy.stdout).not.toContain("## Actions");
  });

  it("fails actionably for a corrupt evidence journal", async () => {
    const env = makeEnv();
    const projectDir = makeProjectDir();
    const runId = "20260609-120000-corrupt";
    writeSyntheticRun(projectDir, runId, {
      evidenceVersion: 1,
      actionLog: "actions.jsonl",
    });
    fs.writeFileSync(
      path.join(projectDir, ".picklab", "runs", runId, "actions.jsonl"),
      '{"actionId":"ok"}\nnot-json\n',
    );

    const result = await runCli(
      ["artifacts", "report", runId, "--project-dir", projectDir, "--json"],
      env,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.errors[0]).toContain("Corrupt evidence journal");
  });

  it("fails closed for an unsafe evidence journal", async () => {
    const env = makeEnv();
    const projectDir = makeProjectDir();
    const runId = "20260609-120000-unsafe";
    writeSyntheticRun(projectDir, runId, {
      evidenceVersion: 1,
      actionLog: "actions.jsonl",
    });
    const runDir = path.join(projectDir, ".picklab", "runs", runId);
    fs.symlinkSync(
      path.join(runDir, "manifest.json"),
      path.join(runDir, "actions.jsonl"),
    );

    const result = await runCli(
      ["artifacts", "report", runId, "--project-dir", projectDir, "--json"],
      env,
    );
    expect(result.code).toBe(1);
    expect(parseJson(result).errors.join("\n")).toContain(
      "Unsafe run catalog file",
    );
  });

  it("fails for unknown run ids", async () => {
    const env = makeEnv();
    const projectDir = makeProjectDir();
    const report = await runCli(
      ["artifacts", "report", "nope", "--project-dir", projectDir, "--json"],
      env,
    );
    expect(report.code).toBe(1);
    expect(parseJson(report).errors.join("\n")).toContain("Run not found");

    const open = await runCli(
      ["artifacts", "open", "nope", "--project-dir", projectDir, "--json"],
      env,
    );
    expect(open.code).toBe(1);
    expect(parseJson(open).errors.join("\n")).toContain("Run not found");
  });

  it("rejects manifests whose runId escapes the runs directory", async () => {
    const env = makeEnv();
    const projectDir = makeProjectDir();
    writeSyntheticRun(projectDir, "20260609-130000-evil", {
      runId: "../../escape",
      createdAt: "2026-06-09T13:00:00.000Z",
    });

    const open = await runCli(
      [
        "artifacts",
        "open",
        "../../escape",
        "--project-dir",
        projectDir,
        "--json",
      ],
      env,
    );
    expect(open.code).toBe(1);
    const openReport = parseJson(open);
    expect(openReport.dir).toBeUndefined();
    expect(openReport.errors.join("\n")).toContain("Run not found");
    expect(open.stdout).not.toContain(path.join(projectDir, "escape"));

    const latest = await runCli(
      ["artifacts", "report", "--project-dir", projectDir, "--json"],
      env,
    );
    expect(latest.code).toBe(1);
    expect(parseJson(latest).errors.join("\n")).toContain("No runs found");
    expect(latest.stdout).not.toContain(path.join(projectDir, "escape"));
  });

  it("prints the run directory for artifacts open without a display", async () => {
    const env = makeEnv();
    const projectDir = makeProjectDir();
    writeSyntheticRun(projectDir, "20260609-120000-synthetic");
    const result = await runCli(
      [
        "artifacts",
        "open",
        "20260609-120000-synthetic",
        "--project-dir",
        projectDir,
        "--json",
      ],
      env,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.dir).toBe(
      path.join(projectDir, ".picklab", "runs", "20260609-120000-synthetic"),
    );
    expect(report.opened).toBe(false);

    const human = await runCli(
      [
        "artifacts",
        "open",
        "20260609-120000-synthetic",
        "--project-dir",
        projectDir,
      ],
      env,
    );
    expect(human.code).toBe(0);
    expect(human.stdout.trim()).toBe(report.dir);
  });
});

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, any>;
  error?: Record<string, any>;
}

interface McpDialogue {
  responses: Map<number, JsonRpcResponse>;
  exitCode: number | null;
}

function speakMcp(
  argv: string[],
  env: Record<string, string>,
): Promise<McpDialogue> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = new Map<number, JsonRpcResponse>();
    let buffer = "";
    let settled = false;
    let stdinEnded = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for MCP responses"));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") {
          let message: JsonRpcResponse | undefined;
          try {
            message = JSON.parse(line) as JsonRpcResponse;
          } catch {
            message = undefined;
          }
          if (message !== undefined && typeof message.id === "number") {
            responses.set(message.id, message);
          }
        }
        if (responses.has(2) && !stdinEnded) {
          stdinEnded = true;
          child.stdin.end();
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ responses, exitCode: code });
      }
    });
    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "picklab-test", version: "0.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

describe("picklab mcp serve", () => {
  const mcpEntry = fileURLToPath(
    new URL("../dist/picklab-mcp.js", import.meta.url),
  );

  it("serves MCP over stdio and exits 0 when the client closes stdin", async () => {
    const env = makeEnv();
    const { responses, exitCode } = await speakMcp(
      [cliPath, "mcp", "serve"],
      env,
    );

    expect(exitCode).toBe(0);
    const init = responses.get(1);
    expect(init?.result?.serverInfo?.name).toBe("picklab");
    const tools = responses.get(2)?.result?.tools as Array<{ name: string }>;
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("session_create");
    expect(names).toContain("desktop_screenshot");
    expect(names).toContain("android_run_adb");
    expect(names).toContain("artifact_report");
  }, 60_000);

  it("serves MCP over stdio via the picklab-mcp bin and exits 0", async () => {
    const env = makeEnv();
    const { responses, exitCode } = await speakMcp([mcpEntry], env);
    expect(exitCode).toBe(0);
    expect(responses.get(1)?.result?.serverInfo?.name).toBe("picklab");
    const tools = responses.get(2)?.result?.tools as Array<{ name: string }>;
    expect(tools.length).toBeGreaterThanOrEqual(21);
  }, 60_000);
});
