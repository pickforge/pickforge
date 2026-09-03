import fs from "node:fs";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  destroySessionRecord,
  isPidAlive,
  listSessions,
  readProcessIdentity,
  stopPid,
} from "@pickforge/lab-core";
import { runWatch, watchDesktopSession } from "../src/commands/watch.js";

let root: string;
let binDir: string;
let syntheticDisplayNumber: number;

function syntheticDisplay(): string {
  return `:${syntheticDisplayNumber}`;
}

function syntheticVncPort(): number {
  return 5_900 + syntheticDisplayNumber;
}
const originalEnv = {
  PICKFORGE_HOME: process.env.PICKFORGE_HOME,
  PATH: process.env.PATH,
  DISPLAY: process.env.DISPLAY,
  WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function executable(name: string, source: string): Promise<void> {
  const file = path.join(binDir, name);
  await fs.promises.writeFile(file, `#!${process.execPath}\n${source}`, "utf8");
  await fs.promises.chmod(file, 0o755);
}

async function createDesktop(
  display: string,
  desktop: Record<string, unknown> = {},
): Promise<string> {
  const record = await createSession({
    type: "desktop",
    projectDir: root,
    status: "running",
    desktop: { display, ...desktop },
  });
  return record.id;
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-watch-unit-"));
  binDir = path.join(root, "bin");
  await fs.promises.mkdir(binDir, { recursive: true });
  const reservation = net.createServer();
  const listening = once(reservation, "listening");
  reservation.listen(0, "127.0.0.1");
  await listening;
  const address = reservation.address();
  if (address === null || typeof address === "string" || address.port <= 5_900) {
    throw new Error("could not reserve a synthetic VNC port");
  }
  syntheticDisplayNumber = address.port - 5_900;
  const closed = once(reservation, "close");
  reservation.close();
  await closed;
  process.env.PICKFORGE_HOME = path.join(root, "home");
  process.env.PATH = binDir;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const record of await listSessions()) {
    const pid = record.desktop?.vncPid;
    if (pid !== undefined && pid !== process.pid && isPidAlive(pid)) {
      await stopPid(pid, { timeoutMs: 500 }).catch(() => {});
    }
    await destroySessionRecord(record.id).catch(() => {});
  }
  restoreEnv("PICKFORGE_HOME");
  restoreEnv("PATH");
  restoreEnv("DISPLAY");
  restoreEnv("WAYLAND_DISPLAY");
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function installVnc(): Promise<void> {
  await executable(
    "x11vnc",
    `const net = require("node:net");\nconst args = process.argv.slice(2);\nconst port = Number(args[args.indexOf("-rfbport") + 1]);\nconst server = net.createServer((socket) => socket.end());\nserver.listen(port, "127.0.0.1");\nprocess.on("SIGTERM", () => server.close(() => process.exit(0)));\n`,
  );
}

describe("watch command in process", () => {
  it("reports an actionable JSON error when no session exists", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runWatch({ json: true, projectDir: root });

    expect(code).toBe(1);
    const report = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain(
      "pickforge-lab session create --type desktop",
    );
  });

  it("fails closed when desktop sessions are ambiguous", async () => {
    await createDesktop(syntheticDisplay());
    await createDesktop(syntheticDisplay());

    await expect(
      watchDesktopSession({ projectDir: root }),
    ).rejects.toThrow(/Multiple running desktop sessions/);
  });

  it("starts VNC headlessly and returns endpoint guidance without a viewer", async () => {
    await installVnc();
    const id = await createDesktop(syntheticDisplay());

    const result = await watchDesktopSession({ session: id, projectDir: root });

    expect(result.data).toMatchObject({
      sessionId: id,
      opened: false,
      vncReused: false,
    });
    expect(result.lines?.join("\n")).toContain("viewer not opened");
    expect(result.lines?.join("\n")).toContain("ssh -N -L");
  });

  it("opens a viewer, waits for exit, then reuses the same VNC server", async () => {
    await installVnc();
    await executable(
      "remote-viewer",
      `process.stdout.write("ignored viewer output\\n");\nprocess.exit(0);\n`,
    );
    process.env.DISPLAY = ":0";
    const id = await createDesktop(syntheticDisplay());

    const first = await watchDesktopSession({ session: id, projectDir: root });
    const second = await watchDesktopSession({ session: id, projectDir: root });

    expect(first.data).toMatchObject({
      opened: true,
      viewer: "remote-viewer",
      viewerExitCode: 0,
      vncReused: false,
    });
    expect(second.data).toMatchObject({ opened: true, vncReused: true });
    expect(first.lines?.join("\n")).toContain("viewer closed");
  });

  it("rejects a writable VNC server instead of attaching a viewer", async () => {
    const identity = readProcessIdentity(process.pid);
    if (identity === undefined) throw new Error("test process identity missing");
    const id = await createDesktop(syntheticDisplay(), {
      vncPid: process.pid,
      vncStartTimeTicks: identity.startTicks,
      vncPort: syntheticVncPort(),
      vncViewOnly: false,
    });

    await expect(
      watchDesktopSession({ session: id, projectDir: root }),
    ).rejects.toThrow(/server-enforced read-only VNC/);
  });

  it("fails when an explicit viewer exits nonzero without stopping VNC", async () => {
    await installVnc();
    await executable("remote-viewer", "process.exit(7);\n");
    process.env.DISPLAY = ":0";
    const id = await createDesktop(syntheticDisplay());

    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runWatch({ json: true, session: id, projectDir: root });
    expect(code).toBe(1);
    const report = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(report.errors.join("\n")).toMatch(
      /exited with code 7.*remain running/,
    );
    const record = (await listSessions()).find((candidate) => candidate.id === id);
    expect(record?.status).toBe("running");
    expect(
      record?.desktop?.vncPid !== undefined &&
        isPidAlive(record.desktop.vncPid),
    ).toBe(true);
  });

  it("fails when an explicit viewer exits on a signal without stopping VNC", async () => {
    await installVnc();
    await executable(
      "remote-viewer",
      'process.kill(process.pid, "SIGTERM");\n',
    );
    process.env.DISPLAY = ":0";
    const id = await createDesktop(syntheticDisplay());

    await expect(
      watchDesktopSession({ session: id, projectDir: root }),
    ).rejects.toThrow(/exited on signal SIGTERM.*remain running/);
    const record = (await listSessions()).find((candidate) => candidate.id === id);
    expect(record?.status).toBe("running");
    expect(
      record?.desktop?.vncPid !== undefined &&
        isPidAlive(record.desktop.vncPid),
    ).toBe(true);
  });
});
