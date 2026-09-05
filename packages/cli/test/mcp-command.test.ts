import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const { closeHandle, closeDuringStart, serveStdio, StdioServerTransport } =
  vi.hoisted(() => {
    const closeHandle = vi.fn(async () => {});
    const closeDuringStart = { value: false };
    class FakeTransport {
      async close(): Promise<void> {}
    }
    return {
      closeHandle,
      closeDuringStart,
      serveStdio: vi.fn(
        (
          _factory: unknown,
          options: { transport: FakeTransport; onerror: (error: Error) => void },
        ) => {
          if (closeDuringStart.value) void options.transport.close();
          return { close: closeHandle };
        },
      ),
      StdioServerTransport: FakeTransport,
    };
  });

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio,
  StdioServerTransport,
}));
vi.mock("@pickforge/lab-mcp-server", () => ({
  createMcpServer: vi.fn(() => ({ server: true })),
}));

import {
  createMcpErrorReporter,
  runMcpServe,
} from "../src/commands/mcp.js";

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function listenerCounts(): Record<string, number> {
  return Object.fromEntries(
    ["end", "close"].map((event) => [
      `stdin:${event}`,
      process.stdin.listenerCount(event),
    ]).concat(
      signals.map((signal) => [
        `process:${signal}`,
        process.listenerCount(signal),
      ]),
    ),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeHandle.mockClear();
  closeDuringStart.value = false;
  serveStdio.mockClear();
});

it("closes once on transport close and removes every lifecycle listener", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const before = listenerCounts();
  const result = runMcpServe();
  const transport = serveStdio.mock.calls[0]?.[1]?.transport as InstanceType<
    typeof StdioServerTransport
  >;

  await transport.close();
  (process.stdin as EventEmitter).emit("end");
  (process.stdin as EventEmitter).emit("close");

  await expect(result).resolves.toBe(0);
  expect(closeHandle).toHaveBeenCalledTimes(1);
  expect(listenerCounts()).toEqual(before);
  expect(serveStdio).toHaveBeenCalledWith(expect.any(Function), {
    legacy: "serve",
    transport: expect.any(StdioServerTransport),
    onerror: expect.any(Function),
  });
  expect(stderr).toHaveBeenCalledWith(
    "pickforge-lab mcp server: listening on stdio\n",
  );
});

it("handles a transport close racing stdio startup", async () => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  closeDuringStart.value = true;
  const before = listenerCounts();

  await expect(runMcpServe()).resolves.toBe(0);

  expect(closeHandle).toHaveBeenCalledTimes(1);
  expect(listenerCounts()).toEqual(before);
});

it("bounds, redacts, and rate-limits transport diagnostics", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
  const output: string[] = [];
  const report = createMcpErrorReporter((message) => output.push(message));
  const secret = `ghp_${"a".repeat(36)}`;

  for (let index = 0; index < 20; index += 1) {
    report(new Error(`${secret}\n${"x".repeat(10_000)}`));
  }

  const firstWindow = output.join("");
  expect(firstWindow).not.toContain(secret);
  expect(firstWindow).toContain("[REDACTED]");
  expect(firstWindow).toContain("[truncated]");
  expect(firstWindow).toContain("further errors suppressed");
  expect(output).toHaveLength(9);
  expect(Buffer.byteLength(firstWindow)).toBeLessThan(18_000);

  vi.advanceTimersByTime(60_000);
  report(new Error("diagnostics resumed"));
  expect(output.at(-1)).toContain("diagnostics resumed");
  expect(output).toHaveLength(10);
});
