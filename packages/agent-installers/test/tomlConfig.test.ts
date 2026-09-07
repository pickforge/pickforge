import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectTomlFile,
  LEGACY_TOML_MARKER_BEGIN,
  LEGACY_TOML_MARKER_END,
  removeTomlMarkerBlock,
  TOML_MARKER_BEGIN,
  TOML_MARKER_END,
  tomlFileHasMcpServer,
  upsertTomlMarkerBlock,
} from "../src/index.js";

let tmpDir: string;
let file: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-toml-"));
  file = path.join(tmpDir, "config.toml");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CORE_SECTION =
  '[mcp_servers."pickforge-lab"]\ncommand = "pickforge-lab"\nargs = ["mcp", "serve"]\n';
const BROWSER_SECTION =
  '[mcp_servers."pickforge-lab-browser"]\ncommand = "pickforge-lab"\n' +
  'args = ["browser", "devtools-mcp"]\n';
const EXPECTED_BLOCK = `${TOML_MARKER_BEGIN}\n${CORE_SECTION}${TOML_MARKER_END}\n`;
const EXPECTED_BROWSER_BLOCK =
  `${TOML_MARKER_BEGIN}\n${CORE_SECTION}${BROWSER_SECTION}${TOML_MARKER_END}\n`;

function backupsIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((entry) => entry.includes("pickforge-backup"));
}

describe("upsertTomlMarkerBlock", () => {
  it("creates the file with the marker block when missing", async () => {
    const result = await upsertTomlMarkerBlock(file);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(EXPECTED_BLOCK);
  });

  it("appends after existing content with a blank-line separator", async () => {
    fs.writeFileSync(file, 'model = "gpt-5"\n');
    const result = await upsertTomlMarkerBlock(file);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(fs.readFileSync(file, "utf8")).toBe(
      `model = "gpt-5"\n\n${EXPECTED_BLOCK}`,
    );
  });

  it("is idempotent: second run changes nothing and writes no backup", async () => {
    fs.writeFileSync(file, 'model = "gpt-5"\n');
    await upsertTomlMarkerBlock(file);
    const before = fs.readFileSync(file, "utf8");
    const backupsBefore = backupsIn(tmpDir).length;
    const result = await upsertTomlMarkerBlock(file);
    expect(result.changed).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(backupsIn(tmpDir).length).toBe(backupsBefore);
  });

  it("replaces drifted content inside the markers", async () => {
    fs.writeFileSync(
      file,
      `before = 1\n\n${TOML_MARKER_BEGIN}\nstale = true\n${TOML_MARKER_END}\nafter = 2\n`,
    );
    const result = await upsertTomlMarkerBlock(file);
    expect(result.changed).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(
      `before = 1\n\n${EXPECTED_BLOCK}after = 2\n`,
    );
  });

  it("adds the browser section only when opted in and stays idempotent", async () => {
    const result = await upsertTomlMarkerBlock(file, undefined, { browser: true });
    expect(result.changed).toBe(true);
    expect(result.retainedEntries).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(EXPECTED_BROWSER_BLOCK);
    const again = await upsertTomlMarkerBlock(file, undefined, { browser: true });
    expect(again.changed).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(EXPECTED_BROWSER_BLOCK);
  });

  it("retains a mismatching browser section verbatim unless opted in", async () => {
    const stale =
      '[mcp_servers."pickforge-lab-browser"]\ncommand = "old-pickforge-lab"\n' +
      'args = ["browser", "old"]\n';
    fs.writeFileSync(
      file,
      `${TOML_MARKER_BEGIN}\n${stale}${CORE_SECTION}${TOML_MARKER_END}\n`,
    );
    const result = await upsertTomlMarkerBlock(file);
    expect(result.changed).toBe(true);
    expect(result.retainedEntries).toEqual(["pickforge-lab-browser"]);
    const expected = `${TOML_MARKER_BEGIN}\n${CORE_SECTION}${stale}${TOML_MARKER_END}\n`;
    expect(fs.readFileSync(file, "utf8")).toBe(expected);

    const again = await upsertTomlMarkerBlock(file);
    expect(again.changed).toBe(false);
    expect(again.retainedEntries).toEqual(["pickforge-lab-browser"]);
    expect(fs.readFileSync(file, "utf8")).toBe(expected);
    expect(await inspectTomlFile(file)).toMatchObject({
      markersHaveSection: true,
    });

    const repaired = await upsertTomlMarkerBlock(file, undefined, {
      browser: true,
    });
    expect(repaired.changed).toBe(true);
    expect(repaired.retainedEntries).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(EXPECTED_BROWSER_BLOCK);
  });

  it("retains browser subtables and header variants without dropping any line", async () => {
    const customized =
      "[ mcp_servers.'pickforge-lab-browser' ]  # keep me\n" +
      'command = "custom-browser"\n' +
      'args = ["browser", "custom"]\n' +
      '[mcp_servers."pickforge-lab-browser".env] # relay env\n' +
      'CHROME_PATH = "/opt/chrome"\n' +
      "[mcp_servers.pickforge-lab-browser.headers]\n" +
      'Authorization = "Bearer x"\n';
    fs.writeFileSync(
      file,
      `${TOML_MARKER_BEGIN}\nstale = true\n${customized}${TOML_MARKER_END}\n`,
    );
    const result = await upsertTomlMarkerBlock(file);
    expect(result.changed).toBe(true);
    expect(result.retainedEntries).toEqual(["pickforge-lab-browser"]);
    const expected = `${TOML_MARKER_BEGIN}\n${CORE_SECTION}${customized}${TOML_MARKER_END}\n`;
    expect(fs.readFileSync(file, "utf8")).toBe(expected);

    const again = await upsertTomlMarkerBlock(file);
    expect(again.changed).toBe(false);
    expect(again.retainedEntries).toEqual(["pickforge-lab-browser"]);
    expect(fs.readFileSync(file, "utf8")).toBe(expected);
  });

  it("retains a browser subtable that sits after the core section", async () => {
    const browserEnv =
      '[mcp_servers."pickforge-lab-browser".env]\nCHROME_PATH = "/opt/chrome"\n';
    fs.writeFileSync(
      file,
      `${TOML_MARKER_BEGIN}\n${BROWSER_SECTION}${CORE_SECTION}${browserEnv}${TOML_MARKER_END}\n`,
    );
    const result = await upsertTomlMarkerBlock(file);
    expect(result.retainedEntries).toEqual(["pickforge-lab-browser"]);
    expect(fs.readFileSync(file, "utf8")).toBe(
      `${TOML_MARKER_BEGIN}\n${CORE_SECTION}${BROWSER_SECTION}${browserEnv}${TOML_MARKER_END}\n`,
    );
  });

  it("keeps a customized current browser section when a legacy browser block migrates without --browser", async () => {
    const customized =
      '[mcp_servers."pickforge-lab-browser"]\ncommand = "custom-browser"\n' +
      'args = ["browser", "custom"]\n' +
      '[mcp_servers."pickforge-lab-browser".env]\nCHROME_PATH = "/opt/chrome"\n';
    fs.writeFileSync(
      file,
      `${LEGACY_TOML_MARKER_BEGIN}\n` +
        '[mcp_servers.picklab]\ncommand = "picklab"\nargs = ["mcp", "serve"]\n' +
        '[mcp_servers.picklab-browser]\ncommand = "picklab"\n' +
        'args = ["browser", "devtools-mcp"]\n' +
        `${LEGACY_TOML_MARKER_END}\n\n` +
        `${TOML_MARKER_BEGIN}\n${customized}${TOML_MARKER_END}\n`,
    );
    const result = await upsertTomlMarkerBlock(file);
    expect(result.changed).toBe(true);
    expect(result.migratedLegacyEntries).toEqual(["picklab", "picklab-browser"]);
    expect(result.retainedEntries).toEqual(["pickforge-lab-browser"]);
    expect(fs.readFileSync(file, "utf8")).toBe(
      `\n${TOML_MARKER_BEGIN}\n${CORE_SECTION}${customized}${TOML_MARKER_END}\n`,
    );

    const repaired = await upsertTomlMarkerBlock(file, undefined, {
      browser: true,
    });
    expect(repaired.retainedEntries).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(`\n${EXPECTED_BROWSER_BLOCK}`);
  });

  it("replaces an owned legacy block in the same atomic update", async () => {
    fs.writeFileSync(
      file,
      `model = "gpt-5"\n\n${LEGACY_TOML_MARKER_BEGIN}\n` +
        '[mcp_servers.picklab]\ncommand = "picklab"\nargs = ["mcp", "serve"]\n' +
        '[mcp_servers.picklab-browser]\ncommand = "picklab"\n' +
        'args = ["browser", "devtools-mcp"]\n' +
        `${LEGACY_TOML_MARKER_END}\n`,
    );
    const result = await upsertTomlMarkerBlock(file);
    expect(result.migratedLegacyEntries).toEqual([
      "picklab",
      "picklab-browser",
    ]);
    expect(result.backupPath).toBeDefined();
    expect(fs.readFileSync(file, "utf8")).toBe(
      `model = "gpt-5"\n\n${EXPECTED_BROWSER_BLOCK}`,
    );
  });

  it("refuses a foreign [mcp_servers.picklab] section and leaves the file untouched", async () => {
    const content = '[mcp_servers.picklab]\ncommand = "something-else"\n';
    fs.writeFileSync(file, content);
    await expect(upsertTomlMarkerBlock(file)).rejects.toThrow(
      "outside the managed markers",
    );
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(backupsIn(tmpDir)).toEqual([]);
  });

  it("refuses unbalanced markers", async () => {
    fs.writeFileSync(file, `${TOML_MARKER_BEGIN}\n`);
    await expect(upsertTomlMarkerBlock(file)).rejects.toThrow(
      "unbalanced pickforge-lab markers",
    );
  });
});

describe("removeTomlMarkerBlock", () => {
  it("removes the marker block and backs up first", async () => {
    fs.writeFileSync(file, 'model = "gpt-5"\n');
    await upsertTomlMarkerBlock(file);
    const result = await removeTomlMarkerBlock(file);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(fs.readFileSync(file, "utf8")).toBe('model = "gpt-5"\n\n');
  });

  it("is a no-op without markers or without the file", async () => {
    expect((await removeTomlMarkerBlock(file)).changed).toBe(false);
    fs.writeFileSync(file, 'model = "gpt-5"\n');
    expect((await removeTomlMarkerBlock(file)).changed).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe('model = "gpt-5"\n');
  });
});

describe("inspectTomlFile / tomlFileHasMcpServer", () => {
  it("reports a healthy managed block", async () => {
    await upsertTomlMarkerBlock(file);
    expect(await inspectTomlFile(file)).toEqual({
      exists: true,
      markersPresent: true,
      markersHaveSection: true,
      legacyMarkersPresent: false,
      foreignSection: false,
    });
    expect(await tomlFileHasMcpServer(file)).toBe(true);
    expect(
      await tomlFileHasMcpServer(file, {
        command: "pickforge-lab",
        args: ["mcp", "serve"],
      }),
    ).toBe(true);
  });

  it("reports markers without content as stale", async () => {
    fs.writeFileSync(file, `${TOML_MARKER_BEGIN}\n${TOML_MARKER_END}\n`);
    const inspection = await inspectTomlFile(file);
    expect(inspection.markersPresent).toBe(true);
    expect(inspection.markersHaveSection).toBe(false);
  });

  it("reports drifted managed blocks as not matching the expected command", async () => {
    fs.writeFileSync(
      file,
      `${TOML_MARKER_BEGIN}\n` +
        '[mcp_servers."pickforge-lab"]\ncommand = "old-pickforge-lab"\nargs = ["mcp", "serve"]\n' +
        `${TOML_MARKER_END}\n`,
    );
    expect(await tomlFileHasMcpServer(file)).toBe(false);
    expect(
      await tomlFileHasMcpServer(file, {
        command: "pickforge-lab",
        args: ["mcp", "serve"],
      }),
    ).toBe(false);
  });

  it("reports foreign sections", async () => {
    fs.writeFileSync(file, '[mcp_servers.picklab]\ncommand = "x"\n');
    const inspection = await inspectTomlFile(file);
    expect(inspection.foreignSection).toBe(true);
    expect(await tomlFileHasMcpServer(file)).toBe(true);
  });

  it("detects foreign sections with CRLF line endings", async () => {
    fs.writeFileSync(file, '[mcp_servers.picklab]\r\ncommand = "x"\r\n');
    const inspection = await inspectTomlFile(file);
    expect(inspection.foreignSection).toBe(true);
    await expect(upsertTomlMarkerBlock(file)).rejects.toThrow(
      "outside the managed markers",
    );
  });

  it("detects [mcp_servers.picklab.<sub>] subtables as foreign sections", async () => {
    fs.writeFileSync(file, '[mcp_servers.picklab.env]\nFOO = "bar"\n');
    const inspection = await inspectTomlFile(file);
    expect(inspection.foreignSection).toBe(true);
    await expect(upsertTomlMarkerBlock(file)).rejects.toThrow(
      "outside the managed markers",
    );
  });

  it("does not treat other mcp_servers sections as pickforge-lab sections", async () => {
    fs.writeFileSync(file, '[mcp_servers.picklabber]\ncommand = "x"\n');
    const inspection = await inspectTomlFile(file);
    expect(inspection.foreignSection).toBe(false);
  });

  it("reports a missing file", async () => {
    expect(await inspectTomlFile(file)).toEqual({
      exists: false,
      markersPresent: false,
      markersHaveSection: false,
      legacyMarkersPresent: false,
      foreignSection: false,
    });
  });
});

describe("marker scanning", () => {
  it("ignores marker text embedded in string values", async () => {
    const content =
      `note = "${TOML_MARKER_BEGIN} not a marker ${TOML_MARKER_END}"\n`;
    fs.writeFileSync(file, content);
    expect((await removeTomlMarkerBlock(file)).changed).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(content);

    const result = await upsertTomlMarkerBlock(file);
    expect(result.changed).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(
      `${content}\n${EXPECTED_BLOCK}`,
    );
  });
});

describe("atomic writes", () => {
  it("leaves no temp files behind after upsert and remove", async () => {
    const tmpLeftovers = (): string[] =>
      fs.readdirSync(tmpDir).filter((entry) => entry.includes(".tmp-"));
    await upsertTomlMarkerBlock(file);
    expect(tmpLeftovers()).toEqual([]);
    await removeTomlMarkerBlock(file);
    expect(tmpLeftovers()).toEqual([]);
  });
});
