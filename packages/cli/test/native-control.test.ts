import { afterEach, describe, expect, it, vi } from "vitest";
import { startHumanTakeover, endHumanTakeover, type HumanTakeoverHandle, type NativeViewerCommand } from "@pickforge/lab-desktop-linux";
import { enterPlainBrowser, restoreCdpBrowser } from "@pickforge/lab-browser";
import { NativeControl } from "../src/viewer/native-control.js";

const held = vi.hoisted(() => ({ stopRenewing: vi.fn(), stop: vi.fn() }));
vi.mock("@pickforge/lab-desktop-linux", () => ({ startHumanTakeover: vi.fn(), endHumanTakeover: vi.fn() }));
vi.mock("@pickforge/lab-browser", () => ({ enterPlainBrowser: vi.fn(), restoreCdpBrowser: vi.fn() }));
vi.mock("../src/commands/takeover-hold.js", () => ({ holdHumanLease: () => held }));
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

describe("browser handoff (#380)", () => {
  const handle = { sessionId: "test", leaseId: "lease", heartbeatMs: 100 } as HumanTakeoverHandle;
  const env = { PICKFORGE_HOME: "/nonexistent" };

  function hooked(order: string[]): void {
    vi.mocked(startHumanTakeover).mockImplementation(async (id, opts) => {
      order.push("acquire");
      await opts?.afterLease?.({ sessionId: id, leaseId: handle.leaseId });
      return handle as never;
    });
    vi.mocked(endHumanTakeover).mockImplementation(async (h, opts) => {
      await opts.beforeRelease?.(h);
      order.push("release");
      return { reason: opts.reason };
    });
  }

  it("enters plain Chrome before input and keeps the heartbeat until CDP is back", async () => {
    const order: string[] = [];
    hooked(order);
    vi.mocked(enterPlainBrowser).mockImplementation(async () => { order.push("plain"); return true; });
    vi.mocked(restoreCdpBrowser).mockImplementation(async () => {
      expect(held.stopRenewing).not.toHaveBeenCalled();
      order.push("cdp");
      return true;
    });
    held.stopRenewing.mockImplementation(() => { order.push("stopRenewing"); });
    const returned = vi.fn();
    const control = new NativeControl({ sessionId: "test", env, send() {}, kill() {},
      taken: () => order.push("input"), returned });
    await control.take();
    control.viewerReady();
    control.viewerExited();
    await control.end("returned");
    expect(order).toEqual(["acquire", "plain", "input", "cdp", "stopRenewing", "release", "stopRenewing"]);
    expect(enterPlainBrowser).toHaveBeenCalledWith("test", env);
    expect(restoreCdpBrowser).toHaveBeenCalledWith("test", env);
    expect(returned).toHaveBeenCalledWith("returned");
  });

  it("reports a failed restore and still ends the takeover", async () => {
    const order: string[] = [];
    hooked(order);
    vi.mocked(enterPlainBrowser).mockResolvedValue(true);
    vi.mocked(restoreCdpBrowser).mockRejectedValue(new Error("relaunch failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const returned = vi.fn();
    const control = new NativeControl({ sessionId: "test", env, send() {}, kill() {}, taken() {}, returned });
    await control.take();
    control.viewerExited();
    await control.end("lease-lost");
    expect(order).toEqual(["acquire", "release"]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("relaunch failed"));
    expect(returned).toHaveBeenCalledWith("lease-lost");
    expect(held.stop).toHaveBeenCalled();
    error.mockRestore();
  });

  it("answers unavailable when entering plain Chrome fails", async () => {
    const send = vi.fn();
    vi.mocked(startHumanTakeover).mockImplementation(async (id, opts) => {
      await opts?.afterLease?.({ sessionId: id, leaseId: "lease" });
      return handle as never;
    });
    vi.mocked(enterPlainBrowser).mockRejectedValue(new Error("plain failed"));
    const control = new NativeControl({ sessionId: "test", env, send, kill() {}, taken() {}, returned() {} });
    await expect(control.take(true)).rejects.toThrow("plain failed");
    expect(control.active).toBe(false);
    expect(send).toHaveBeenCalledWith({ cmd: "control", state: "revoked", leaseId: "", reason: "unavailable" });
  });
});
