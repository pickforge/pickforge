import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCustomAgent,
  listCustomAgents,
  parseMcpCommand,
  recordAgentState,
  removeCustomAgent,
  writeSharedSnippets,
} from "../src/index.js";

let tmpDir: string;
let env: Record<string, string>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-custom-"));
  env = { PICKFORGE_HOME: path.join(tmpDir, ".picklab") };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseMcpCommand", () => {
  it("splits on whitespace", () => {
    expect(parseMcpCommand("pickforge-lab mcp serve")).toEqual({
      command: "pickforge-lab",
      args: ["mcp", "serve"],
    });
    expect(parseMcpCommand("  node   server.js  ")).toEqual({
      command: "node",
      args: ["server.js"],
    });
  });

  it("rejects empty commands", () => {
    expect(() => parseMcpCommand("")).toThrow("must not be empty");
    expect(() => parseMcpCommand("   ")).toThrow("must not be empty");
  });
});

describe("addCustomAgent / listCustomAgents / removeCustomAgent", () => {
  it("stores a snippet file under the agents dir and lists it", async () => {
    const agent = await addCustomAgent(
      { name: "my-agent", mcpCommand: "pickforge-lab mcp serve" },
      env,
    );
    expect(agent.configPath).toBe(
      path.join(env.PICKFORGE_HOME, "agents", "my-agent.json"),
    );
    expect(JSON.parse(fs.readFileSync(agent.configPath, "utf8"))).toEqual({
      mcpServers: { "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] } },
    });

    const listed = await listCustomAgents(env);
    expect(listed).toEqual([
      {
        name: "my-agent",
        configPath: agent.configPath,
        entry: { command: "pickforge-lab", args: ["mcp", "serve"] },
      },
    ]);
  });

  it("does not list the shared snippet files as custom agents", async () => {
    await writeSharedSnippets(env);
    expect(await listCustomAgents(env)).toEqual([]);
  });

  it("does not list the agents state file as a custom agent", async () => {
    await recordAgentState(
      "cursor",
      { registered: true, configPath: "/tmp/mcp.json" },
      env,
    );
    expect(await listCustomAgents(env)).toEqual([]);
  });

  it("rejects invalid and reserved names", async () => {
    await expect(
      addCustomAgent({ name: "../evil", mcpCommand: "x" }, env),
    ).rejects.toThrow("Invalid agent name");
    await expect(
      addCustomAgent({ name: "has space", mcpCommand: "x" }, env),
    ).rejects.toThrow("Invalid agent name");
    for (const reserved of [
      "codex",
      "claude-code",
      "cursor",
      "pickforge-mcp",
      "state",
    ]) {
      await expect(
        addCustomAgent({ name: reserved, mcpCommand: "x" }, env),
      ).rejects.toThrow("reserved");
    }
  });

  it("refuses to overwrite an existing custom agent without force", async () => {
    await addCustomAgent({ name: "dup", mcpCommand: "one serve" }, env);
    await expect(
      addCustomAgent({ name: "dup", mcpCommand: "two serve" }, env),
    ).rejects.toThrow("already exists");
    const [agent] = await listCustomAgents(env);
    expect(agent?.entry).toEqual({ command: "one", args: ["serve"] });

    const overwritten = await addCustomAgent(
      { name: "dup", mcpCommand: "two serve", force: true },
      env,
    );
    expect(overwritten.entry).toEqual({ command: "two", args: ["serve"] });
    const [after] = await listCustomAgents(env);
    expect(after?.entry).toEqual({ command: "two", args: ["serve"] });
  });

  it("removes a custom agent", async () => {
    await addCustomAgent({ name: "gone", mcpCommand: "x serve" }, env);
    const removed = await removeCustomAgent("gone", env);
    expect(removed.changed).toBe(true);
    expect(await listCustomAgents(env)).toEqual([]);
    expect((await removeCustomAgent("gone", env)).changed).toBe(false);
  });

  it("lists nothing when the agents dir does not exist", async () => {
    expect(await listCustomAgents(env)).toEqual([]);
  });
});
