import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/program.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

describe("pickforge", () => {
  it("builds the pickforge-lab program", () => {
    const program = buildProgram();
    expect(program.name()).toBe("pickforge-lab");
    expect(program.version()).toBe(version);
  });

  it("prints the stable support boundaries in help", () => {
    let help = "";
    const program = buildProgram();
    program.configureOutput({ writeOut: (text) => { help += text; } });
    program.outputHelp();
    expect(help).toContain("Linux-only Xvfb desktop");
    expect(help).toContain("Beta.1: 3072 MiB guest RAM passed once; 2 GB failed twice");
    expect(help).toContain("public browser journey unverified");
    expect(help).toContain("macOS arm64: Rust pickforge doctor/init/evidence only, no lab");
    expect(help).toContain("Claude Code, Codex, Pi (requires pi-mcp-adapter)");
    expect(help).toContain("React Native, native iOS, Windows lab");
    expect(help).toContain(
      "Fatal-error telemetry (CLI and MCP server): disabled by default",
    );
    expect(help).toContain("Only PICKFORGE_TELEMETRY=1, true,");
    expect(help).not.toMatch(/experimental|for the alpha|alpha installer/i);
  });

  it("exposes desktop exec as a separate window-wait command", () => {
    const program = buildProgram();
    const desktop = program.commands.find((command) => command.name() === "desktop");
    const launch = desktop?.commands.find((command) => command.name() === "launch");
    const exec = desktop?.commands.find((command) => command.name() === "exec");
    expect(launch?.aliases()).not.toContain("exec");
    expect(exec).toBeDefined();
    expect(exec?.options.map((option) => option.long)).toContain(
      "--window-timeout",
    );
  });

  it("exposes --browser on agents install and its link alias", () => {
    const program = buildProgram();
    const agents = program.commands.find((command) => command.name() === "agents");
    for (const name of ["install", "link"]) {
      const command = agents?.commands.find((candidate) => candidate.name() === name);
      expect(command?.options.map((option) => option.long)).toContain("--browser");
    }
    const unlink = agents?.commands.find((command) => command.name() === "unlink");
    expect(unlink?.options.map((option) => option.long)).not.toContain("--browser");
  });

  it("exposes only project scope on the static browser relay command", () => {
    const program = buildProgram();
    const browser = program.commands.find((command) => command.name() === "browser");
    const relay = browser?.commands.find(
      (command) => command.name() === "devtools-mcp",
    );
    expect(relay).toBeDefined();
    expect(relay?.options.map((option) => option.long)).toEqual([
      "--project-dir",
    ]);
  });
});
