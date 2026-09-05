import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/program.js";

describe("pickforge", () => {
  it("builds the pickforge-lab program", () => {
    const program = buildProgram();
    expect(program.name()).toBe("pickforge-lab");
    expect(program.version()).toBe("0.4.0-alpha.2");
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
