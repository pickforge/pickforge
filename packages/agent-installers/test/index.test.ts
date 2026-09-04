import { describe, expect, it } from "vitest";
import {
  AGENT_KINDS,
  builtinAgent,
  BUILTIN_AGENTS,
  packageName,
} from "../src/index.js";

describe("@pickforge/lab-agent-installers", () => {
  it("exposes the package name", () => {
    expect(packageName).toBe("@pickforge/lab-agent-installers");
  });

  it("exposes a builtin agent for every kind", () => {
    expect(Object.keys(BUILTIN_AGENTS).sort()).toEqual(
      [...AGENT_KINDS].sort(),
    );
    for (const kind of AGENT_KINDS) {
      expect(builtinAgent(kind)?.name).toBe(kind);
    }
    expect(builtinAgent("nope")).toBeUndefined();
    expect(builtinAgent("hasOwnProperty")).toBeUndefined();
  });
});
