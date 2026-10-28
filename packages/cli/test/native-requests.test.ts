import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "@pickforge/lab-core";
import { NativeRequests } from "../src/viewer/native-requests.js";
import type { NativeViewerCommand } from "@pickforge/lab-desktop-linux";

vi.mock("@pickforge/lab-core", () => ({ runCommand: vi.fn(async () => ({})) }));
vi.mock("@pickforge/lab-desktop-linux", () => ({ findOnPath: () => "/fake/notify-send" }));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

function fixture(mode: "thumbnail" | "expanded" | "fullscreen" = "thumbnail", controlling = false) {
  const commands: NativeViewerCommand[] = [];
  const place = vi.fn(async (next: "expanded" | "thumbnail") => { mode = next; });
  const requests = new NativeRequests({ env: {}, send: (command) => commands.push(command),
    mode: place, currentMode: () => mode, controlling: () => controlling });
  return { requests, commands, place, returnControl: () => { controlling = false; requests.returned("returned"); } };
}

describe("native attention request regressions", () => {
  it("escapes notification markup after truncating by code points", async () => {
    const { requests } = fixture();
    const message = "<&>" + "a".repeat(116) + "😀" + "extra";
    const id = await requests.request(message, 5_000);
    expect(vi.mocked(runCommand).mock.calls[0]![1].at(-1)).toBe("&lt;&amp;&gt;" + "a".repeat(116) + "😀");
    await requests.cancel(id);
  });

  it("completes a taken request as returned while closing", async () => {
    const { requests } = fixture();
    const id = await requests.request("Help", 5_000);
    requests.taken();
    requests.beginClose();
    requests.returned("returned");
    requests.close();
    expect(requests.state(id)).toMatchObject({ outcome: "returned" });
  });

  it.each(["expanded", "fullscreen"] as const)("preserves an existing %s window on cancel and timeout", async (mode) => {
    vi.useFakeTimers();
    const { requests, place } = fixture(mode);
    const cancelled = await requests.request("Help", 5_000);
    await requests.cancel(cancelled);
    const timed = await requests.request("Help", 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(requests.state(timed)).toMatchObject({ outcome: "timeout" });
    expect(place).not.toHaveBeenCalled();
  });

  it("collapses a window expanded by the request", async () => {
    const { requests, place } = fixture();
    const id = await requests.request("Help", 5_000);
    await requests.cancel(id);
    expect(place.mock.calls).toEqual([["expanded"], ["thumbnail"]]);
  });

  it("sends no attention while already controlling and clears it on return", async () => {
    const { requests, commands, returnControl } = fixture("expanded", true);
    const id = await requests.request("Help", 5_000);
    expect(requests.state(id)).toMatchObject({ event: "controlTaken" });
    expect(commands).toEqual([]);
    expect(runCommand).not.toHaveBeenCalled();
    returnControl();
    expect(requests.state(id)).toMatchObject({ outcome: "returned" });
    expect(commands).toEqual([{ cmd: "clearAttention" }]);
  });
});
