import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/program.js";

describe("pickforge", () => {
  it("builds the pickforge-lab program", () => {
    const program = buildProgram();
    expect(program.name()).toBe("pickforge-lab");
    expect(program.version()).toBe("0.4.0-alpha.1");
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
