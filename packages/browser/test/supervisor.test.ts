import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "@pickforge/lab-core";
import { describe, expect, it } from "vitest";
import { buildSupervisedBrowserCommand } from "../src/supervisor.js";

describe("buildSupervisedBrowserCommand", () => {
  it("runs the browser behind a stable Node process-group leader", () => {
    const command = buildSupervisedBrowserCommand(
      "/usr/bin/node",
      "/usr/bin/chromium",
      ["--remote-debugging-port=0", "about:blank"],
    );

    expect(command.command).toBe("/usr/bin/node");
    expect(command.args).toEqual([
      "--input-type=module",
      "-e",
      expect.stringContaining('import * as fs from "node:fs";'),
      "/usr/bin/chromium",
      "--remote-debugging-port=0",
      "about:blank",
    ]);
    expect(command.args[2]).toContain(
      'import { spawn } from "node:child_process";',
    );
  });

  it("redacts split capability URLs while preserving stderr diagnostics and stdout", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-supervisor-"));
    const browser = path.join(tmp, "browser.cjs");
    fs.writeFileSync(
      browser,
      [
        'process.stdout.write("browser stdout\\n");',
        'process.stderr.write("ordinary diagnostic\\nDevTools listening on ws://127.0.0.1:45123/devtools/browser/");',
        "setImmediate(() => {",
        '  process.stderr.write("secret-guid\\ntrailing diagnostic");',
        "});",
      ].join("\n"),
    );
    try {
      const command = buildSupervisedBrowserCommand(
        process.execPath,
        process.execPath,
        [browser],
      );
      const result = await runCommand(command.command, command.args);

      expect(result.ok).toBe(true);
      expect(result.stdout).toBe("browser stdout\n");
      expect(result.stderr).toContain("ordinary diagnostic");
      expect(result.stderr).toContain("[redacted DevTools capability URL]");
      expect(result.stderr).toContain("trailing diagnostic");
      expect(result.stderr).not.toContain("secret-guid");
      expect(result.stderr).not.toContain("/devtools/browser/");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bounds unbounded newline-free stderr instead of buffering it all", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-supervisor-"));
    const browser = path.join(tmp, "browser.cjs");
    fs.writeFileSync(
      browser,
      [
        'const fs = require("fs");',
        'fs.writeSync(2, "HEAD_MARKER_ABC");',
        'fs.writeSync(2, "a".repeat(5 * 1024 * 1024));',
        'fs.writeSync(2, "TAIL_MARKER_XYZ");',
        "process.exit(0);",
      ].join("\n"),
    );
    try {
      const command = buildSupervisedBrowserCommand(
        process.execPath,
        process.execPath,
        [browser],
      );
      const result = await runCommand(command.command, command.args);

      expect(result.ok).toBe(true);
      expect(result.stderr).toContain("TAIL_MARKER_XYZ");
      expect(result.stderr).not.toContain("HEAD_MARKER_ABC");
      expect(result.stderr.length).toBeLessThan(200 * 1024);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects missing executable paths", () => {
    expect(() =>
      buildSupervisedBrowserCommand("", "/usr/bin/chromium", []),
    ).toThrow(/Node.js executable/);
    expect(() =>
      buildSupervisedBrowserCommand("/usr/bin/node", "", []),
    ).toThrow(/browser binary/);
  });
});
