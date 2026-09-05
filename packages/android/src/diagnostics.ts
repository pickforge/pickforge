import fs from "node:fs";
import { redactSecrets } from "@pickforge/lab-core";
import type { AdbDevice } from "./adb.js";

/**
 * Why an emulator start failed. Each kind names one distinct cause so a caller
 * can act on it without reading the emulator log:
 *
 * - `avd-missing`: the AVD is not in the directory the emulator searches.
 * - `avd-in-use`: another emulator process holds the AVD's writable state.
 * - `port-collision`: the console/adb port pair is bound by another process.
 * - `snapshot`: the saved state could not be loaded and the emulator gave up.
 * - `kvm`: hardware acceleration is unavailable.
 * - `process-exit`: the emulator exited for a reason the log does not name.
 * - `boot-timeout`: the process is alive but `sys.boot_completed` never came;
 *   `deviceState` says what adb saw (`missing`, `offline`, `unauthorized`, …).
 * - `aborted`: the caller cancelled the start.
 */
export type EmulatorFailureKind =
  | "avd-missing"
  | "avd-in-use"
  | "port-collision"
  | "snapshot"
  | "kvm"
  | "process-exit"
  | "boot-timeout"
  | "aborted";

export type EmulatorBootMode = "warm" | "cold" | "unknown";

export interface EmulatorStartDiagnostics {
  kind: EmulatorFailureKind;
  avdName: string;
  /** Unset when the failure happened before a console port was chosen. */
  serial?: string;
  consolePort?: number;
  logPath?: string;
  /** Last lines of the emulator log, secrets redacted. Survives log deletion. */
  logTail: string[];
  /** adb device state at failure time, or `missing` when adb never listed it. */
  deviceState?: string;
  hint?: string;
}

export const LOG_TAIL_LINES = 25;
const LOG_TAIL_MAX_BYTES = 64 * 1024;

/**
 * Pickforge's own rule for sharing one AVD, stated in every message that
 * enforces it. The emulator refuses a second *writable* instance of an AVD and
 * lets `-read-only` instances share it; whether it also admits a read-only
 * instance next to a running writable one is not something Pickforge relies
 * on. A writable instance keeps mutating the qcow2 overlays and the quickboot
 * snapshot that a read-only reader maps, so Pickforge fails closed and admits
 * sharing only when every instance on the AVD is read-only.
 */
export const AVD_SHARING_POLICY =
  "Pickforge shares an AVD only among read-only sessions and refuses to " +
  "start any session while a writable emulator holds it (a writable " +
  "instance rewrites the disk overlays and snapshot a read-only one maps)";

/** adb device state reported when the `adb devices` probe itself could not run. */
export const DEVICE_STATE_UNKNOWN = "unknown (adb devices failed)";

interface LogSignature {
  kind: EmulatorFailureKind;
  pattern: RegExp;
  hint: string;
}

const LOG_SIGNATURES: readonly LogSignature[] = [
  {
    kind: "avd-missing",
    pattern: /Unknown AVD name/i,
    hint:
      "the emulator looks for AVDs in $ANDROID_AVD_HOME, else " +
      "$ANDROID_USER_HOME/avd, $ANDROID_EMULATOR_HOME/avd, " +
      "$ANDROID_PREFS_ROOT/.android/avd, $ANDROID_SDK_HOME/.android/avd, " +
      "then $HOME/.android/avd; set ANDROID_AVD_HOME to the directory that " +
      "holds the AVD",
  },
  {
    kind: "avd-in-use",
    pattern:
      /multiple emulators with the same AVD|Another emulator instance is running/i,
    hint:
      "another emulator is running this AVD; " +
      AVD_SHARING_POLICY +
      ", so stop that instance, start every session on this AVD with " +
      "--read-only, or use a different AVD",
  },
  {
    kind: "port-collision",
    pattern:
      /(console|adb) port[^\n]*(in use|busy|bind)|address already in use|could not bind/i,
    hint: "another process holds the console or adb port; retry to allocate a new pair",
  },
  {
    kind: "snapshot",
    pattern:
      /snapshot[^\n]*(corrupt|invalid|could not be loaded|failed)|failed to load snapshot/i,
    hint: "start with a cold boot (--cold-boot) to skip the saved state",
  },
  {
    kind: "kvm",
    pattern:
      /\/dev\/kvm[^\n]*(denied|not found|failed|cannot)|requires hardware acceleration|KVM is required/i,
    hint: "check that /dev/kvm exists and is readable and writable by this user",
  },
];

const DEVICE_STATE_HINTS: Record<string, string> = {
  missing:
    "adb never listed the device; the console port may be held by another " +
    "process, or the guest is still starting",
  offline: "adb listed the device but it stayed offline; the guest did not finish starting adbd",
  unauthorized:
    "the guest does not trust the adb server's key; use the same " +
    "~/.android/adbkey (or ADB_VENDOR_KEYS) the AVD was first booted with",
  device: "adb saw the device but sys.boot_completed never became 1",
  [DEVICE_STATE_UNKNOWN]:
    "adb itself could not be run to probe the device; check that the adb " +
    "binary under <sdk>/platform-tools is present and executable",
};

export function readLogTail(
  logPath: string | undefined,
  maxLines: number = LOG_TAIL_LINES,
): string[] {
  if (logPath === undefined) {
    return [];
  }
  let content: string;
  try {
    const size = fs.statSync(logPath).size;
    const fd = fs.openSync(logPath, "r");
    try {
      const length = Math.min(size, LOG_TAIL_MAX_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      content = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const lines = content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  return lines.slice(-maxLines).map((line) => redactSecrets(line));
}

export function classifyEmulatorLog(
  lines: readonly string[],
): { kind: EmulatorFailureKind; hint?: string } {
  const text = lines.join("\n");
  for (const signature of LOG_SIGNATURES) {
    if (signature.pattern.test(text)) {
      return { kind: signature.kind, hint: signature.hint };
    }
  }
  return { kind: "process-exit" };
}

export function detectBootMode(
  lines: readonly string[],
  forcedCold: boolean = false,
): EmulatorBootMode {
  if (forcedCold) {
    return "cold";
  }
  const text = lines.join("\n");
  if (/cold boot/i.test(text)) {
    return "cold";
  }
  if (/Loading snapshot '/.test(text)) {
    return "warm";
  }
  return "unknown";
}

export function describeDeviceState(
  devices: readonly AdbDevice[],
  serial: string,
): string {
  return devices.find((device) => device.serial === serial)?.state ?? "missing";
}

export function deviceStateHint(state: string): string | undefined {
  return DEVICE_STATE_HINTS[state];
}

function formatDiagnostics(
  summary: string,
  diagnostics: EmulatorStartDiagnostics,
): string {
  const parts = [`${summary} [${diagnostics.kind}]`];
  if (diagnostics.deviceState !== undefined) {
    parts.push(`adb state: ${diagnostics.deviceState}`);
  }
  if (diagnostics.hint !== undefined) {
    parts.push(diagnostics.hint);
  }
  if (diagnostics.logPath !== undefined) {
    parts.push(`check the log at ${diagnostics.logPath}`);
  }
  let message = parts.join("; ");
  if (diagnostics.logTail.length > 0) {
    message +=
      `\n--- emulator log tail (last ${diagnostics.logTail.length} lines) ---\n` +
      diagnostics.logTail.join("\n");
  }
  return message;
}

export class EmulatorStartError extends Error {
  readonly diagnostics: EmulatorStartDiagnostics;

  constructor(summary: string, diagnostics: EmulatorStartDiagnostics) {
    super(formatDiagnostics(summary, diagnostics));
    this.name = "EmulatorStartError";
    this.diagnostics = diagnostics;
  }

  get kind(): EmulatorFailureKind {
    return this.diagnostics.kind;
  }
}

export function isEmulatorStartError(
  error: unknown,
): error is EmulatorStartError {
  return error instanceof EmulatorStartError;
}

/**
 * Persistable copy of a start failure for a session record, so the exact
 * cause and the emulator's last lines survive after the process, the log, or
 * a test's temporary directory is gone.
 */
export function startFailureRecord(
  error: unknown,
): Record<string, unknown> | undefined {
  if (!isEmulatorStartError(error)) {
    return undefined;
  }
  const { diagnostics } = error;
  const record: Record<string, unknown> = {
    kind: diagnostics.kind,
    avdName: diagnostics.avdName,
    logTail: diagnostics.logTail,
  };
  if (diagnostics.serial !== undefined) record.serial = diagnostics.serial;
  if (diagnostics.consolePort !== undefined) {
    record.consolePort = diagnostics.consolePort;
  }
  if (diagnostics.logPath !== undefined) record.logPath = diagnostics.logPath;
  if (diagnostics.deviceState !== undefined) {
    record.deviceState = diagnostics.deviceState;
  }
  if (diagnostics.hint !== undefined) record.hint = diagnostics.hint;
  return record;
}
