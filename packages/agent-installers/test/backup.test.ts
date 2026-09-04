import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupFile, isBackupPath } from "../src/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-backup-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const FROZEN = new Date(2026, 5, 9, 12, 34, 56);

describe("backupFile", () => {
  it("copies the file to a timestamped backup path", async () => {
    const file = path.join(tmpDir, "config.json");
    fs.writeFileSync(file, "original");
    const backup = await backupFile(file, FROZEN);
    expect(backup).toBe(`${file}.pickforge-backup-20260609-123456`);
    expect(fs.readFileSync(backup as string, "utf8")).toBe("original");
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });

  it("never overwrites an existing backup; suffixes -2, -3, ...", async () => {
    const file = path.join(tmpDir, "config.json");
    fs.writeFileSync(file, "v1");
    const first = await backupFile(file, FROZEN);
    fs.writeFileSync(file, "v2");
    const second = await backupFile(file, FROZEN);
    fs.writeFileSync(file, "v3");
    const third = await backupFile(file, FROZEN);
    expect(first).toBe(`${file}.pickforge-backup-20260609-123456`);
    expect(second).toBe(`${file}.pickforge-backup-20260609-123456-2`);
    expect(third).toBe(`${file}.pickforge-backup-20260609-123456-3`);
    expect(fs.readFileSync(first as string, "utf8")).toBe("v1");
    expect(fs.readFileSync(second as string, "utf8")).toBe("v2");
    expect(fs.readFileSync(third as string, "utf8")).toBe("v3");
  });

  it("returns undefined when the source file does not exist", async () => {
    const backup = await backupFile(path.join(tmpDir, "missing.json"));
    expect(backup).toBeUndefined();
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});

describe("isBackupPath", () => {
  it("matches generated backup paths", () => {
    expect(isBackupPath("/x/config.json.pickforge-backup-20260609-123456")).toBe(
      true,
    );
    expect(
      isBackupPath("/x/config.json.pickforge-backup-20260609-123456-2"),
    ).toBe(true);
    expect(isBackupPath("/x/config.json.picklab-backup-20260609-123456")).toBe(
      true,
    );
    expect(isBackupPath("/x/config.json")).toBe(false);
  });
});
