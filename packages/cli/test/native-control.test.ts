import { afterEach, expect, it, vi } from "vitest";
import { startHumanTakeover, endHumanTakeover, type HumanTakeoverHandle, type NativeViewerCommand } from "@pickforge/lab-desktop-linux";
import { NativeControl } from "../src/viewer/native-control.js";

vi.mock("@pickforge/lab-desktop-linux", () => ({ startHumanTakeover: vi.fn(), endHumanTakeover: vi.fn() }));
vi.mock("../src/commands/takeover-hold.js", () => ({ holdHumanLease: () => ({ stopRenewing() {}, stop() {} }) }));
afterEach(() => vi.clearAllMocks());

it("answers takeRequested with unavailable while return cleanup is pending", async () => {
  const commands: NativeViewerCommand[] = [];
  const handle = { leaseId: "lease", heartbeatMs: 100 } as HumanTakeoverHandle;
  vi.mocked(startHumanTakeover).mockResolvedValue(handle);
  let finish!: () => void;
  vi.mocked(endHumanTakeover).mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ reason: "return" }); }));
  const control = new NativeControl({ sessionId: "test", env: {}, send: (command) => commands.push(command),
    kill() {}, taken() {}, returned() {} });
  await control.take();
  control.viewerExited();
  const ending = control.end("returned");
  await vi.waitFor(() => expect(endHumanTakeover).toHaveBeenCalled());
  await control.take();
  expect(commands).toContainEqual({ cmd: "control", state: "revoked", leaseId: "", reason: "unavailable" });
  finish();
  await ending;
});

it("surfaces explicit startup acquisition failures while answering the viewer", async () => {
  const send = vi.fn();
  vi.mocked(startHumanTakeover).mockRejectedValue(new Error("Lease drain timeout"));
  const control = new NativeControl({ sessionId: "test", env: {}, send, kill() {}, taken() {}, returned() {} });
  await expect(control.take(true)).rejects.toThrow("Lease drain timeout");
  expect(send).toHaveBeenCalledWith({ cmd: "control", state: "revoked", leaseId: "", reason: "unavailable" });
});
