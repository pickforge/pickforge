import fs from "node:fs";
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
  /** The supervisor's `cdp-endpoint` file. */
  endpointFile: string;
  /** Authoritative daemon log path. Omit only when the caller has no daemon. */
  logPath?: string;
  reason: ChromeStartupFailureReason;
  /** The endpoint file was valid, so only its socket failed to answer. */
  published?: boolean;
  /** Why the last read refused the endpoint file, such as unsafe permissions. */
  endpointError?: string;
}

function endpointStatus(opts: ChromeStartupDiagnosticsOptions): string {
  if (opts.published === true) {
    return opts.reason === "exited"
      ? "published a CDP socket, then the Chrome process exited"
      : "published a CDP socket, but it did not answer before timeout";
  }
  const fileStatus = fs.existsSync(opts.endpointFile)
    ? "file exists but does not hold a valid endpoint"
    : "file was not created";
  const status = opts.reason === "exited"
    ? `${fileStatus} before the Chrome process exited`
    : `${fileStatus} before timeout`;
  return opts.endpointError === undefined
    ? status
    : `${status}: ${opts.endpointError}`;
}

/** Build bounded, redacted diagnostics that survive ephemeral cleanup. */
export function formatChromeStartupDiagnostics(
  opts: ChromeStartupDiagnosticsOptions,
): string {
  const logTail = redactSecrets(readLogTail(opts.logPath));
  return (
    `cdp-endpoint ${endpointStatus(opts)}; ` +
    `chrome.log tail:\n${logTail === "" ? "[empty]" : logTail}`
  );
}
