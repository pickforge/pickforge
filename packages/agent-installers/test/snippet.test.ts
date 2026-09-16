import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEVICE_PASS_WORKFLOW } from "@pickforge/lab-core";
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
    const workflow = fs.readFileSync(snippets.devicePassPath, "utf8");
    expect(workflow).toBe(DEVICE_PASS_WORKFLOW);
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

async function writtenWorkflow(dir: string): Promise<string> {
  const snippets = await writeSharedSnippets({
    PICKFORGE_HOME: path.join(dir, "state"),
  });
  return fs.readFileSync(snippets.devicePassPath, "utf8");
}

function guidanceLine(workflow: string, needle: string): string {
  const line = workflow
    .split("\n")
    .find((entry) => entry.toLowerCase().includes(needle.toLowerCase()));
  expect(line, `no device-pass line mentions ${needle}`).toBeDefined();
  return line as string;
}

describe("native desktop guidance in device-pass.md", () => {
  it("orders the loop from capture through inspection to recapture", async () => {
    const line = guidanceLine(await writtenWorkflow(tmpDir), "recapture and inspect");
    expect(line).toMatch(
      /desktop_screenshot.*inspect the image.*act.*bounded desktop_wait.*recapture/,
    );
  });

  it("requires a recapture after launches and focus changes with fresh coordinates", async () => {
    const line = guidanceLine(await writtenWorkflow(tmpDir), "Recapture after every");
    expect(line).toContain("desktop_launch");
    expect(line).toContain("desktop_exec");
    expect(line).toContain("focus change");
    expect(line).toMatch(/image pixels and reported scale/);
    expect(line).toMatch(/never from a stale or resized preview/);
  });

  it("inventories windows and focuses deliberately before typing", async () => {
    const line = guidanceLine(await writtenWorkflow(tmpDir), "Before typing");
    expect(line.indexOf("desktop_windows")).toBeGreaterThan(-1);
    expect(line.indexOf("desktop_focus")).toBeGreaterThan(
      line.indexOf("desktop_windows"),
    );
    expect(line).toMatch(/does not necessarily hold input focus/);
  });

  it("stops input on a black or empty capture instead of clicking blind", async () => {
    const line = guidanceLine(await writtenWorkflow(tmpDir), "black or empty capture");
    expect(line).toMatch(/possible escape/);
    expect(line).toMatch(/stop sending input/);
    expect(line).toMatch(/investigate managed session isolation and window state/);
    expect(line).toMatch(/Never continue blind clicking/);
    expect(line).toMatch(/never move the journey to the real desktop/);
  });

  it("scopes desktop work to the managed private display", async () => {
    const workflow = await writtenWorkflow(tmpDir);
    const line = guidanceLine(workflow, "managed X11 Xvfb display");
    expect(line).toMatch(/private HOME and XDG directories by default/);
    expect(line).toMatch(/never on the real desktop or a Wayland session/);
    expect(guidanceLine(workflow, "environment isolation")).toMatch(
      /not an OS filesystem or network sandbox/,
    );
  });

  it("keeps waits, captures and handoffs honest", async () => {
    const workflow = await writtenWorkflow(tmpDir);
    expect(guidanceLine(workflow, "desktop_wait result")).toMatch(
      /bounded observation, not proof of success.*report a timeout as a timeout/,
    );
    const captures = guidanceLine(workflow, "seven desktop input tools");
    expect(captures).toMatch(/optional capture of after or both/);
    expect(captures).toMatch(/stays off unless you ask for it/);
    expect(captures).toMatch(/not OCR-redacted/);
    const handoff = guidanceLine(workflow, "Passive watch");
    expect(handoff).toMatch(/does not pause agent input/);
    expect(handoff).toMatch(/only watch --control holds the pausing lease/);
    expect(handoff).toMatch(/fresh screenshot after a handoff/);
  });

  it("keeps the browser and Android paths and the pass rule", async () => {
    const workflow = await writtenWorkflow(tmpDir);
    expect(workflow).toContain("android_tap");
    expect(workflow).toContain("browser DevTools input tools");
    expect(workflow).toContain(
      "Pass is refused without a successful interaction and an inspected screenshot.",
    );
    expect(workflow).toContain("A device pass does not itself approve a merge.");
  });
});
