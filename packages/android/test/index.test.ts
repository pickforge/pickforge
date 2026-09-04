import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";

describe("@pickforge/lab-android", () => {
  it("exposes the package name", () => {
    expect(packageName).toBe("@pickforge/lab-android");
  });
});
