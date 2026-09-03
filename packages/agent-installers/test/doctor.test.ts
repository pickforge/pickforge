import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupFile,
  linkCodex,
  linkCursor,
  recordAgentState,
  removeMcpServerFromJsonFile,
  runAgentsDoctor,
  TOML_MARKER_BEGIN,
  TOML_MARKER_END,
  unlinkCursor,
  type AgentsDoctorCheck,
} from "../src/index.js";

let tmpDir: string;
let home: string;
let env: Record<string, string>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-doctor-"));
  home = path.join(tmpDir, "home");
  fs.mkdirSync(home, { recursive: true });
  env = {
    HOME: home,
    PICKFORGE_HOME: path.join(home, ".picklab"),
    PATH: path.join(tmpDir, "bin"),
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function check(
  checks: AgentsDoctorCheck[],
  id: string,
): AgentsDoctorCheck {
  const found = checks.find((candidate) => candidate.id === id);
  expect(found, `check ${id}`).toBeDefined();
  return found as AgentsDoctorCheck;
}

describe("runAgentsDoctor", () => {
  it("reports ok in a clean environment", async () => {
    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(true);
    expect(check(report.checks, "agents-dir").status).toBe("ok");
    expect(check(report.checks, "agent-codex").status).toBe("ok");
    expect(check(report.checks, "agent-claude-code").status).toBe("ok");
    expect(check(report.checks, "agent-cursor").status).toBe("ok");
    expect(check(report.checks, "pickforge-lab-bin").status).toBe("warn");
  });

  it("reports ok for healthy registrations and pickforge-lab on PATH", async () => {
    const bin = path.join(tmpDir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "pickforge-lab"), "#!/bin/sh\n");
    fs.chmodSync(path.join(bin, "pickforge-lab"), 0o755);
    await linkCodex(path.join(home, ".codex", "config.toml"));
    await linkCursor(path.join(home, ".cursor", "mcp.json"));

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(true);
    expect(check(report.checks, "agent-codex").detail).toContain("registered");
    expect(check(report.checks, "agent-cursor").detail).toContain(
      "registered",
    );
    expect(check(report.checks, "pickforge-lab-bin").status).toBe("ok");
  });

  it("flags broken symlinks in the agents dir", async () => {
    const agents = path.join(env.PICKFORGE_HOME, "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.symlinkSync(path.join(tmpDir, "missing-target"), path.join(agents, "dangling"));

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(false);
    const agentsCheck = check(report.checks, "agents-dir");
    expect(agentsCheck.status).toBe("problem");
    expect(agentsCheck.detail).toContain("broken symlink");
  });

  it("flags codex markers without a pickforge-lab section as stale", async () => {
    const configPath = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      `${TOML_MARKER_BEGIN}\n${TOML_MARKER_END}\n`,
    );

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(false);
    const codexCheck = check(report.checks, "agent-codex");
    expect(codexCheck.status).toBe("problem");
    expect(codexCheck.detail).toContain("stale");
  });

  it("warns (not problem) when backups exist without pickforge-lab state tracking", async () => {
    const configPath = path.join(home, ".cursor", "mcp.json");
    await linkCursor(configPath);
    await removeMcpServerFromJsonFile(configPath);

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(true);
    const cursorCheck = check(report.checks, "agent-cursor");
    expect(cursorCheck.status).toBe("warn");
    expect(cursorCheck.detail).toContain("backup");
  });

  it("flags configs recorded as linked that lost the pickforge-lab entry", async () => {
    const configPath = path.join(home, ".cursor", "mcp.json");
    await linkCursor(configPath);
    await recordAgentState("cursor", { registered: true, configPath }, env);
    await removeMcpServerFromJsonFile(configPath);

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(false);
    const cursorCheck = check(report.checks, "agent-cursor");
    expect(cursorCheck.status).toBe("problem");
    expect(cursorCheck.detail).toContain("stale");
  });

  it("ignores state entries recorded for a different config path", async () => {
    const defaultPath = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
    fs.writeFileSync(
      defaultPath,
      JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }),
    );
    const customPath = path.join(tmpDir, "custom.json");
    await linkCursor(customPath);
    await recordAgentState(
      "cursor",
      { registered: true, configPath: customPath },
      env,
    );

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(true);
    const cursorCheck = check(report.checks, "agent-cursor");
    expect(cursorCheck.status).toBe("ok");
  });

  it("applies state entries when doctor checks the recorded config path", async () => {
    const customPath = path.join(tmpDir, "custom.json");
    await linkCursor(customPath);
    await recordAgentState(
      "cursor",
      { registered: true, configPath: customPath },
      env,
    );
    await removeMcpServerFromJsonFile(customPath);

    const report = await runAgentsDoctor({
      env,
      configPaths: { cursor: customPath },
    });
    expect(report.ok).toBe(false);
    const cursorCheck = check(report.checks, "agent-cursor");
    expect(cursorCheck.status).toBe("problem");
    expect(cursorCheck.detail).toContain("stale");
  });

  it("matches state entries after path normalization", async () => {
    const configPath = path.join(home, ".cursor", "mcp.json");
    const unnormalized = path.join(home, ".cursor", "..", ".cursor", "mcp.json");
    await linkCursor(configPath);
    await recordAgentState(
      "cursor",
      { registered: true, configPath: unnormalized },
      env,
    );
    await removeMcpServerFromJsonFile(configPath);

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(false);
    const cursorCheck = check(report.checks, "agent-cursor");
    expect(cursorCheck.status).toBe("problem");
  });

  it("flags configs recorded as linked when the file is missing entirely", async () => {
    const configPath = path.join(home, ".cursor", "mcp.json");
    await linkCursor(configPath);
    await recordAgentState("cursor", { registered: true, configPath }, env);
    fs.rmSync(configPath);

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(false);
    const cursorCheck = check(report.checks, "agent-cursor");
    expect(cursorCheck.status).toBe("problem");
    expect(cursorCheck.detail).toContain("no longer exists");
  });

  it("reports ok after a legitimate link/unlink cycle with a tombstone", async () => {
    const configPath = path.join(home, ".cursor", "mcp.json");
    await linkCursor(configPath);
    await recordAgentState("cursor", { registered: true, configPath }, env);
    await unlinkCursor(configPath);
    await recordAgentState("cursor", { registered: false, configPath }, env);

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(true);
    expect(
      report.checks.filter((entry) => entry.status === "problem"),
    ).toEqual([]);
    const cursorCheck = check(report.checks, "agent-cursor");
    expect(cursorCheck.status).toBe("ok");
    expect(cursorCheck.detail).toContain("unlinked by pickforge-lab");
  });

  it("warns when a JSON config exists but is not strict JSON", async () => {
    const configPath = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{\n  // jsonc comment\n  "mcpServers": {},\n}\n');

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(true);
    const cursorCheck = check(report.checks, "agent-cursor");
    expect(cursorCheck.status).toBe("warn");
    expect(cursorCheck.detail).toContain("not parseable as strict JSON");
  });

  it("warns about backup clutter", async () => {
    const configPath = path.join(home, ".cursor", "mcp.json");
    await linkCursor(configPath);
    for (let i = 0; i < 5; i += 1) {
      await backupFile(configPath, new Date(2026, 0, 1, 0, 0, i));
    }

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(true);
    const cursorCheck = check(report.checks, "agent-cursor");
    expect(cursorCheck.status).toBe("warn");
    expect(cursorCheck.detail).toContain("backups");
  });

  it("warns about unmanaged codex pickforge-lab sections", async () => {
    const configPath = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '[mcp_servers.picklab]\ncommand = "x"\n');

    const report = await runAgentsDoctor({ env });
    expect(report.ok).toBe(true);
    const codexCheck = check(report.checks, "agent-codex");
    expect(codexCheck.status).toBe("warn");
    expect(codexCheck.detail).toContain("does not manage");
  });
});
