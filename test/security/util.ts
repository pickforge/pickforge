import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeScript } from "../../packages/mcp-server/test/helpers.js";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const packagesDir = path.join(repoRoot, "packages");

export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export function listPackageSourceFiles(packageName?: string): string[] {
  const names =
    packageName === undefined
      ? fs
          .readdirSync(packagesDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [packageName];
  const files: string[] = [];
  for (const name of names) {
    const src = path.join(packagesDir, name, "src");
    if (fs.existsSync(src)) {
      files.push(
        ...listFilesRecursive(src).filter((file) => file.endsWith(".ts")),
      );
    }
  }
  return files;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RecorderAdbOptions {
  record: string;
  logcatLines?: string[];
  uiTreeXml?: string;
}

/**
 * A fake Android SDK whose adb records every invocation with exact argument
 * boundaries (one ARG line per argv element, END after each invocation), so
 * tests can prove arguments arrive verbatim without shell interpretation.
 */
export function makeRecorderAdbSdk(
  root: string,
  opts: RecorderAdbOptions,
): string {
  const sdk = path.join(root, "recorder-sdk");
  const lines = [
    "{",
    '  for a in "$@"; do',
    "    printf 'ARG\\t%s\\n' \"$a\"",
    "  done",
    "  printf 'END\\n'",
    `} >> ${shellQuote(opts.record)}`,
    'case "$*" in',
    "  *\"screencap -p\"*) printf '\\211PNG\\r\\n\\032\\n' ;;",
    '  *"uiautomator dump"*) echo "UI hierchary dumped to: /sdcard/pickforge-lab-ui.xml" ;;',
  ];
  if (opts.uiTreeXml !== undefined) {
    lines.push(
      `  *"cat /sdcard/pickforge-lab-ui.xml"*) printf '%s' ${shellQuote(opts.uiTreeXml)} ;;`,
    );
  }
  if (opts.logcatLines !== undefined) {
    lines.push(
      `  *"logcat -d"*) printf '%s\\n' ${opts.logcatLines
        .map(shellQuote)
        .join(" ")} ;;`,
    );
  }
  lines.push("esac", "exit 0");
  writeScript(path.join(sdk, "platform-tools", "adb"), lines.join("\n"));
  return sdk;
}

export function readRecordedInvocations(record: string): string[][] {
  if (!fs.existsSync(record)) {
    return [];
  }
  const invocations: string[][] = [];
  let current: string[] = [];
  for (const line of fs.readFileSync(record, "utf8").split("\n")) {
    if (line === "END") {
      invocations.push(current);
      current = [];
    } else if (line.startsWith("ARG\t")) {
      current.push(line.slice("ARG\t".length));
    }
  }
  return invocations;
}

/** Plants a fake sudo on PATH that records any invocation to a file. */
export function plantSudoRecorder(binDir: string, record: string): void {
  writeScript(
    path.join(binDir, "sudo"),
    `printf '%s\\n' "$*" >> ${shellQuote(record)}\nexit 0`,
  );
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export const cliDistPath = path.join(
  packagesDir,
  "cli",
  "dist",
  "picklab.js",
);

export function runBuiltCli(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliDistPath, ...args], {
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
