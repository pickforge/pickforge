import { afterEach, describe, expect, it, vi } from "vitest";
import { readPickforgeEnv } from "../src/env-compat.js";

describe("readPickforgeEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the new variable without warning", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      readPickforgeEnv(
        { PICKFORGE_UNIT_CURRENT: "new", PICKLAB_UNIT_CURRENT: "old" },
        "UNIT_CURRENT",
      ),
    ).toBe("new");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the old variable and warns once per process", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { PICKLAB_UNIT_LEGACY: "old" };
    expect(readPickforgeEnv(env, "UNIT_LEGACY")).toBe("old");
    expect(readPickforgeEnv(env, "UNIT_LEGACY")).toBe("old");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "warning: PICKLAB_UNIT_LEGACY is deprecated; use PICKFORGE_UNIT_LEGACY instead",
    );
  });
});
