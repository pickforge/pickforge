import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatChromeStartupDiagnostics } from "../src/startup-diagnostics.js";

const MAX_LOG_TAIL_BYTES = 8 * 1024;

let tmp: string;
let endpointFile: string;
let logPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-chrome-diagnostics-"));
  endpointFile = path.join(tmp, "cdp-endpoint");
  logPath = path.join(tmp, "daemon-logs", "actual-chrome.log");
  fs.mkdirSync(path.dirname(logPath));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function diagnostics(
  reason: "exited" | "timeout" = "timeout",
  published = false,
): string {
  return formatChromeStartupDiagnostics({
    endpointFile,
    logPath,
    reason,
    published,
  });
}

describe("formatChromeStartupDiagnostics", () => {
  it("reports a missing endpoint file and an empty log for a timeout", () => {
    expect(diagnostics()).toBe(
      "cdp-endpoint file was not created before timeout; chrome.log tail:\n[empty]",
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

  it.each(["", "45123", "not-an-endpoint\n"])(
    "reports an invalid or partial endpoint file containing %j",
    (content) => {
      fs.writeFileSync(endpointFile, content);

      expect(diagnostics()).toContain(
        "file exists but does not hold a valid endpoint before timeout",
      );
    },
  );

  it("distinguishes timeout after probing a socket from process exit", () => {
    fs.writeFileSync(
      endpointFile,
      JSON.stringify({ socketPath: "/tmp/a/cdp.sock", browserPath: "/devtools/browser/capability-guid" }),
    );
    fs.writeFileSync(logPath, "endpoint still starting\n");

    const timedOut = diagnostics("timeout", true);
    const exited = diagnostics("exited", true);

    expect(timedOut).toContain(
      "published a CDP socket, but it did not answer before timeout",
    );
    expect(exited).toContain(
      "published a CDP socket, then the Chrome process exited",
    );
    expect(exited).not.toContain("did not answer");
    expect(exited).not.toContain("capability-guid");
  });
});
