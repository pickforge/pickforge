import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  jsonFileHasMcpServer,
  jsonFileMcpServerState,
  mergeMcpServerIntoJsonFile,
  pickforgeLabMcpServerEntries,
  removeMcpServerFromJsonFile,
} from "../src/index.js";

let tmpDir: string;
let file: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-json-"));
  file = path.join(tmpDir, "mcp.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, any>;
}

function backupsIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((entry) => entry.includes("pickforge-backup"));
}

function tmpLeftoversIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((entry) => entry.includes(".tmp-"));
}

describe("mergeMcpServerIntoJsonFile", () => {
  it("creates the file when allowed and missing", async () => {
    const nested = path.join(tmpDir, "deep", "mcp.json");
    const result = await mergeMcpServerIntoJsonFile(nested, {
      createIfMissing: true,
    });
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect(readJson(nested)).toEqual({
      mcpServers: pickforgeLabMcpServerEntries(),
    });
  });

  it("fails when the file is missing and creation is not allowed", async () => {
    await expect(
      mergeMcpServerIntoJsonFile(file, { createIfMissing: false }),
    ).rejects.toThrow("Config file not found");
  });

  it("preserves existing servers and other keys, backing up first", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        theme: "dark",
        mcpServers: { other: { command: "other-mcp", args: [] } },
      }),
    );
    const result = await mergeMcpServerIntoJsonFile(file, {
      createIfMissing: false,
    });
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(fs.existsSync(result.backupPath as string)).toBe(true);
    expect(readJson(file)).toEqual({
      theme: "dark",
      mcpServers: {
        other: { command: "other-mcp", args: [] },
        "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
        "pickforge-lab-browser": {
          command: "pickforge-lab",
          args: ["browser", "devtools-mcp"],
        },
      },
    });
  });

  it("atomically replaces owned legacy entries and preserves foreign ones", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        theme: "dark",
        mcpServers: {
          picklab: { command: "picklab", args: ["mcp", "serve"] },
          "picklab-browser": { command: "foreign", args: [] },
        },
      }),
    );
    const result = await mergeMcpServerIntoJsonFile(file, {
      createIfMissing: false,
    });
    expect(result.migratedLegacyEntries).toEqual(["picklab"]);
    expect(result.backupPath).toBeDefined();
    expect(readJson(file)).toEqual({
      theme: "dark",
      mcpServers: {
        "picklab-browser": { command: "foreign", args: [] },
        "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
        "pickforge-lab-browser": {
          command: "pickforge-lab",
          args: ["browser", "devtools-mcp"],
        },
      },
    });
  });

  it("is idempotent: no rewrite and no backup when already registered", async () => {
    await mergeMcpServerIntoJsonFile(file, { createIfMissing: true });
    const before = fs.readFileSync(file, "utf8");
    const result = await mergeMcpServerIntoJsonFile(file, {
      createIfMissing: false,
    });
    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(backupsIn(tmpDir)).toEqual([]);
  });

  it("rejects unparseable JSON without touching the file", async () => {
    fs.writeFileSync(file, "{ not json");
    await expect(
      mergeMcpServerIntoJsonFile(file, { createIfMissing: true }),
    ).rejects.toThrow("invalid JSON");
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
    expect(backupsIn(tmpDir)).toEqual([]);
  });

  it("rejects non-object top-level JSON", async () => {
    fs.writeFileSync(file, "[1, 2]");
    await expect(
      mergeMcpServerIntoJsonFile(file, { createIfMissing: true }),
    ).rejects.toThrow("top-level JSON object");
  });
});

describe("removeMcpServerFromJsonFile", () => {
  it("removes both Pickforge entries and backs up first", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          other: { command: "other-mcp", args: [] },
          "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
          "pickforge-lab-browser": {
            command: "pickforge-lab",
            args: ["browser", "devtools-mcp"],
          },
        },
      }),
    );
    const result = await removeMcpServerFromJsonFile(file);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(readJson(file)).toEqual({
      mcpServers: { other: { command: "other-mcp", args: [] } },
    });
  });

  it("is a no-op when the entry or file is missing", async () => {
    expect((await removeMcpServerFromJsonFile(file)).changed).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    expect((await removeMcpServerFromJsonFile(file)).changed).toBe(false);
    expect(backupsIn(tmpDir)).toEqual([]);
  });

  it("drops the mcpServers key when the last entry is removed", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        theme: "dark",
        mcpServers: {
          "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
          "pickforge-lab-browser": {
            command: "pickforge-lab",
            args: ["browser", "devtools-mcp"],
          },
        },
      }),
    );
    const result = await removeMcpServerFromJsonFile(file);
    expect(result.changed).toBe(true);
    expect(readJson(file)).toEqual({ theme: "dark" });
  });
});

describe("atomic writes", () => {
  it("leaves no temp files behind after merge and remove", async () => {
    await mergeMcpServerIntoJsonFile(file, { createIfMissing: true });
    expect(tmpLeftoversIn(tmpDir)).toEqual([]);
    await removeMcpServerFromJsonFile(file);
    expect(tmpLeftoversIn(tmpDir)).toEqual([]);
  });

  it("preserves the original file mode across merge and remove", async () => {
    fs.writeFileSync(file, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
    fs.chmodSync(file, 0o600);

    await mergeMcpServerIntoJsonFile(file, { createIfMissing: false });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    await removeMcpServerFromJsonFile(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("jsonFileHasMcpServer / jsonFileMcpServerState", () => {
  it("detects the pickforge-lab entry", async () => {
    expect(await jsonFileHasMcpServer(file)).toBe(false);
    expect(await jsonFileMcpServerState(file)).toBe(false);
    await mergeMcpServerIntoJsonFile(file, { createIfMissing: true });
    expect(await jsonFileHasMcpServer(file)).toBe(true);
    expect(await jsonFileMcpServerState(file)).toBe(true);
  });

  it("can require the pickforge-lab entry to match the expected command", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          "pickforge-lab": { command: "old-pickforge-lab", args: ["mcp", "serve"] },
          "pickforge-lab-browser": {
            command: "pickforge-lab",
            args: ["browser", "devtools-mcp"],
          },
        },
      }),
    );
    const expected = { command: "pickforge-lab", args: ["mcp", "serve"] };
    expect(await jsonFileMcpServerState(file)).toBe(false);
    expect(await jsonFileMcpServerState(file, { expected })).toBe(false);
    expect(await jsonFileHasMcpServer(file, { expected })).toBe(false);
  });

  it("reports unparseable files as unknown instead of unregistered", async () => {
    fs.writeFileSync(file, "nope");
    expect(await jsonFileHasMcpServer(file)).toBe(false);
    expect(await jsonFileMcpServerState(file)).toBe("unknown");
  });

  it("reports JSONC-style configs as unknown", async () => {
    fs.writeFileSync(
      file,
      '{\n  // cursor accepts comments here\n  "mcpServers": {},\n}\n',
    );
    expect(await jsonFileMcpServerState(file)).toBe("unknown");
  });
});
