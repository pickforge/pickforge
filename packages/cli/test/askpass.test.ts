// pickforge/pickforge#27 — Linux graphical sudo (askpass) capability
// detection. Mirrors the branch coverage of the shared Rust reference
// (crates/pickforge-core/src/process/askpass.rs in pickforge/pickforge#215)
// so both repos' implementations of the locked v1 contract stay provably in
// sync: headless/graphical, user-set-vs-probe-list priority, empty-value
// handling, and the four distinct states.

import { describe, expect, it } from "vitest";
import {
  ASKPASS_PROBE_PATHS,
  askpassUnavailableMessage,
  detectAskpassCapability,
  resolveAskpassCapability,
} from "../src/provision/askpass.js";

describe("detectAskpassCapability", () => {
  it("is headless when no display vars are present", () => {
    expect(detectAskpassCapability({ PATH: "/usr/bin" }, () => true)).toEqual(
      { state: "headless" },
    );
  });

  it("is headless when display vars are present but empty", () => {
    expect(
      detectAskpassCapability(
        { WAYLAND_DISPLAY: "", DISPLAY: "" },
        () => true,
      ),
    ).toEqual({ state: "headless" });
  });

  it("is graphical via WAYLAND_DISPLAY alone", () => {
    expect(
      detectAskpassCapability({ WAYLAND_DISPLAY: "wayland-0" }, () => true),
    ).toEqual({ state: "available", helper: ASKPASS_PROBE_PATHS[0] });
  });

  it("is graphical via DISPLAY alone", () => {
    expect(detectAskpassCapability({ DISPLAY: ":0" }, () => true)).toEqual({
      state: "available",
      helper: ASKPASS_PROBE_PATHS[0],
    });
  });

  it("prefers a user-set executable SUDO_ASKPASS over the probe list", () => {
    const capability = detectAskpassCapability(
      { DISPLAY: ":0", SUDO_ASKPASS: "/opt/custom/my-askpass" },
      (p) => p === "/opt/custom/my-askpass",
    );
    expect(capability).toEqual({
      state: "available",
      helper: "/opt/custom/my-askpass",
    });
  });

  it("falls back to the probe list when the user-set SUDO_ASKPASS is not executable", () => {
    const capability = detectAskpassCapability(
      { DISPLAY: ":0", SUDO_ASKPASS: "/opt/custom/not-there" },
      (p) => p === ASKPASS_PROBE_PATHS[1],
    );
    expect(capability).toEqual({
      state: "available",
      helper: ASKPASS_PROBE_PATHS[1],
    });
  });

  it("treats an empty user-set SUDO_ASKPASS as unset (probe list still gets a chance)", () => {
    const capability = detectAskpassCapability(
      { DISPLAY: ":0", SUDO_ASKPASS: "" },
      (p) => p === ASKPASS_PROBE_PATHS[0],
    );
    expect(capability).toEqual({
      state: "available",
      helper: ASKPASS_PROBE_PATHS[0],
    });
  });

  it("is no-helper when graphical but nothing on the probe list resolves", () => {
    expect(
      detectAskpassCapability(
        { DISPLAY: ":0", SUDO_ASKPASS: "/nope" },
        () => false,
      ),
    ).toEqual({ state: "no-helper" });
  });

  it("never surfaces an unvalidated environment value as a helper", () => {
    // The only escape hatch for untrusted input is SUDO_ASKPASS, and it is
    // used only after `isExecutable` accepts it — a value that fails
    // validation can never reach `available`.
    const capability = detectAskpassCapability(
      {
        DISPLAY: ":0",
        SUDO_ASKPASS: "rm -rf / #not-a-path-and-not-executable",
      },
      () => false,
    );
    expect(capability).toEqual({ state: "no-helper" });
  });
});

describe("resolveAskpassCapability", () => {
  it("is unsupported-platform on non-Linux platforms regardless of env", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(resolveAskpassCapability({ DISPLAY: ":0" })).toEqual({
        state: "unsupported-platform",
      });
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("detects against the real filesystem on Linux", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      // No graphical session vars set here -> headless, deterministically,
      // without needing any real askpass binaries on the test machine.
      expect(resolveAskpassCapability({})).toEqual({ state: "headless" });
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });
});

describe("askpassUnavailableMessage", () => {
  const manual = "sudo useradd -r -M pickforge-lab";

  it.each([
    ["headless", { state: "headless" } as const, /graphical session/i],
    ["no-helper", { state: "no-helper" } as const, /SUDO_ASKPASS helper/i],
    [
      "unsupported-platform",
      { state: "unsupported-platform" } as const,
      /only supported on Linux/i,
    ],
  ])("names the manual fallback for %s", (_label, capability, expected) => {
    const message = askpassUnavailableMessage(capability, manual);
    expect(message).toMatch(expected);
    expect(message).toContain(`Run it yourself in a terminal: ${manual}`);
  });
});
