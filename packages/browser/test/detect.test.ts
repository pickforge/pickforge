import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUPPORTED_CHROME_BINARIES,
  detectChromeBinary,
  requireChromeBinary,
} from "../src/detect.js";
import { writeExecutable } from "./fakes.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-detect-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("detectChromeBinary", () => {
  it("finds the first supported binary on PATH in preference order", () => {
    const binDir = path.join(tmp, "bin");
    writeExecutable(path.join(binDir, "chromium"), "#!/bin/sh\nexit 0\n");
    writeExecutable(
      path.join(binDir, "google-chrome-stable"),
      "#!/bin/sh\nexit 0\n",
    );
    const found = detectChromeBinary({ env: { PATH: binDir } });
    // google-chrome-stable outranks chromium.
    expect(found).toBe(path.join(binDir, "google-chrome-stable"));
  });

  it("returns null when no supported binary is on PATH", () => {
    expect(detectChromeBinary({ env: { PATH: path.join(tmp, "empty") } })).toBe(
      null,
    );
  });

  it("honors an executable PICKLAB_CHROME_BIN override by absolute path", () => {
    const custom = path.join(tmp, "custom-chrome");
    writeExecutable(custom, "#!/bin/sh\nexit 0\n");
    expect(
      detectChromeBinary({ env: { PATH: "", PICKLAB_CHROME_BIN: custom } }),
    ).toBe(custom);
  });

  it("rejects a non-executable override path", () => {
    const missing = path.join(tmp, "nope-chrome");
    expect(
      detectChromeBinary({ env: { PATH: "", PICKLAB_CHROME_BIN: missing } }),
    ).toBe(null);
  });

  it("prefers the explicit binaryPath option over PATH and env", () => {
    const custom = path.join(tmp, "opt-chrome");
    writeExecutable(custom, "#!/bin/sh\nexit 0\n");
    const binDir = path.join(tmp, "bin");
    writeExecutable(path.join(binDir, "chromium"), "#!/bin/sh\nexit 0\n");
    expect(
      detectChromeBinary({ env: { PATH: binDir }, binaryPath: custom }),
    ).toBe(custom);
  });
});

describe("requireChromeBinary", () => {
  it("throws an actionable error listing candidates when none found", () => {
    expect(() =>
      requireChromeBinary({ env: { PATH: path.join(tmp, "empty") } }),
    ).toThrow(/No Chrome or Chromium binary found/);
    for (const name of SUPPORTED_CHROME_BINARIES) {
      expect(() =>
        requireChromeBinary({ env: { PATH: path.join(tmp, "empty") } }),
      ).toThrow(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("throws a specific error when a configured override is unusable", () => {
    expect(() =>
      requireChromeBinary({
        env: { PATH: "", PICKLAB_CHROME_BIN: path.join(tmp, "ghost") },
      }),
    ).toThrow(/Configured Chrome binary is not usable/);
  });
});
