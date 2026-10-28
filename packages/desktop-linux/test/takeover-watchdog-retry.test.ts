import { expect, it, vi } from "vitest";
import { recoverStaleHumanLease } from "../src/takeover.js";
import { runTakeoverWatchdogLoop } from "../src/takeover-watchdog.js";

vi.mock("@pickforge/lab-core", () => ({ readHumanLease: async () => ({ leaseId: "lease" }), isHumanLeaseStale: () => true }));
vi.mock("../src/takeover.js", () => ({ recoverStaleHumanLease: vi.fn() }));

it("keeps the watchdog alive after an unverifiable recovery until cleanup succeeds", async () => {
  vi.mocked(recoverStaleHumanLease).mockRejectedValueOnce(new Error("Owner unverified"))
    .mockResolvedValueOnce({ recovered: false }).mockResolvedValueOnce({ recovered: true });
  await runTakeoverWatchdogLoop({ sessionId: "session", leaseId: "lease", pollIntervalMs: 1 });
  expect(recoverStaleHumanLease).toHaveBeenCalledTimes(3);
});
