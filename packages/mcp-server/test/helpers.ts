import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { createMcpServer } from "../src/index.js";

export const FAKE_SERIAL = "emulator-5554";
export const PLANTED_TOKEN = `ghp_${"a".repeat(36)}`;
export const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface LabDirs {
  root: string;
  home: string;
  projectDir: string;
  binDir: string;
}

export function makeLabDirs(): LabDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-mcp-"));
  const home = path.join(root, "pickforge-home");
  const projectDir = path.join(root, "project");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  return { root, home, projectDir, binDir };
}

export function removeLabDirs(dirs: LabDirs): void {
  fs.rmSync(dirs.root, { recursive: true, force: true });
}

export interface ConnectedLab {
  client: Client;
  server: McpServer;
  close(): Promise<void>;
}

export async function connectLab(opts: {
  projectDir: string;
  env: Record<string, string | undefined>;
}): Promise<ConnectedLab> {
  // Default new runs to the pre-#34 project-local layout so existing
  // fixtures (`writeSyntheticRun`, hardcoded `.picklab/runs` assertions)
  // keep working; individual tests can still override PICKFORGE_STORAGE_MODE
  // via opts.env to exercise the new "home" default explicitly.
  const server = createMcpServer({
    ...opts,
    env: { PICKFORGE_STORAGE_MODE: "project-local", ...opts.env },
  });
  const client = new Client({ name: "pickforge-lab-test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export function parseToolJson(result: unknown): Record<string, any> {
  const content = (result as Record<string, unknown>).content as Array<
    Record<string, any>
  >;
  const text = content.find((block) => block.type === "text");
  if (text === undefined) {
    throw new Error(`No text content in ${JSON.stringify(result)}`);
  }
  return JSON.parse(text.text as string) as Record<string, any>;
}

export function writeScript(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

export function writeFakeAdbSdk(root: string, adbLog: string): string {
  const sdk = path.join(root, "adb-sdk");
  const body = [
    `printf '%s\\n' "$*" >> "${adbLog}"`,
    'case "$*" in',
    "  *\"screencap -p\"*) printf '\\211PNG\\r\\n\\032\\n' ;;",
    '  *"uiautomator dump"*) echo "UI hierchary dumped to: /sdcard/pickforge-lab-ui.xml" ;;',
    `  *"cat /sdcard/pickforge-lab-ui.xml"*) printf '<?xml version="1.0"?><hierarchy rotation="0"><node text="token=${PLANTED_TOKEN}" /></hierarchy>' ;;`,
    `  *"logcat -d"*) printf 'I/Auth( 123): authToken=${PLANTED_TOKEN}\\nI/App( 123): started\\n' ;;`,
    '  *"install -r"*) echo Success ;;',
    '  *monkey*) echo "Events injected: 1" ;;',
    "esac",
    "exit 0",
  ].join("\n");
  writeScript(path.join(sdk, "platform-tools", "adb"), body);
  return sdk;
}

export function adbLogLines(adbLog: string): string[] {
  if (!fs.existsSync(adbLog)) {
    return [];
  }
  return fs.readFileSync(adbLog, "utf8").trim().split("\n");
}

export function makeFakeAndroidSdk(
  root: string,
  opts: { bootAfterPolls?: number } = {},
): {
  sdk: string;
  adbLog: string;
  pidFile: string;
} {
  const sdk = path.join(root, "sdk");
  const pidFile = path.join(sdk, "emulator.pid");
  const adbLog = path.join(sdk, "adb.log");
  const bootCount = path.join(sdk, "boot.count");
  const bootAfterPolls = opts.bootAfterPolls ?? 1;
  writeScript(
    path.join(sdk, "emulator", "emulator"),
    `echo $$ > "${pidFile}"\nPATH=/usr/bin:/bin\nexec sleep 120`,
  );
  writeScript(
    path.join(sdk, "platform-tools", "adb"),
    [
      `printf '%s\\n' "$*" >> "${adbLog}"`,
      'case "$*" in',
      "  *getprop*)",
      "    n=0",
      `    [ -f "${bootCount}" ] && read -r n < "${bootCount}"`,
      "    n=$((n+1))",
      `    echo "$n" > "${bootCount}"`,
      `    if [ "$n" -ge ${bootAfterPolls} ]; then echo 1; else echo 0; fi ;;`,
      '  devices) printf "List of devices attached\\n" ;;',
      `  *"emu kill"*) [ -f "${pidFile}" ] && kill "$(cat "${pidFile}")" 2>/dev/null ;;`,
      "esac",
      "exit 0",
    ].join("\n"),
  );
  return { sdk, adbLog, pidFile };
}

export function killFakeEmulator(pidFile: string): void {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // the fake emulator is already gone or was never started
  }
}

let sessionCounter = 0;

export function writeAndroidSessionRecord(
  home: string,
  projectDir: string,
  serial: string = FAKE_SERIAL,
): string {
  sessionCounter += 1;
  const id = `andr-${String(sessionCounter).padStart(6, "0")}`;
  const record = {
    id,
    type: "android",
    createdAt: new Date().toISOString(),
    status: "running",
    projectDir,
    android: { avdName: "pickforge-avd", serial, consolePort: 5554 },
  };
  const dir = path.join(home, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return id;
}

export function writeDesktopSessionRecord(
  home: string,
  projectDir: string,
): string {
  sessionCounter += 1;
  const id = `desk-${String(sessionCounter).padStart(6, "0")}`;
  const record = {
    id,
    type: "desktop",
    createdAt: new Date().toISOString(),
    status: "running",
    projectDir,
    desktop: { display: ":987", xvfbPid: 999999999 },
  };
  const dir = path.join(home, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return id;
}

export function writeSyntheticRun(
  projectDir: string,
  runId: string,
  opts: { logBody?: string; screenshotName?: string; logName?: string } = {},
): { dir: string } {
  const dir = path.join(projectDir, ".picklab", "runs", runId);
  const screenshotName = opts.screenshotName ?? "screenshot.png";
  const logName = opts.logName ?? "app.log";
  fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "screenshots", screenshotName),
    Buffer.concat([PNG_MAGIC, Buffer.from([0x00, 0x01, 0x02])]),
  );
  fs.writeFileSync(
    path.join(dir, "logs", logName),
    opts.logBody ?? `boot ok\ntoken=${PLANTED_TOKEN}\ndone\n`,
  );
  const manifest = {
    runId,
    slug: "synthetic",
    createdAt: "2026-06-09T12:00:00.000Z",
    status: "completed",
    artifacts: [
      {
        type: "screenshot",
        name: screenshotName,
        path: `screenshots/${screenshotName}`,
        createdAt: "2026-06-09T12:00:01.000Z",
      },
      {
        type: "log",
        name: logName,
        path: `logs/${logName}`,
        createdAt: "2026-06-09T12:00:02.000Z",
      },
    ],
  };
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { dir };
}
