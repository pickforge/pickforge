import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "@pickforge/lab-core";

const MAX_LOG_TAIL_BYTES = 8 * 1024;

function readLogTail(logPath: string): string {
  let fd: number | undefined;
  try {
    const size = fs.statSync(logPath).size;
    const length = Math.min(size, MAX_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(logPath, "r");
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8").trim();
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function devToolsPortStatus(
  profileDir: string,
  port: number | undefined,
): string {
  const activePortPath = path.join(profileDir, "DevToolsActivePort");
  if (port !== undefined) {
    return `published port ${port}, but its HTTP endpoint did not become ready`;
  }
  return fs.existsSync(activePortPath)
    ? "file exists but does not contain a valid port"
    : "file was not created";
}

/** Build bounded, redacted diagnostics that survive ephemeral CI cleanup. */
export function formatChromeStartupDiagnostics(
  profileDir: string,
  port?: number,
): string {
  const logPath = path.join(path.dirname(profileDir), "chrome.log");
  const logTail = redactSecrets(readLogTail(logPath));
  return (
    `DevToolsActivePort ${devToolsPortStatus(profileDir, port)}; ` +
    `chrome.log tail:\n${logTail === "" ? "[empty]" : logTail}`
  );
}
