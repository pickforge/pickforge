import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { runCommand } from "../src/proc.js";

class FakeChild extends EventEmitter {
  pid = 4321;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
}
let child: FakeChild;
let controller: AbortController;
beforeEach(() => {
  vi.useFakeTimers();
  child = new FakeChild();
  controller = new AbortController();
  vi.mocked(spawn).mockReset().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("pre-aborted command never spawns or echoes arguments/reason", async () => {
  controller.abort("private reason");
  const pending = runCommand("private-command", ["private-text"], { signal: controller.signal });
  expect(spawn).not.toHaveBeenCalled();
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(result.stdout + result.stderr).toBe("");
  await expect(runCommand("private-command", ["private-text"], { signal: controller.signal, check: true })).rejects.toThrow(/^Command cancelled$/);
  expect(spawn).not.toHaveBeenCalled();
});

it("abort forces failure despite a zero exit and removes its listener", async () => {
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = runCommand("private-command", ["private-text"], { signal: controller.signal, check: true });
  const assertion = expect(pending).rejects.toThrow(/^Command cancelled$/);
  child.emit("exit", 0, null);
  controller.abort("private reason");
  child.emit("close", 0, null);
  await assertion;
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it("concurrent timeout and abort share one bounded escalation", async () => {
  const pending = runCommand("fake", [], { signal: controller.signal, timeoutMs: 10, killGraceMs: 5 });
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  await vi.advanceTimersByTimeAsync(10);
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(result.timedOut).toBe(true);
  expect(vi.mocked(process.kill).mock.calls).toEqual([[-4321, "SIGTERM"], [-4321, "SIGKILL"]]);
  expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("abort alone escalates once with existing output limits", async () => {
  const pending = runCommand("fake", [], { signal: controller.signal, killGraceMs: 5, maxOutputBytes: 2 });
  child.stdout.emit("data", Buffer.from("abcd"));
  controller.abort(); controller.abort();
  await vi.advanceTimersByTimeAsync(10);
  const result = await pending;
  expect(result).toMatchObject({ ok: false, timedOut: false, stdout: "ab", stdoutTruncated: true });
  expect(vi.mocked(process.kill).mock.calls).toEqual([[-4321, "SIGTERM"], [-4321, "SIGKILL"]]);
});

it("observes an abort racing with spawn before listener installation", async () => {
  vi.mocked(spawn).mockImplementation(() => {
    controller.abort("private reason");
    return child as unknown as ReturnType<typeof spawn>;
  });
  const pending = runCommand("fake", [], { signal: controller.signal });
  child.emit("close", 0, null);
  expect((await pending).ok).toBe(false);
  expect(process.kill).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("ordinary callers keep successful binary output semantics", async () => {
  const pending = runCommand("fake", [], { binary: true, maxOutputBytes: 2, timeoutMs: 100 });
  child.stdout.emit("data", Buffer.from([0, 255, 1]));
  child.emit("close", 0, null);
  expect(await pending).toMatchObject({ ok: true, stdout: "", stdoutBuffer: Buffer.from([0, 255]), stdoutTruncated: true, timedOut: false });
  expect(process.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["close", "error"])("abort after %s never signals a reused pid", async (event) => {
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = runCommand("fake", [], { signal: controller.signal, timeoutMs: 100 });
  const caught = pending.catch(() => undefined);
  if (event === "error") child.emit("error", new Error("synthetic spawn error"));
  else child.emit("close", 0, null);
  await caught;
  controller.abort();
  await vi.runAllTimersAsync();
  expect(process.kill).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});
