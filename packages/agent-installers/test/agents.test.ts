import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_BROWSER_MANUAL_COMMAND,
  CLAUDE_CODE_MANUAL_COMMAND,
  claudeCodeConfigPath,
  claudeCodeIsRegistered,
  codexConfigPath,
  cursorConfigPath,
  findClaudeBinary,
  linkClaudeCode,
  piConfigPath,
  unlinkClaudeCode,
} from "../src/index.js";

let tmpDir: string;
let home: string;
let cleanEnv: Record<string, string>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-agents-"));
  home = path.join(tmpDir, "home");
  fs.mkdirSync(home, { recursive: true });
  cleanEnv = { HOME: home, PATH: path.join(tmpDir, "empty-bin") };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function installFakeClaude(script: string): Record<string, string> {
  const bin = path.join(tmpDir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const claude = path.join(bin, "claude");
  fs.writeFileSync(claude, script);
  fs.chmodSync(claude, 0o755);
  return {
    HOME: home,
    PATH: bin,
    CLAUDE_ARGS_FILE: path.join(tmpDir, "claude-args.txt"),
  };
}

function recordedArgs(env: Record<string, string>): string[] {
  return fs
    .readFileSync(env.CLAUDE_ARGS_FILE, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

const RECORDING_CLAUDE = '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "${CLAUDE_ARGS_FILE}"\n';

const ADD_CORE_ARGS = [
  "mcp",
  "add",
  "--scope",
  "user",
  "pickforge-lab",
  "--",
  "pickforge-lab",
  "mcp",
  "serve",
];
const ADD_BROWSER_ARGS = [
  "mcp",
  "add",
  "--scope",
  "user",
  "pickforge-lab-browser",
  "--",
  "pickforge-lab",
  "browser",
  "devtools-mcp",
];

describe("default config paths", () => {
  it("derive from HOME", () => {
    const env = { HOME: home };
    expect(codexConfigPath(env)).toBe(
      path.join(home, ".codex", "config.toml"),
    );
    expect(claudeCodeConfigPath(env)).toBe(path.join(home, ".claude.json"));
    expect(cursorConfigPath(env)).toBe(path.join(home, ".cursor", "mcp.json"));
    expect(piConfigPath(env)).toBe(
      path.join(home, ".config", "mcp", "mcp.json"),
    );
  });

  it("honor CODEX_HOME for codex", () => {
    const env = { HOME: home, CODEX_HOME: path.join(tmpDir, "codex-home") };
    expect(codexConfigPath(env)).toBe(
      path.join(tmpDir, "codex-home", "config.toml"),
    );
  });
});

describe("findClaudeBinary", () => {
  it("finds an executable claude on PATH and ignores empty PATH entries", () => {
    const env = installFakeClaude(RECORDING_CLAUDE);
    expect(findClaudeBinary({ PATH: `:${env.PATH}` })).toBe(
      path.join(env.PATH, "claude"),
    );
    expect(findClaudeBinary(cleanEnv)).toBeUndefined();
    expect(findClaudeBinary({ PATH: undefined })).toBeUndefined();
  });
});

describe("linkClaudeCode without the claude binary", () => {
  it("instructs instead of creating a missing ~/.claude.json", async () => {
    const configPath = path.join(home, ".claude.json");
    const result = await linkClaudeCode(configPath, cleanEnv);
    expect(result.changed).toBe(false);
    expect(result.instructions).toContain(CLAUDE_CODE_MANUAL_COMMAND);
    expect(result.instructions).not.toContain("pickforge-lab-browser");
    expect(fs.existsSync(configPath)).toBe(false);

    const withBrowser = await linkClaudeCode(configPath, cleanEnv, {
      browser: true,
    });
    expect(withBrowser.instructions).toContain(
      `${CLAUDE_CODE_MANUAL_COMMAND} && ${CLAUDE_CODE_BROWSER_MANUAL_COMMAND}`,
    );
  });

  it("merges into an existing parseable ~/.claude.json with a backup and warns", async () => {
    const configPath = path.join(home, ".claude.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ numStartups: 3, mcpServers: {} }),
    );
    const result = await linkClaudeCode(configPath, cleanEnv);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(result.warning).toContain("close Claude Code");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.numStartups).toBe(3);
    expect(config.mcpServers["pickforge-lab"]).toEqual({
      command: "pickforge-lab",
      args: ["mcp", "serve"],
    });
    expect(config.mcpServers["pickforge-lab-browser"]).toBeUndefined();
    expect(await claudeCodeIsRegistered(configPath)).toBe(true);

    const removed = await unlinkClaudeCode(configPath, cleanEnv);
    expect(removed.changed).toBe(true);
    expect(removed.warning).toContain("close Claude Code");
    expect(await claudeCodeIsRegistered(configPath)).toBe(false);
  });

  it("adds the browser relay only when opted in and unlinks both", async () => {
    const configPath = path.join(home, ".claude.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    const result = await linkClaudeCode(configPath, cleanEnv, { browser: true });
    expect(result.changed).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.mcpServers["pickforge-lab-browser"]).toEqual({
      command: "pickforge-lab",
      args: ["browser", "devtools-mcp"],
    });
    const removed = await unlinkClaudeCode(configPath, cleanEnv);
    expect(removed.changed).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers,
    ).toBeUndefined();
  });

  it("keeps a customized current browser entry when a legacy browser entry migrates by direct edit", async () => {
    const configPath = path.join(home, ".claude.json");
    const customized = { command: "custom-browser", args: ["x"] };
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          "picklab-browser": {
            command: "picklab",
            args: ["browser", "devtools-mcp"],
          },
          "pickforge-lab-browser": customized,
        },
      }),
    );
    const result = await linkClaudeCode(configPath, cleanEnv);
    expect(result.changed).toBe(true);
    expect(result.migratedLegacyEntries).toEqual(["picklab-browser"]);
    expect(result.retainedEntries).toEqual(["pickforge-lab-browser"]);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers).toEqual({
      "pickforge-lab-browser": customized,
      "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
    });
  });

  it("rejects an unparseable ~/.claude.json without touching it", async () => {
    const configPath = path.join(home, ".claude.json");
    fs.writeFileSync(configPath, "{ broken");
    await expect(linkClaudeCode(configPath, cleanEnv)).rejects.toThrow(
      "invalid JSON",
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe("{ broken");
  });
});

describe("linkClaudeCode with the claude binary on PATH", () => {
  it("shells out to claude mcp add instead of editing the file", async () => {
    const env = installFakeClaude(RECORDING_CLAUDE);
    const configPath = path.join(home, ".claude.json");
    const result = await linkClaudeCode(configPath, env);
    expect(result.changed).toBe(true);
    expect(result.instructions).toBeUndefined();
    expect(recordedArgs(env)).toEqual(ADD_CORE_ARGS);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("adds the browser relay through claude mcp add when opted in", async () => {
    const env = installFakeClaude(RECORDING_CLAUDE);
    const result = await linkClaudeCode(path.join(home, ".claude.json"), env, {
      browser: true,
    });
    expect(result).toEqual({
      configPath: path.join(home, ".claude.json"),
      changed: true,
    });
    expect(recordedArgs(env)).toEqual([...ADD_CORE_ARGS, ...ADD_BROWSER_ARGS]);
  });

  it("retains a mismatching browser entry without touching it unless opted in", async () => {
    const env = installFakeClaude(RECORDING_CLAUDE);
    const configPath = path.join(home, ".claude.json");
    const original = JSON.stringify({
      mcpServers: {
        "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
        "pickforge-lab-browser": { command: "stale", args: ["x"] },
      },
    });
    fs.writeFileSync(configPath, original);

    const result = await linkClaudeCode(configPath, env);

    expect(result).toEqual({
      configPath,
      changed: false,
      retainedEntries: ["pickforge-lab-browser"],
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.existsSync(env.CLAUDE_ARGS_FILE)).toBe(false);
  });

  it("repairs a mismatching browser entry when opted in", async () => {
    const env = installFakeClaude(
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" >> "${CLAUDE_ARGS_FILE}"',
        'if [ "${2:-}" = "add" ] && [ "${5:-}" = "pickforge-lab-browser" ] && [ ! -f "${HOME}/.removed" ]; then',
        '  echo "MCP server pickforge-lab-browser already exists in user config." >&2',
        "  exit 1",
        "fi",
        'if [ "${2:-}" = "remove" ]; then : > "${HOME}/.removed"; fi',
      ].join("\n"),
    );
    const configPath = path.join(home, ".claude.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
          "pickforge-lab-browser": { command: "stale", args: ["x"] },
        },
      }),
    );

    const result = await linkClaudeCode(configPath, env, { browser: true });

    expect(result).toEqual({ configPath, changed: true });
    expect(recordedArgs(env)).toEqual([
      ...ADD_CORE_ARGS,
      ...ADD_BROWSER_ARGS,
      "mcp",
      "remove",
      "--scope",
      "user",
      "pickforge-lab-browser",
      ...ADD_BROWSER_ARGS,
    ]);
  });

  it("does not shell out when ~/.claude.json already has pickforge-lab registered", async () => {
    const env = installFakeClaude(
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "${CLAUDE_ARGS_FILE}"\nexit 99\n',
    );
    const configPath = path.join(home, ".claude.json");
    const original = JSON.stringify({
      numStartups: 2,
      mcpServers: {
        "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
        "pickforge-lab-browser": {
          command: "pickforge-lab",
          args: ["browser", "devtools-mcp"],
        },
      },
    });
    fs.writeFileSync(configPath, original);

    const result = await linkClaudeCode(configPath, env);

    expect(result).toEqual({
      configPath,
      changed: false,
      retainedEntries: ["pickforge-lab-browser"],
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.existsSync(env.CLAUDE_ARGS_FILE)).toBe(false);

    const withBrowser = await linkClaudeCode(configPath, env, { browser: true });
    expect(withBrowser).toEqual({ configPath, changed: false });
    expect(fs.existsSync(env.CLAUDE_ARGS_FILE)).toBe(false);
  });

  it("migrates owned legacy entries through the claude binary", async () => {
    const env = installFakeClaude(RECORDING_CLAUDE);
    const configPath = path.join(home, ".claude.json");
    const original = JSON.stringify({
      mcpServers: {
        picklab: { command: "picklab", args: ["mcp", "serve"] },
        "picklab-browser": {
          command: "picklab",
          args: ["browser", "devtools-mcp"],
        },
      },
    });
    fs.writeFileSync(configPath, original);

    const result = await linkClaudeCode(configPath, env);

    expect(result.migratedLegacyEntries).toEqual([
      "picklab",
      "picklab-browser",
    ]);
    expect(result.warning).toBeUndefined();
    expect(recordedArgs(env)).toEqual([
      "mcp",
      "remove",
      "--scope",
      "user",
      "picklab",
      "mcp",
      "remove",
      "--scope",
      "user",
      "picklab-browser",
      ...ADD_CORE_ARGS,
      ...ADD_BROWSER_ARGS,
    ]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("keeps a customized current browser entry when a legacy browser entry migrates through the binary", async () => {
    const env = installFakeClaude(RECORDING_CLAUDE);
    const configPath = path.join(home, ".claude.json");
    const original = JSON.stringify({
      mcpServers: {
        picklab: { command: "picklab", args: ["mcp", "serve"] },
        "picklab-browser": {
          command: "picklab",
          args: ["browser", "devtools-mcp"],
        },
        "pickforge-lab-browser": { command: "custom-browser", args: ["x"] },
      },
    });
    fs.writeFileSync(configPath, original);

    const result = await linkClaudeCode(configPath, env);

    expect(result).toEqual({
      configPath,
      changed: true,
      migratedLegacyEntries: ["picklab", "picklab-browser"],
      retainedEntries: ["pickforge-lab-browser"],
    });
    expect(recordedArgs(env)).toEqual([
      "mcp",
      "remove",
      "--scope",
      "user",
      "picklab",
      "mcp",
      "remove",
      "--scope",
      "user",
      "picklab-browser",
      ...ADD_CORE_ARGS,
    ]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("updates a stale ~/.claude.json entry", async () => {
    const env = installFakeClaude(
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" >> "${CLAUDE_ARGS_FILE}"',
        'if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "add" ]; then',
        '  printf \'%s\\n\' \'{"mcpServers":{"pickforge-lab":{"command":"pickforge-lab","args":["mcp","serve"]},"pickforge-lab-browser":{"command":"pickforge-lab","args":["browser","devtools-mcp"]}}}\' > "${HOME}/.claude.json"',
        "fi",
      ].join("\n"),
    );
    const configPath = path.join(home, ".claude.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          "pickforge-lab": { command: "old-pickforge-lab", args: ["mcp", "serve"] },
        },
      }),
    );

    const result = await linkClaudeCode(configPath, env);

    expect(result).toEqual({ configPath, changed: true });
    expect(await claudeCodeIsRegistered(configPath)).toBe(true);
    expect(recordedArgs(env)).toEqual(ADD_CORE_ARGS);
  });

  it("shells out to claude mcp remove on unlink", async () => {
    const env = installFakeClaude(RECORDING_CLAUDE);
    const result = await unlinkClaudeCode(path.join(home, ".claude.json"), env);
    expect(result.changed).toBe(true);
    expect(recordedArgs(env)).toEqual([
      "mcp",
      "remove",
      "--scope",
      "user",
      "pickforge-lab",
      "mcp",
      "remove",
      "--scope",
      "user",
      "pickforge-lab-browser",
    ]);
  });

  it("treats an already-exists claude mcp add failure as a no-op", async () => {
    const env = installFakeClaude(
      [
        "#!/bin/sh",
        'printf \'%s\\n\' \'{"mcpServers":{"pickforge-lab":{"command":"pickforge-lab","args":["mcp","serve"]},"pickforge-lab-browser":{"command":"pickforge-lab","args":["browser","devtools-mcp"]}}}\' > "${HOME}/.claude.json"',
        'echo "MCP server ${5:-unknown} already exists in user config." >&2',
        "exit 1",
      ].join("\n"),
    );
    const configPath = path.join(home, ".claude.json");
    const result = await linkClaudeCode(configPath, env);
    expect(result).toEqual({ configPath, changed: false });
  });

  it("fails the link when claude mcp add exits with an unrelated error", async () => {
    const env = installFakeClaude('#!/bin/sh\necho "boom" >&2\nexit 1\n');
    await expect(
      linkClaudeCode(path.join(home, ".claude.json"), env),
    ).rejects.toThrow('"claude mcp add" failed for pickforge-lab (exit code 1): boom');
  });

  it("treats a not-found claude mcp remove as a no-op", async () => {
    const env = installFakeClaude(
      '#!/bin/sh\necho "No MCP server found with name: pickforge-lab" >&2\nexit 1\n',
    );
    const result = await unlinkClaudeCode(path.join(home, ".claude.json"), env);
    expect(result.changed).toBe(false);
  });
});
