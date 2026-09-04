import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "@pickforge/lab-core";

const MAX_LOG_TAIL_BYTES = 8 * 1024;

function dropPartialFirstLine(buffer: Buffer, truncated: boolean): Buffer {
  if (!truncated) return buffer;
  const newline = buffer.indexOf("\n");
  return newline === -1 ? buffer.subarray(buffer.length) : buffer.subarray(newline + 1);
}

function readLogTail(logPath: string | undefined): string {
  if (logPath === undefined) return "";
  let fd: number | undefined;
  try {
    const size = fs.statSync(logPath).size;
    const length = Math.min(size, MAX_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(logPath, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, length, size - length);
    const completeBytes = buffer.subarray(0, bytesRead);
    return dropPartialFirstLine(
      completeBytes,
      size > MAX_LOG_TAIL_BYTES,
    ).toString("utf8").trim();
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export type ChromeStartupFailureReason = "exited" | "timeout";

export interface ChromeStartupDiagnosticsOptions {
  profileDir: string;
  /** Authoritative daemon log path. Omit only when the caller has no daemon. */
  logPath?: string;
  reason: ChromeStartupFailureReason;
  port?: number;
}

function devToolsPortStatus(opts: ChromeStartupDiagnosticsOptions): string {
  const activePortPath = path.join(opts.profileDir, "DevToolsActivePort");
  if (opts.port !== undefined) {
    return opts.reason === "exited"
      ? `published port ${opts.port}, then the Chrome process exited`
      : `published port ${opts.port}, but its HTTP endpoint did not become ready before timeout`;
  }
  const fileStatus = fs.existsSync(activePortPath)
    ? "file exists but does not contain a valid port"
    : "file was not created";
  return opts.reason === "exited"
    ? `${fileStatus} before the Chrome process exited`
    : `${fileStatus} before timeout`;
}

/** Build bounded, redacted diagnostics that survive ephemeral cleanup. */
export function formatChromeStartupDiagnostics(
  opts: ChromeStartupDiagnosticsOptions,
): string {
  const logTail = redactSecrets(readLogTail(opts.logPath));
  return (
    `DevToolsActivePort ${devToolsPortStatus(opts)}; ` +
    `chrome.log tail:\n${logTail === "" ? "[empty]" : logTail}`
  );
}
