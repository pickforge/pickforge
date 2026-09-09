import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browserMcpServerEntry,
  mcpServerEntry,
  pickforgeLabMcpServerEntries,
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

describe("pickforgeLabMcpServerEntries", () => {
  it("includes the browser relay only when opted in", () => {
    expect(Object.keys(pickforgeLabMcpServerEntries())).toEqual(["pickforge-lab"]);
    expect(Object.keys(pickforgeLabMcpServerEntries({ browser: true }))).toEqual([
      "pickforge-lab",
      "pickforge-lab-browser",
    ]);
  });
});

describe("renderJsonSnippet", () => {
  it("renders the exact JSON snippet without the browser relay by default", () => {
    expect(renderJsonSnippet()).toBe(
      `${JSON.stringify(
        {
          mcpServers: {
            "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
          },
        },
        null,
        2,
      )}\n`,
    );
  });

  it("renders the browser relay when opted in", () => {
    expect(JSON.parse(renderJsonSnippet(undefined, { browser: true }))).toEqual({
      mcpServers: {
        "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
        "pickforge-lab-browser": {
          command: "pickforge-lab",
          args: ["browser", "devtools-mcp"],
        },
      },
    });
  });

  it("renders custom entries", () => {
    const snippet = renderJsonSnippet({ command: "node", args: ["serve.js"] });
    expect(JSON.parse(snippet)).toEqual({
      mcpServers: { "pickforge-lab": { command: "node", args: ["serve.js"] } },
    });
  });
});

describe("renderTomlSnippet", () => {
  it("renders the exact TOML snippet without the browser relay by default", () => {
    expect(renderTomlSnippet()).toBe(
      '[mcp_servers."pickforge-lab"]\ncommand = "pickforge-lab"\nargs = ["mcp", "serve"]\n',
    );
  });

  it("renders the browser relay when opted in", () => {
    expect(renderTomlSnippet(undefined, { browser: true })).toBe(
      '[mcp_servers."pickforge-lab"]\ncommand = "pickforge-lab"\nargs = ["mcp", "serve"]\n' +
        '[mcp_servers."pickforge-lab-browser"]\ncommand = "pickforge-lab"\n' +
        'args = ["browser", "devtools-mcp"]\n',
    );
  });
});

describe("writeSharedSnippets", () => {
  it("writes shared snippets and the acceptance workflow into the agents dir", async () => {
    const env = { PICKFORGE_HOME: path.join(tmpDir, "state") };
    const snippets = await writeSharedSnippets(env);
    expect(snippets.devicePassPath).toBe(
      path.join(tmpDir, "state", "agents", "device-pass.md"),
    );
    expect(fs.statSync(snippets.devicePassPath).mode & 0o777).toBe(0o600);
    const workflow = fs.readFileSync(snippets.devicePassPath, "utf8");
    expect(workflow).toContain("Pass is refused without a successful interaction and an inspected screenshot.");
    expect(workflow).toMatchSnapshot();
    expect(snippets.jsonPath).toBe(
      path.join(tmpDir, "state", "agents", "pickforge-mcp.json"),
    );
    expect(snippets.tomlPath).toBe(
      path.join(tmpDir, "state", "agents", "pickforge-mcp.toml"),
    );
    expect(fs.readFileSync(snippets.jsonPath, "utf8")).toBe(
      renderJsonSnippet(),
    );
    expect(fs.readFileSync(snippets.tomlPath, "utf8")).toBe(
      renderTomlSnippet(),
    );
  });
});
