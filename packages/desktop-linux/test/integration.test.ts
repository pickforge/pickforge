import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  createRun,
  getSession,
  isPidAlive,
  processIdentityMatches,
  runCommand,
  stopPid,
  updateSession,
  type EnvLike,
} from "@pickforge/picklab-core";
import {
  XvfbStartError,
  allocateDisplay,
  click,
  createDesktopSession,
  destroyDesktopSession,
  detectScreenshotTool,
  detectVncBinary,
  doubleClick,
  drag,
  execApp,
  findOnPath,
  getDesktopSessionStatus,
  isDisplayAlive,
  launchApp,
  listWindows,
  move,
  parseDisplayNumber,
  pressKey,
  screenshot,
  scroll,
  startVnc,
  startXvfb,
  typeText,
  waitForWindow,
  type DesktopSessionHandle,
} from "../src/index.js";

const hasXvfb = findOnPath("Xvfb") !== null;
const hasXdotool = findOnPath("xdotool") !== null;
const hasDesktopStack = hasXvfb && hasXdotool;
const screenshotTool = detectScreenshotTool();
const hasXterm = findOnPath("xterm") !== null;
const hasZenity = findOnPath("zenity") !== null;
const hasVnc = detectVncBinary() !== null;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEST_TIMEOUT_MS = 30_000;
const DEAD_DISPLAY = ":219";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "picklab-desktop-test-"));
const home = path.join(tmpRoot, "home");
const projectDir = path.join(tmpRoot, "project");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
const env: EnvLike = { ...process.env, PICKLAB_HOME: home };

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe("Xvfb startup failure ownership", () => {
  const fakeBin = path.join(tmpRoot, "fake-xvfb-bin");
  const fakeEnv: EnvLike = {
    ...env,
    PATH: `${fakeBin}${path.delimiter}${env.PATH ?? ""}`,
  };

  beforeAll(() => {
    writeExecutable(
      path.join(fakeBin, "Xvfb"),
      [
        "#!/usr/bin/env node",
        'if (process.env.FAKE_XVFB_MODE === "exit") process.exit(7);',
        'if (process.env.FAKE_XVFB_MODE === "stubborn") {',
        '  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {',
        "    process.on(signal, () => {});",
        "  }",
        "}",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
  });

  it("reports an exited child with its partial ownership state", async () => {
    const error = await startXvfb({
      display: ":240",
      logDir: path.join(tmpRoot, "xvfb-exit"),
      env: { ...fakeEnv, FAKE_XVFB_MODE: "exit" },
      waitTimeoutMs: 1000,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(XvfbStartError);
    expect(error).toMatchObject({
      reason: "exited",
      partial: {
        display: ":240",
        cleanupConfirmed: true,
      },
    });
    expect((error as XvfbStartError).partial?.pid).toBeGreaterThan(0);
  });

  it("reports abort only after the spawned group is confirmed gone", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await startXvfb({
      display: ":241",
      logDir: path.join(tmpRoot, "xvfb-abort"),
      env: { ...fakeEnv, FAKE_XVFB_MODE: "stall" },
      signal: controller.signal,
      waitTimeoutMs: 10_000,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(XvfbStartError);
    expect(error).toMatchObject({
      reason: "aborted",
      partial: {
        display: ":241",
        cleanupConfirmed: true,
      },
    });
    const partial = (error as XvfbStartError).partial;
    expect(partial?.pid).toBeGreaterThan(0);
    expect(
      processIdentityMatches({
        pid: partial?.pid ?? -1,
        startTicks: partial?.startTimeTicks ?? -1,
      }),
    ).toBe(false);
  });
});

async function pointerLocation(
  display: string,
): Promise<{ x: number; y: number }> {
  const result = await runCommand(
    "xdotool",
    ["getmouselocation", "--shell"],
    { env: { DISPLAY: display }, timeoutMs: 10_000, check: true },
  );
  const x = /(?:^|\n)X=(\d+)/.exec(result.stdout);
  const y = /(?:^|\n)Y=(\d+)/.exec(result.stdout);
  if (x === null || y === null) {
    throw new Error(`unexpected getmouselocation output: ${result.stdout}`);
  }
  return { x: Number(x[1]), y: Number(y[1]) };
}

function writeFakeXvfb(binDir: string): void {
  const fakeServer = path.join(binDir, "fake-xvfb.cjs");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    fakeServer,
    [
      'const fs = require("node:fs");',
      'const display = process.argv[2].slice(1);',
      'const lock = `/tmp/.X${display}-lock`;',
      'const socketDir = "/tmp/.X11-unix";',
      'const socket = `${socketDir}/X${display}`;',
      "const createdSocketDir = !fs.existsSync(socketDir);",
      "fs.mkdirSync(socketDir, { recursive: true });",
      'fs.writeFileSync(lock, `${process.pid}\\n`);',
      'fs.writeFileSync(socket, "");',
      "const cleanup = () => {",
      "  fs.rmSync(lock, { force: true });",
      "  fs.rmSync(socket, { force: true });",
      "  if (createdSocketDir) {",
      "    try { fs.rmdirSync(socketDir); } catch {}",
      "  }",
      "};",
      'process.on("SIGTERM", () => { cleanup(); process.exit(0); });',
      'process.on("SIGINT", () => { cleanup(); process.exit(0); });',
      'process.on("exit", cleanup);',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "Xvfb"),
    `exec '${process.execPath}' '${fakeServer}' "$@"`,
  );
}

describe("allocateDisplay", () => {
  it("returns a free display synchronously", () => {
    const display = allocateDisplay();
    expect(display).toMatch(/^:\d+$/);
  });
});

describe("createDesktopSession registry reaping", () => {
  it("removes stale running records before creating a new session", async () => {
    const isolatedHome = path.join(tmpRoot, "home-reap-desktop");
    const isolatedEnv: EnvLike = {
      ...process.env,
      PICKLAB_HOME: isolatedHome,
    };
    const binDir = path.join(tmpRoot, "fake-xvfb");
    writeFakeXvfb(binDir);
    const stale = await createSession(
      { type: "desktop", projectDir },
      isolatedEnv,
    );
    await updateSession(
      stale.id,
      {
        status: "running",
        desktop: { display: ":90", xvfbPid: 4_194_304 },
      },
      isolatedEnv,
    );

    const session = await createDesktopSession({
      projectDir,
      registryEnv: isolatedEnv,
      env: { PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin` },
    });
    try {
      expect(await getSession(stale.id, isolatedEnv)).toBeUndefined();
      expect(await getSession(session.id, isolatedEnv)).toBeDefined();
    } finally {
      await destroyDesktopSession(session.id, isolatedEnv).catch(() => {});
    }
  });
});

describe("screenshot tool detection failure", () => {
  it("rejects with install candidates when no tool is on PATH", async () => {
    await expect(
      screenshot({
        display: DEAD_DISPLAY,
        outPath: path.join(tmpRoot, "never.png"),
        env: { PATH: "" },
      }),
    ).rejects.toThrow(/install one of/i);
  });
});

describe("screenshot output validation", () => {
  it("rejects output without a PNG signature", async () => {
    const fakeBin = path.join(tmpRoot, "fake-import");
    writeExecutable(
      path.join(fakeBin, "import"),
      '#!/bin/sh\nout=""\nfor a in "$@"; do out="$a"; done\nprintf JUNKJUNK > "$out"\n',
    );
    await expect(
      screenshot({
        display: DEAD_DISPLAY,
        outPath: path.join(tmpRoot, "junk.png"),
        tool: "import",
        env: { PATH: fakeBin },
      }),
    ).rejects.toThrow(/PNG signature/);
  });

  it("captures without xdotool and warns that the window count is unavailable", async () => {
    const fakeBin = path.join(tmpRoot, "fake-import-without-xdotool");
    writeExecutable(
      path.join(fakeBin, "import"),
      '#!/bin/sh\nfor a in "$@"; do out="$a"; done\nprintf "\\211PNG\\r\\n\\032\\n" > "$out"\n',
    );

    const result = await screenshot({
      display: DEAD_DISPLAY,
      outPath: path.join(tmpRoot, "without-xdotool.png"),
      env: { PATH: fakeBin },
    });

    expect(result.windowCount).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining("xdotool")]);
    expect(result.warnings[0]).toContain("missing");
  });
});

describe("launchApp display isolation", () => {
  it("uses the shared X11 environment contract", async () => {
    const outFile = path.join(tmpRoot, "env-capture.txt");
    const binDir = path.join(tmpRoot, "env-capture-bin");
    writeExecutable(
      path.join(binDir, "capture-env"),
      "#!/bin/sh\n" +
        "printf 'DISPLAY=%s\\nWAYLAND_DISPLAY=%s\\nWAYLAND_SOCKET=%s\\n" +
        "GDK_BACKEND=%s\\nQT_QPA_PLATFORM=%s\\nSDL_VIDEODRIVER=%s\\n" +
        "WINIT_UNIX_BACKEND=%s\\nXDG_SESSION_TYPE=%s\\n' " +
        '"$DISPLAY" "${WAYLAND_DISPLAY-unset}" "${WAYLAND_SOCKET-unset}" ' +
        '"$GDK_BACKEND" "$QT_QPA_PLATFORM" "$SDL_VIDEODRIVER" ' +
        '"$WINIT_UNIX_BACKEND" "$XDG_SESSION_TYPE" > ' +
        `'${outFile}'\n` +
        "sleep 5\n",
    );
    const app = await launchApp({
      display: DEAD_DISPLAY,
      command: path.join(binDir, "capture-env"),
      env: {
        ...process.env,
        WAYLAND_DISPLAY: "wayland-1",
        WAYLAND_SOCKET: "42",
      },
      logDir: path.join(tmpRoot, "env-capture-logs"),
    });
    try {
      expect(fs.readFileSync(outFile, "utf8")).toBe(
        `DISPLAY=${DEAD_DISPLAY}\n` +
          "WAYLAND_DISPLAY=picklab-no-wayland\nWAYLAND_SOCKET=unset\n" +
          "GDK_BACKEND=x11\nQT_QPA_PLATFORM=xcb\n" +
          "SDL_VIDEODRIVER=x11\nWINIT_UNIX_BACKEND=x11\n" +
          "XDG_SESSION_TYPE=x11\n",
      );
    } finally {
      await stopPid(app.pid);
    }
  });
});

describe("launchApp early exit", () => {
  it("rejects with the log path when the command exits immediately", async () => {
    await expect(
      launchApp({
        display: DEAD_DISPLAY,
        command: "false",
        logDir: path.join(tmpRoot, "app-logs"),
      }),
    ).rejects.toThrow(/exited immediately[\s\S]*check the log at/);
  });
});

describe.skipIf(!hasXdotool)("window listing failures", () => {
  it("fails fast with the real cause on a dead display", async () => {
    const started = Date.now();
    await expect(
      waitForWindow(DEAD_DISPLAY, "anything", 10_000),
    ).rejects.toThrow(/xdotool search failed on :219/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports an actionable error when xdotool is missing", async () => {
    await expect(listWindows(DEAD_DISPLAY, { PATH: "" })).rejects.toThrow(
      /install xdotool/,
    );
  });
});

describe("hosted CI prerequisites", () => {
  it.skipIf(process.env.CI !== "true")(
    "has x11vnc installed so VNC tests cannot silently skip",
    () => {
      expect(hasVnc).toBe(true);
    },
  );
});

describe("startVnc startup supervision", () => {
  const dyingBin = path.join(tmpRoot, "fake-vnc-dying");
  const listeningBin = path.join(tmpRoot, "fake-vnc-listening");

  beforeAll(() => {
    writeExecutable(
      path.join(dyingBin, "x11vnc"),
      '#!/bin/sh\necho "fake x11vnc failure" >&2\nexit 7\n',
    );
    const serverJs = path.join(listeningBin, "fake-vnc-server.cjs");
    fs.mkdirSync(listeningBin, { recursive: true });
    fs.writeFileSync(
      serverJs,
      'const net = require("node:net");\n' +
        'const idx = process.argv.indexOf("-rfbport");\n' +
        "const port = Number(process.argv[idx + 1]);\n" +
        "const server = net.createServer(() => {});\n" +
        'server.listen(port, "127.0.0.1");\n',
    );
    writeExecutable(
      path.join(listeningBin, "x11vnc"),
      `#!/bin/sh\nexec '${process.execPath}' '${serverJs}' "$@"\n`,
    );
  });

  it("reports a missing binary actionably", async () => {
    await expect(
      startVnc({
        display: DEAD_DISPLAY,
        logDir: path.join(tmpRoot, "vnc-missing"),
        env: { PATH: "" },
      }),
    ).rejects.toThrow(/install x11vnc/);
  });

  it("fails with the log path when x11vnc exits during startup", async () => {
    await expect(
      startVnc({
        display: DEAD_DISPLAY,
        port: 56_791,
        logDir: path.join(tmpRoot, "vnc-dying"),
        env: { PATH: dyingBin },
      }),
    ).rejects.toThrow(/exited during startup[\s\S]*x11vnc\.log/);
  });

  it("spawns the detected binary and waits for its port to listen", async () => {
    const handle = await startVnc({
      display: DEAD_DISPLAY,
      port: 56_792,
      logDir: path.join(tmpRoot, "vnc-listening"),
      env: { PATH: listeningBin },
    });
    try {
      expect(handle.port).toBe(56_792);
      expect(isPidAlive(handle.pid)).toBe(true);
    } finally {
      await stopPid(handle.pid);
    }
  });

  it.skipIf(!hasXvfb)(
    "creates an explicitly writable VNC control session",
    async () => {
      const session = await createDesktopSession({
        projectDir,
        registryEnv: env,
        vncControl: true,
        env: {
          PATH: `${listeningBin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });
      try {
        expect(session.vncViewOnly).toBe(false);
        const record = await getSession(session.id, env);
        expect(record?.desktop?.vncViewOnly).toBe(false);
      } finally {
        await destroyDesktopSession(session.id, env);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasXvfb)(
    "threads the spawn env from createDesktopSession through to vnc",
    async () => {
      const session = await createDesktopSession({
        projectDir,
        registryEnv: env,
        vnc: true,
        env: {
          PATH: `${listeningBin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });
      try {
        expect(session.vncPid).toBeDefined();
        expect(session.vncPort).toBe(
          5900 + parseDisplayNumber(session.display),
        );
        expect(session.vncViewOnly).toBe(true);
        const record = await getSession(session.id, env);
        expect(record?.desktop?.vncViewOnly).toBe(true);
        expect(isPidAlive(session.vncPid as number)).toBe(true);
      } finally {
        await destroyDesktopSession(session.id, env);
      }
      expect(isPidAlive(session.vncPid as number)).toBe(false);
      expect(isPidAlive(session.xvfbPid)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!hasXvfb)("display allocation under contention", () => {
  it(
    "gives concurrent sessions distinct, independently destroyable displays",
    async () => {
      const settled = await Promise.allSettled([
        createDesktopSession({ projectDir, registryEnv: env }),
        createDesktopSession({ projectDir, registryEnv: env }),
      ]);
      const sessions = settled
        .filter(
          (r): r is PromiseFulfilledResult<DesktopSessionHandle> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);
      try {
        const rejections = settled
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => String(r.reason));
        expect(rejections).toEqual([]);
        const [a, b] = sessions as [
          DesktopSessionHandle,
          DesktopSessionHandle,
        ];
        expect(a.display).not.toBe(b.display);
        expect(isPidAlive(a.xvfbPid)).toBe(true);
        expect(isPidAlive(b.xvfbPid)).toBe(true);
        expect(isDisplayAlive(a.display)).toBe(true);
        expect(isDisplayAlive(b.display)).toBe(true);

        await destroyDesktopSession(a.id, env);
        expect(isPidAlive(a.xvfbPid)).toBe(false);
        expect(isPidAlive(b.xvfbPid)).toBe(true);
        expect(isDisplayAlive(b.display)).toBe(true);
      } finally {
        for (const session of sessions) {
          await destroyDesktopSession(session.id, env).catch(() => {});
        }
      }
      for (const session of sessions) {
        expect(isPidAlive(session.xvfbPid)).toBe(false);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses an explicit display owned by another server",
    async () => {
      const session = await createDesktopSession({
        projectDir,
        registryEnv: env,
      });
      try {
        await expect(
          startXvfb({
            display: session.display,
            logDir: path.join(tmpRoot, "xvfb-explicit"),
          }),
        ).rejects.toThrow(/another X server owns it/);
        expect(isPidAlive(session.xvfbPid)).toBe(true);
      } finally {
        await destroyDesktopSession(session.id, env);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe.skipIf(!hasDesktopStack)("desktop integration (Xvfb + xdotool)", () => {
  it(
    "runs an xvfb session and screenshots the display",
    async () => {
      const session = await createDesktopSession({
        projectDir,
        registryEnv: env,
        width: 800,
        height: 600,
      });
      try {
        expect(session.display).toMatch(/^:\d+$/);
        expect(isDisplayAlive(session.display)).toBe(true);
        expect(isPidAlive(session.xvfbPid)).toBe(true);
        expect(await listWindows(session.display)).toEqual([]);

        const status = await getDesktopSessionStatus(session.id, env);
        expect(status.record.status).toBe("running");
        expect(status.record.desktop?.display).toBe(session.display);
        expect(status.record.desktop?.width).toBe(800);
        expect(status.record.desktop?.height).toBe(600);
        expect(status.xvfbAlive).toBe(true);
        expect(status.displayAlive).toBe(true);

        if (screenshotTool !== null) {
          const outPath = path.join(tmpRoot, "session-shot.png");
          const result = await screenshot({
            display: session.display,
            outPath,
          });
          expect(result.tool).toBe(screenshotTool);
          const data = fs.readFileSync(outPath);
          expect(data.length).toBeGreaterThan(0);
          expect(data.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
        } else {
          console.warn(
            "no screenshot tool (import, xwd+convert, or scrot) found; skipping screenshot assertions",
          );
        }
      } finally {
        await destroyDesktopSession(session.id, env);
      }
      expect(isPidAlive(session.xvfbPid)).toBe(false);
      expect(isDisplayAlive(session.display)).toBe(false);
      expect(await getSession(session.id, env)).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasZenity)(
    "keeps a GTK exec client on Xvfb despite inherited Wayland variables",
    async () => {
      const session = await createDesktopSession({
        projectDir,
        registryEnv: env,
      });
      const guardedZenity = path.join(tmpRoot, "guarded-zenity");
      writeExecutable(
        guardedZenity,
        "#!/bin/sh\n" +
          '[ "$WAYLAND_DISPLAY" = picklab-no-wayland ] || exit 20\n' +
          '[ "${WAYLAND_SOCKET+set}" != set ] || exit 21\n' +
          '[ "$GDK_BACKEND" = x11 ] || exit 22\n' +
          '[ "$QT_QPA_PLATFORM" = xcb ] || exit 23\n' +
          '[ "$SDL_VIDEODRIVER" = x11 ] || exit 24\n' +
          '[ "$WINIT_UNIX_BACKEND" = x11 ] || exit 25\n' +
          '[ "$XDG_SESSION_TYPE" = x11 ] || exit 26\n' +
          'exec zenity --info --text picklab --title picklab-exec-itest\n',
      );
      try {
        const app = await execApp({
          display: session.display,
          command: guardedZenity,
          env: {
            ...process.env,
            WAYLAND_DISPLAY: "wayland-0",
            WAYLAND_SOCKET: "42",
          },
          logDir: session.logDir,
          windowTimeoutMs: 15_000,
        });
        expect(app.processGroupId).toBe(app.pid);
        expect(app.windows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "picklab-exec-itest" }),
          ]),
        );
        expect(await listWindows(session.display)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "picklab-exec-itest" }),
          ]),
        );
      } finally {
        await destroyDesktopSession(session.id, env);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasXterm)(
    "launches xterm and drives click, type, and key input",
    async () => {
      const session = await createDesktopSession({
        projectDir,
        registryEnv: env,
      });
      try {
        const app = await launchApp({
          display: session.display,
          command: "xterm",
          args: [
            "-xrm",
            "XTerm.vt100.allowTitleOps: false",
            "-T",
            "picklab-itest",
          ],
          logDir: session.logDir,
        });
        const win = await waitForWindow(
          session.display,
          "picklab-itest",
          15_000,
        );
        expect(win.id).toMatch(/^\d+$/);
        expect(win.name).toContain("picklab-itest");

        await click({ display: session.display, sessionId: session.id, env, x: 40, y: 40 });
        await typeText({ display: session.display, sessionId: session.id, env, text: "echo picklab" });
        await pressKey({ display: session.display, sessionId: session.id, env, key: "Return" });
        await pressKey({ display: session.display, sessionId: session.id, env, key: "ctrl+shift+t" });

        await move({ display: session.display, sessionId: session.id, env, x: 120, y: 90 });
        expect(await pointerLocation(session.display)).toEqual({
          x: 120,
          y: 90,
        });

        await scroll({ display: session.display, sessionId: session.id, env, deltaX: 0, deltaY: 2 });
        await scroll({
          display: session.display,
          sessionId: session.id,
          env,
          deltaX: -1,
          deltaY: -1,
          x: 60,
          y: 60,
        });
        expect(await pointerLocation(session.display)).toEqual({
          x: 60,
          y: 60,
        });

        await drag({
          display: session.display,
          sessionId: session.id,
          env,
          fromX: 30,
          fromY: 30,
          toX: 150,
          toY: 110,
          durationMs: 200,
        });
        expect(await pointerLocation(session.display)).toEqual({
          x: 150,
          y: 110,
        });

        await doubleClick({ display: session.display, sessionId: session.id, env, x: 45, y: 45 });
        expect(await pointerLocation(session.display)).toEqual({
          x: 45,
          y: 45,
        });

        expect(isPidAlive(app.pid)).toBe(true);
      } finally {
        await destroyDesktopSession(session.id, env);
      }
      expect(isPidAlive(session.xvfbPid)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasXterm)(
    "matches literal string window patterns containing regex metacharacters",
    async () => {
      const session = await createDesktopSession({
        projectDir,
        registryEnv: env,
      });
      try {
        await launchApp({
          display: session.display,
          command: "xterm",
          args: [
            "-xrm",
            "XTerm.vt100.allowTitleOps: false",
            "-T",
            "picklab c++ [itest]",
          ],
          logDir: session.logDir,
        });
        const win = await waitForWindow(
          session.display,
          "c++ [itest]",
          15_000,
        );
        expect(win.name).toContain("c++ [itest]");
        const reWin = await waitForWindow(
          session.display,
          /c\+\+ \[itest\]/,
          5_000,
        );
        expect(reWin.id).toBe(win.id);
      } finally {
        await destroyDesktopSession(session.id, env);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(screenshotTool === null)(
    "records a screenshot artifact in a run",
    async () => {
      const session = await createDesktopSession({
        projectDir,
        registryEnv: env,
      });
      try {
        const run = await createRun(projectDir, "desktop-shot", {
          sessionId: session.id,
        });
        const outPath = path.join(run.dir, "screenshots", "desktop.png");
        await screenshot({ display: session.display, outPath });
        await run.addArtifact("screenshot", "desktop.png", outPath);
        await run.finish();

        const data = fs.readFileSync(outPath);
        expect(data.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);

        const manifest = JSON.parse(
          fs.readFileSync(path.join(run.dir, "manifest.json"), "utf8"),
        );
        expect(manifest.status).toBe("completed");
        expect(manifest.sessionId).toBe(session.id);
        expect(manifest.artifacts).toHaveLength(1);
        expect(manifest.artifacts[0].type).toBe("screenshot");
        expect(manifest.artifacts[0].path).toBe(
          path.join("screenshots", "desktop.png"),
        );
      } finally {
        await destroyDesktopSession(session.id, env);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!hasVnc)(
    "attaches x11vnc to the session display",
    async () => {
      const session = await createDesktopSession({
        projectDir,
        registryEnv: env,
        vnc: true,
      });
      try {
        expect(session.vncPid).toBeDefined();
        expect(session.vncPort).toBeGreaterThan(0);
        const status = await getDesktopSessionStatus(session.id, env);
        expect(status.vncAlive).toBe(true);
      } finally {
        await destroyDesktopSession(session.id, env);
      }
      expect(isPidAlive(session.vncPid as number)).toBe(false);
      expect(isPidAlive(session.xvfbPid)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(hasVnc)(
    "fails session creation cleanly when VNC is requested without x11vnc",
    async () => {
      await expect(
        createDesktopSession({ projectDir, registryEnv: env, vnc: true }),
      ).rejects.toThrow(/x11vnc/);
    },
    TEST_TIMEOUT_MS,
  );
});
