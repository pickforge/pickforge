import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureCliBuilt } from "./build-once.js";

const cliPath = fileURLToPath(new URL("../dist/pickforge-lab.js", import.meta.url));

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJson(result: CliResult): Record<string, any> {
  try {
    return JSON.parse(result.stdout) as Record<string, any>;
  } catch (error) {
    throw new Error(
      `CLI did not print JSON (${(error as Error).message}); ` +
        `stdout: ${result.stdout}; stderr: ${result.stderr}`,
    );
  }
}

let tmpDir: string;
let home: string;
let env: Record<string, string>;

beforeAll(async () => {
  await ensureCliBuilt();
}, 300_000);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-agents-cli-"));
  home = path.join(tmpDir, "home");
  fs.mkdirSync(home, { recursive: true });
  env = {
    HOME: home,
    PICKFORGE_HOME: path.join(home, "state"),
    PATH: path.join(tmpDir, "empty-bin"),
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function backupsIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.includes("pickforge-backup"));
}

describe("pickforge-lab agents list", () => {
  it("lists the builtin agents as not registered in a clean home", async () => {
    const result = await runCli(["agents", "list", "--json"], env);
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.ok).toBe(true);
    const byName = Object.fromEntries(
      report.agents.map((agent: any) => [agent.name, agent]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "pi",
    ]);
    expect(byName.codex.configPath).toBe(
      path.join(home, ".codex", "config.toml"),
    );
    expect(byName["claude-code"].configPath).toBe(
      path.join(home, ".claude.json"),
    );
    expect(byName.cursor.configPath).toBe(
      path.join(home, ".cursor", "mcp.json"),
    );
    expect(byName.pi.configPath).toBe(
      path.join(home, ".config", "mcp", "mcp.json"),
    );
    for (const agent of report.agents) {
      expect(agent.registered).toBe(false);
      expect(agent.configExists).toBe(false);
    }
  });

  it("honors repeatable --config-path overrides", async () => {
    const configPath = path.join(tmpDir, "elsewhere.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
          "pickforge-lab-browser": {
            command: "pickforge-lab",
            args: ["browser", "devtools-mcp"],
          },
        },
      }),
    );
    const result = await runCli(
      ["agents", "list", "--config-path", `cursor=${configPath}`, "--json"],
      env,
    );
    expect(result.code).toBe(0);
    const cursor = parseJson(result).agents.find(
      (agent: any) => agent.name === "cursor",
    );
    expect(cursor.configPath).toBe(configPath);
    expect(cursor.registered).toBe(true);
  });

  it("reports JSONC configs as unknown instead of not registered", async () => {
    const configPath = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      '{\n  // jsonc comment\n  "mcpServers": {},\n}\n',
    );
    const result = await runCli(["agents", "list", "--json"], env);
    expect(result.code).toBe(0);
    const cursor = parseJson(result).agents.find(
      (agent: any) => agent.name === "cursor",
    );
    expect(cursor.registered).toBe("unknown");
  });
});

describe("pickforge-lab agents link cursor", () => {
  it("merges into an existing config with a backup and stays idempotent", async () => {
    const configPath = path.join(tmpDir, "cursor-mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: "other", args: [] } } }),
    );

    const linked = await runCli(
      ["agents", "link", "cursor", "--config-path", configPath, "--json"],
      env,
    );
    expect(linked.code).toBe(0);
    const report = parseJson(linked);
    expect(report.ok).toBe(true);
    expect(report.registered).toBe(true);
    expect(report.changed).toBe(true);
    expect(report.backupPath).toContain("pickforge-backup");
    expect(fs.existsSync(report.backupPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.mcpServers["pickforge-lab"]).toEqual({
      command: "pickforge-lab",
      args: ["mcp", "serve"],
    });
    expect(config.mcpServers.other).toEqual({ command: "other", args: [] });

    expect(
      fs.existsSync(
        path.join(env.PICKFORGE_HOME, "agents", "pickforge-mcp.json"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(env.PICKFORGE_HOME, "agents", "pickforge-mcp.toml"),
      ),
    ).toBe(true);

    const again = await runCli(
      ["agents", "install", "cursor", "--config-path", configPath, "--json"],
      env,
    );
    expect(again.code).toBe(0);
    const secondReport = parseJson(again);
    expect(secondReport.changed).toBe(false);
    expect(backupsIn(tmpDir)).toHaveLength(1);
  });

  it("creates a missing cursor config at the default path and unlinks it", async () => {
    const linked = await runCli(["agents", "link", "cursor", "--json"], env);
    expect(linked.code).toBe(0);
    const configPath = path.join(home, ".cursor", "mcp.json");
    expect(parseJson(linked).configPath).toBe(configPath);
    expect(
      JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers["pickforge-lab"],
    ).toBeDefined();

    const listed = parseJson(await runCli(["agents", "list", "--json"], env));
    const cursor = listed.agents.find((agent: any) => agent.name === "cursor");
    expect(cursor.registered).toBe(true);

    const unlinked = await runCli(["agents", "unlink", "cursor", "--json"], env);
    expect(unlinked.code).toBe(0);
    expect(parseJson(unlinked).changed).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(configPath, "utf8")).mcpServers,
    ).toBeUndefined();
  });
});

describe("pickforge-lab agents link pi", () => {
  it("replaces an owned legacy entry and reports the migration", async () => {
    const configPath = path.join(home, ".config", "mcp", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          picklab: { command: "picklab", args: ["mcp", "serve"] },
        },
      }),
    );

    const result = await runCli(["agents", "link", "pi"], env);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Replaced owned legacy picklab MCP entries with pickforge-lab",
    );
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.mcpServers.picklab).toBeUndefined();
    expect(config.mcpServers["pickforge-lab"]).toBeDefined();
    expect(backupsIn(path.dirname(configPath))).toHaveLength(1);
  });
});

describe("pickforge-lab agents link codex", () => {
  it("appends a marker block and removes it on unlink", async () => {
    const configPath = path.join(tmpDir, "codex-config.toml");
    fs.writeFileSync(configPath, 'model = "gpt-5"\n');

    const linked = await runCli(
      ["agents", "link", "codex", "--config-path", configPath, "--json"],
      env,
    );
    expect(linked.code).toBe(0);
    expect(parseJson(linked).registered).toBe(true);
    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain("# >>> pickforge-lab >>>");
    expect(content).toContain('[mcp_servers."pickforge-lab"]');
    expect(content).toContain("# <<< pickforge-lab <<<");

    const unlinked = await runCli(
      ["agents", "unlink", "codex", "--config-path", configPath, "--json"],
      env,
    );
    expect(unlinked.code).toBe(0);
    const after = fs.readFileSync(configPath, "utf8");
    expect(after).toContain('model = "gpt-5"');
    expect(after).not.toContain("pickforge-lab");
  });

  it("replaces an owned legacy block and reports the migration", async () => {
    const configPath = path.join(tmpDir, "codex-legacy.toml");
    fs.writeFileSync(
      configPath,
      "# >>> picklab >>>\n" +
        '[mcp_servers.picklab]\ncommand = "picklab"\nargs = ["mcp", "serve"]\n' +
        "# <<< picklab <<<\n",
    );

    const result = await runCli(
      ["agents", "link", "codex", "--config-path", configPath],
      env,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Replaced owned legacy picklab MCP entries with pickforge-lab",
    );
    const content = fs.readFileSync(configPath, "utf8");
    expect(content).not.toContain("# >>> picklab >>>");
    expect(content).toContain("# >>> pickforge-lab >>>");
    expect(backupsIn(tmpDir)).toHaveLength(1);
  });

  it("refuses a foreign [mcp_servers.picklab] section before backing up", async () => {
    const configPath = path.join(tmpDir, "codex-config.toml");
    const original = '[mcp_servers.picklab]\ncommand = "something-else"\n';
    fs.writeFileSync(configPath, original);

    const result = await runCli(
      ["agents", "install", "codex", "--config-path", configPath, "--json"],
      env,
    );
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain("outside the managed markers");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(backupsIn(tmpDir)).toEqual([]);
  });
});

describe("pickforge-lab agents link claude-code (claude binary absent)", () => {
  it("instructs instead of creating a missing ~/.claude.json", async () => {
    const result = await runCli(["agents", "link", "claude-code", "--json"], env);
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.registered).toBe(false);
    expect(report.changed).toBe(false);
    expect(report.instructions).toContain(
      "claude mcp add --scope user pickforge-lab -- pickforge-lab mcp serve",
    );
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  it("registers into an existing ~/.claude.json with a warning", async () => {
    const configPath = path.join(home, ".claude.json");
    fs.writeFileSync(configPath, JSON.stringify({ numStartups: 1 }));
    const result = await runCli(["agents", "link", "claude-code", "--json"], env);
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.registered).toBe(true);
    expect(report.warning).toContain("close Claude Code");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.numStartups).toBe(1);
    expect(config.mcpServers["pickforge-lab"]).toEqual({
      command: "pickforge-lab",
      args: ["mcp", "serve"],
    });
    expect(config.mcpServers["pickforge-lab-browser"]).toEqual({
      command: "pickforge-lab",
      args: ["browser", "devtools-mcp"],
    });
    expect(backupsIn(home)).toHaveLength(1);
  });

  it("replaces an owned legacy entry and reports the migration", async () => {
    const configPath = path.join(home, ".claude.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          picklab: { command: "picklab", args: ["mcp", "serve"] },
        },
      }),
    );

    const result = await runCli(["agents", "link", "claude-code"], env);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Replaced owned legacy picklab MCP entries with pickforge-lab",
    );
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.mcpServers.picklab).toBeUndefined();
    expect(config.mcpServers["pickforge-lab"]).toBeDefined();
    expect(backupsIn(home)).toHaveLength(1);
  });
});

describe("pickforge-lab agents link claude-code (claude binary on PATH)", () => {
  function installFakeClaude(
    script = '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "${CLAUDE_ARGS_FILE}"\n',
  ): { binDir: string; argsFile: string } {
    const binDir = path.join(tmpDir, "fake-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const claude = path.join(binDir, "claude");
    fs.writeFileSync(claude, script);
    fs.chmodSync(claude, 0o755);
    return { binDir, argsFile: path.join(tmpDir, "claude-args.txt") };
  }

  function recordedArgs(argsFile: string): string[] {
    return fs
      .readFileSync(argsFile, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  }

  it("prefers claude mcp add over editing ~/.claude.json", async () => {
    const { binDir, argsFile } = installFakeClaude();
    const cliEnv = { ...env, PATH: binDir, CLAUDE_ARGS_FILE: argsFile };
    const result = await runCli(
      ["agents", "link", "claude-code", "--json"],
      cliEnv,
    );
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.ok).toBe(true);
    expect(report.changed).toBe(true);
    expect(recordedArgs(argsFile)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "pickforge-lab",
      "--",
      "pickforge-lab",
      "mcp",
      "serve",
      "mcp",
      "add",
      "--scope",
      "user",
      "pickforge-lab-browser",
      "--",
      "pickforge-lab",
      "browser",
      "devtools-mcp",
    ]);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  it("reports install as already registered without invoking claude again", async () => {
    const { binDir, argsFile } = installFakeClaude(
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "${CLAUDE_ARGS_FILE}"\nexit 99\n',
    );
    const configPath = path.join(home, ".claude.json");
    const original = JSON.stringify({
      numStartups: 1,
      mcpServers: {
        "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
        "pickforge-lab-browser": {
          command: "pickforge-lab",
          args: ["browser", "devtools-mcp"],
        },
      },
    });
    fs.writeFileSync(configPath, original);

    const result = await runCli(
      ["agents", "install", "claude-code"],
      { ...env, PATH: binDir, CLAUDE_ARGS_FILE: argsFile },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(
      `claude-code is already registered in ${configPath} (no changes made)`,
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.existsSync(argsFile)).toBe(false);
  });

  it("updates a stale install while adding both servers", async () => {
    const { binDir, argsFile } = installFakeClaude(
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

    const result = await runCli(
      ["agents", "install", "claude-code"],
      { ...env, PATH: binDir, CLAUDE_ARGS_FILE: argsFile },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(
      `Registered the pickforge-lab MCP server for claude-code in ${configPath}`,
    );
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      mcpServers: {
        "pickforge-lab": { command: "pickforge-lab", args: ["mcp", "serve"] },
        "pickforge-lab-browser": {
          command: "pickforge-lab",
          args: ["browser", "devtools-mcp"],
        },
      },
    });
    expect(recordedArgs(argsFile)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "pickforge-lab",
      "--",
      "pickforge-lab",
      "mcp",
      "serve",
      "mcp",
      "add",
      "--scope",
      "user",
      "pickforge-lab-browser",
      "--",
      "pickforge-lab",
      "browser",
      "devtools-mcp",
    ]);
  });

  it("surfaces unrelated claude mcp add failures", async () => {
    const { binDir, argsFile } = installFakeClaude(
      '#!/bin/sh\necho "network unavailable" >&2\nexit 1\n',
    );
    const result = await runCli(
      ["agents", "install", "claude-code"],
      { ...env, PATH: binDir, CLAUDE_ARGS_FILE: argsFile },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      'error: "claude mcp add" failed for pickforge-lab (exit code 1): network unavailable',
    );
  });

  it("prefers claude mcp remove on unlink", async () => {
    const { binDir, argsFile } = installFakeClaude();
    const cliEnv = { ...env, PATH: binDir, CLAUDE_ARGS_FILE: argsFile };
    const result = await runCli(
      ["agents", "unlink", "claude-code", "--json"],
      cliEnv,
    );
    expect(result.code).toBe(0);
    expect(parseJson(result).changed).toBe(true);
    expect(recordedArgs(argsFile)).toEqual([
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
});

describe("pickforge-lab agents add / unlink (custom)", () => {
  it("adds a custom agent, lists it, and removes it", async () => {
    const added = await runCli(
      [
        "agents",
        "add",
        "--name",
        "my-agent",
        "--mcp-command",
        "pickforge-lab mcp serve",
        "--json",
      ],
      env,
    );
    expect(added.code).toBe(0);
    const addReport = parseJson(added);
    expect(addReport.ok).toBe(true);
    expect(addReport.configPath).toBe(
      path.join(env.PICKFORGE_HOME, "agents", "my-agent.json"),
    );
    expect(addReport.command).toBe("pickforge-lab");
    expect(addReport.args).toEqual(["mcp", "serve"]);

    const listed = parseJson(await runCli(["agents", "list", "--json"], env));
    const custom = listed.agents.find(
      (agent: any) => agent.name === "my-agent",
    );
    expect(custom).toBeDefined();
    expect(custom.kind).toBe("custom");
    expect(custom.registered).toBe(true);

    const removed = await runCli(
      ["agents", "unlink", "my-agent", "--json"],
      env,
    );
    expect(removed.code).toBe(0);
    expect(parseJson(removed).changed).toBe(true);
    const after = parseJson(await runCli(["agents", "list", "--json"], env));
    expect(
      after.agents.find((agent: any) => agent.name === "my-agent"),
    ).toBeUndefined();
  });

  it("rejects reserved and invalid names", async () => {
    for (const name of ["codex", "../evil"]) {
      const result = await runCli(
        ["agents", "add", "--name", name, "--mcp-command", "x", "--json"],
        env,
      );
      expect(result.code).toBe(1);
      expect(parseJson(result).ok).toBe(false);
    }
  });

  it("refuses to overwrite an existing custom agent without --force", async () => {
    const add = (extra: string[]): Promise<CliResult> =>
      runCli(
        [
          "agents",
          "add",
          "--name",
          "dup",
          "--mcp-command",
          "one serve",
          "--json",
          ...extra,
        ],
        env,
      );
    expect((await add([])).code).toBe(0);
    const duplicate = await add([]);
    expect(duplicate.code).toBe(1);
    expect(parseJson(duplicate).errors.join("\n")).toContain("already exists");
    const forced = await add(["--force"]);
    expect(forced.code).toBe(0);
    expect(parseJson(forced).ok).toBe(true);
  });

  it("rejects an empty --mcp-command", async () => {
    const result = await runCli(
      ["agents", "add", "--name", "blank", "--mcp-command", "   ", "--json"],
      env,
    );
    expect(result.code).toBe(1);
    expect(parseJson(result).errors.join("\n")).toContain("must not be empty");
  });

  it("fails for unknown agents", async () => {
    const result = await runCli(["agents", "link", "nope", "--json"], env);
    expect(result.code).toBe(1);
    expect(parseJson(result).errors.join("\n")).toContain('Unknown agent "nope"');
  });
});

describe("pickforge-lab agents doctor", () => {
  it("reports ok in a clean environment", async () => {
    const result = await runCli(["agents", "doctor", "--json"], env);
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
  });

  it("reports stale codex markers and exits 1", async () => {
    const configPath = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "# >>> pickforge-lab >>>\n# <<< pickforge-lab <<<\n");

    const result = await runCli(["agents", "doctor", "--json"], env);
    expect(result.code).toBe(1);
    const report = parseJson(result);
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain("stale");
  });

  it("exits 0 with no problem entries after link then unlink", async () => {
    expect((await runCli(["agents", "link", "cursor", "--json"], env)).code).toBe(0);
    expect(
      (await runCli(["agents", "unlink", "cursor", "--json"], env)).code,
    ).toBe(0);
    expect(
      backupsIn(path.join(home, ".cursor")).length,
    ).toBeGreaterThanOrEqual(1);

    const result = await runCli(["agents", "doctor", "--json"], env);
    expect(result.code).toBe(0);
    const report = parseJson(result);
    expect(report.ok).toBe(true);
    expect(
      report.checks.filter((check: any) => check.status === "problem"),
    ).toEqual([]);
  });

  it("inspects nonstandard config paths via --config-path", async () => {
    const configPath = path.join(tmpDir, "custom-codex.toml");
    fs.writeFileSync(configPath, "# >>> pickforge-lab >>>\n# <<< pickforge-lab <<<\n");

    const clean = await runCli(["agents", "doctor", "--json"], env);
    expect(clean.code).toBe(0);

    const overridden = await runCli(
      ["agents", "doctor", "--config-path", `codex=${configPath}`, "--json"],
      env,
    );
    expect(overridden.code).toBe(1);
    expect(parseJson(overridden).errors.join("\n")).toContain("stale");
  });

  it("rejects malformed --config-path overrides", async () => {
    const result = await runCli(
      ["agents", "doctor", "--config-path", "nope", "--json"],
      env,
    );
    expect(result.code).toBe(1);
    expect(parseJson(result).errors.join("\n")).toContain(
      "expected <agent>=<path>",
    );
  });

  it("reports broken symlinks under the agents dir", async () => {
    const agents = path.join(env.PICKFORGE_HOME, "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.symlinkSync(
      path.join(tmpDir, "gone"),
      path.join(agents, "dangling"),
    );

    const result = await runCli(["agents", "doctor", "--json"], env);
    expect(result.code).toBe(1);
    expect(parseJson(result).errors.join("\n")).toContain("broken symlink");
  });
});
