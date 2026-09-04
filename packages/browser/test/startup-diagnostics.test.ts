import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatChromeStartupDiagnostics } from "../src/startup-diagnostics.js";

let tmp: string;
let profileDir: string;
let logPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-chrome-diagnostics-"));
  profileDir = path.join(tmp, "profile");
  logPath = path.join(tmp, "chrome.log");
  fs.mkdirSync(profileDir);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("formatChromeStartupDiagnostics", () => {
  it("reports a missing port file and an empty log", () => {
    expect(formatChromeStartupDiagnostics(profileDir)).toBe(
      "DevToolsActivePort file was not created; chrome.log tail:\n[empty]",
    );
  });

  it("includes only a bounded, redacted log tail", () => {
    fs.writeFileSync(
      logPath,
      `discarded-prefix${"x".repeat(9000)}startup failed GITHUB_TOKEN=secret-value`,
    );

    const diagnostics = formatChromeStartupDiagnostics(profileDir);

    expect(diagnostics).not.toContain("discarded-prefix");
    expect(diagnostics).not.toContain("secret-value");
    expect(diagnostics).toContain("startup failed GITHUB_TOKEN=[REDACTED]");
  });

  it("distinguishes a published port from a missing port file", () => {
    fs.writeFileSync(
      path.join(profileDir, "DevToolsActivePort"),
      "45123\n/devtools/browser/capability-guid\n",
    );
    fs.writeFileSync(logPath, "endpoint still starting\n");

    const diagnostics = formatChromeStartupDiagnostics(profileDir, 45123);

    expect(diagnostics).toContain(
      "published port 45123, but its HTTP endpoint did not become ready",
    );
    expect(diagnostics).toContain("endpoint still starting");
    expect(diagnostics).not.toContain("capability-guid");
  });
});
