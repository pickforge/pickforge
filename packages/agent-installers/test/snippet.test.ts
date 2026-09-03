import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browserMcpServerEntry,
  mcpServerEntry,
  renderJsonSnippet,
  renderTomlSnippet,
  writeSharedSnippets,
} from "../src/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-snippet-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("mcpServerEntry", () => {
  it("uses pickforge-lab mcp serve as the canonical command", () => {
    expect(mcpServerEntry()).toEqual({
      command: "pickforge-lab",
      args: ["mcp", "serve"],
    });
  });
  it("uses a static project-local browser relay command", () => {
    expect(browserMcpServerEntry()).toEqual({
      command: "pickforge-lab",
      args: ["browser", "devtools-mcp"],
    });
  });
});

describe("renderJsonSnippet", () => {
  it("renders the exact JSON snippet", () => {
    expect(renderJsonSnippet()).toBe(
      `${JSON.stringify(
        {
          mcpServers: {
            "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
            "pickforge-lab-browser": {
              command: "pickforge-lab",
              args: ["browser", "devtools-mcp"],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  });

  it("renders custom entries", () => {
    const snippet = renderJsonSnippet({ command: "node", args: ["serve.js"] });
    expect(JSON.parse(snippet)).toEqual({
      mcpServers: { "pickforge-lab": { command: "node", args: ["serve.js"] } },
    });
  });
});

describe("renderTomlSnippet", () => {
  it("renders the exact TOML snippet", () => {
    expect(renderTomlSnippet()).toBe(
      '[mcp_servers."pickforge-lab"]\ncommand = "pickforge-lab"\nargs = ["mcp", "serve"]\n' +
        '[mcp_servers."pickforge-lab-browser"]\ncommand = "pickforge-lab"\n' +
        'args = ["browser", "devtools-mcp"]\n',
    );
  });
});

describe("writeSharedSnippets", () => {
  it("writes both snippet files into the agents dir", async () => {
    const env = { PICKFORGE_HOME: path.join(tmpDir, ".picklab") };
    const snippets = await writeSharedSnippets(env);
    expect(snippets.jsonPath).toBe(
      path.join(tmpDir, ".picklab", "agents", "pickforge-mcp.json"),
    );
    expect(snippets.tomlPath).toBe(
      path.join(tmpDir, ".picklab", "agents", "pickforge-mcp.toml"),
    );
    expect(fs.readFileSync(snippets.jsonPath, "utf8")).toBe(
      renderJsonSnippet(),
    );
    expect(fs.readFileSync(snippets.tomlPath, "utf8")).toBe(
      renderTomlSnippet(),
    );
  });
});
