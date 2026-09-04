import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatChromeStartupDiagnostics } from "../src/startup-diagnostics.js";

const MAX_LOG_TAIL_BYTES = 8 * 1024;

let tmp: string;
let profileDir: string;
let logPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-chrome-diagnostics-"));
  profileDir = path.join(tmp, "profile");
  logPath = path.join(tmp, "daemon-logs", "actual-chrome.log");
  fs.mkdirSync(profileDir);
  fs.mkdirSync(path.dirname(logPath));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function diagnostics(
  reason: "exited" | "timeout" = "timeout",
  port?: number,
): string {
  return formatChromeStartupDiagnostics({
    profileDir,
    logPath,
    reason,
    ...(port === undefined ? {} : { port }),
  });
}

describe("formatChromeStartupDiagnostics", () => {
  it("reports a missing port file and an empty log for a timeout", () => {
    expect(diagnostics()).toBe(
      "DevToolsActivePort file was not created before timeout; chrome.log tail:\n[empty]",
    );
  });

  it("reads the authoritative daemon log path", () => {
    fs.writeFileSync(path.join(tmp, "chrome.log"), "wrong inferred log\n");
    fs.writeFileSync(logPath, "authoritative daemon marker\n");

    expect(diagnostics()).toContain("authoritative daemon marker");
    expect(diagnostics()).not.toContain("wrong inferred log");
  });

  it("includes only a bounded, redacted log tail", () => {
    fs.writeFileSync(
      logPath,
      `discarded-prefix${"x".repeat(9000)}\n` +
        "startup failed GITHUB_TOKEN=secret-value\n",
    );

    const output = diagnostics();

    expect(output).not.toContain("discarded-prefix");
    expect(output).not.toContain("secret-value");
    expect(output).toContain("startup failed GITHUB_TOKEN=[REDACTED]");
    expect(Buffer.byteLength(output)).toBeLessThan(MAX_LOG_TAIL_BYTES + 200);
  });

  it("drops a secret fragment that crosses the tail boundary", () => {
    const secretLine = "GITHUB_TOKEN=ghp_CROSS_BOUNDARY_SECRET_1234567890\n";
    const leakedFragment = "CROSS_BOUNDARY_SECRET_1234567890";
    const cut = secretLine.indexOf(leakedFragment);
    const remainder = secretLine.slice(cut);
    const safeLine = "safe diagnostic after secret\n";
    const padding = "x".repeat(
      MAX_LOG_TAIL_BYTES - Buffer.byteLength(remainder + safeLine),
    );
    fs.writeFileSync(
      logPath,
      `discarded-prefix${secretLine.slice(0, cut)}${remainder}${safeLine}${padding}`,
    );

    const output = diagnostics();

    expect(output).not.toContain(leakedFragment);
    expect(output).toContain("safe diagnostic after secret");
  });

  it("does not emit NUL padding after a partial log read", () => {
    fs.writeFileSync(logPath, "partial-read-marker\n");
    const readSync = fs.readSync.bind(fs);
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      const [fd, buffer, offset, length, position] = args as unknown as [
        number,
        NodeJS.ArrayBufferView,
        number,
        number,
        fs.ReadPosition | null,
      ];
      return readSync(fd, buffer, offset, length - 4, position);
    });

    const output = diagnostics();

    expect(output).toContain("partial-read-mar");
    expect(output).not.toContain("\0");
  });

  it.each(["", "45123", "not-a-port\n"])(
    "reports an invalid or partial port file containing %j",
    (content) => {
      fs.writeFileSync(path.join(profileDir, "DevToolsActivePort"), content);

      expect(diagnostics()).toContain(
        "file exists but does not contain a valid port before timeout",
      );
    },
  );

  it("distinguishes timeout after probing a port from process exit", () => {
    fs.writeFileSync(
      path.join(profileDir, "DevToolsActivePort"),
      "45123\n/devtools/browser/capability-guid\n",
    );
    fs.writeFileSync(logPath, "endpoint still starting\n");

    const timedOut = diagnostics("timeout", 45123);
    const exited = diagnostics("exited", 45123);

    expect(timedOut).toContain(
      "published port 45123, but its HTTP endpoint did not become ready before timeout",
    );
    expect(exited).toContain(
      "published port 45123, then the Chrome process exited",
    );
    expect(exited).not.toContain("HTTP endpoint");
    expect(exited).not.toContain("did not become ready");
    expect(exited).not.toContain("capability-guid");
  });
});
