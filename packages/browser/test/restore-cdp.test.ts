import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  /** The record status each getSession call returns, in order; the last one repeats. */
  statuses: ["running"] as string[],
  supervisorAlive: true,
  switchError: undefined as Error | undefined,
  requests: 0,
}));

vi.mock("@pickforge/lab-core", () => ({
  getSession: async (id: string) => {
    const status = state.statuses.length > 1 ? state.statuses.shift() : state.statuses[0];
    return { id, type: "browser", status, browser: { browserPid: 4242, browserStartTimeTicks: 7 } };
  },
  processIdentityMatches: () => state.supervisorAlive,
}));

vi.mock("../src/session.js", () => ({
  readBrowserSessionCdpEndpoint: async () => ({ socketPath: "/tmp/cdp.sock", browserPath: "/devtools/browser/x", mode: "cdp" }),
}));

vi.mock("../src/devtools.js", () => ({
  requestCdpSupervisorMode: async () => {
    state.requests += 1;
    if (state.switchError !== undefined) throw state.switchError;
    return "cdp";
  },
}));

import { restoreCdpBrowser } from "../src/handoff.js";

afterEach(() => {
  state.statuses = ["running"];
  state.supervisorAlive = true;
  state.switchError = undefined;
  state.requests = 0;
});

describe("restoreCdpBrowser", () => {
  it("resolves true once the supervisor is back under CDP", async () => {
    await expect(restoreCdpBrowser("s1", {})).resolves.toBe(true);
    expect(state.requests).toBe(1);
  });

  it("resolves false for a session whose record no longer says running", async () => {
    state.statuses = ["stopped"];
    await expect(restoreCdpBrowser("s1", {})).resolves.toBe(false);
    expect(state.requests).toBe(0);
  });

  it("throws while the record says running but the supervisor is gone", async () => {
    state.supervisorAlive = false;
    await expect(restoreCdpBrowser("s1", {})).rejects.toThrow("The browser supervisor of session s1 is gone");
  });

  it("throws when the switch fails and the record still says running", async () => {
    state.switchError = new Error("The browser did not answer Browser.getVersion after its relaunch");
    await expect(restoreCdpBrowser("s1", {})).rejects.toThrow("did not answer Browser.getVersion");
  });

  it("resolves false when the session ended during a failed switch", async () => {
    state.statuses = ["running", "stopped"];
    state.switchError = new Error("socket closed");
    await expect(restoreCdpBrowser("s1", {})).resolves.toBe(false);
  });
});
