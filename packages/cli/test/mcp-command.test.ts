import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const { close, closeDuringStartup, serveStdio, StdioServerTransport } = vi.hoisted(() => {
  const closeHandle = vi.fn(async () => {});
  const closeSynchronously = { value: false };
  class FakeTransport {
    constructor(private readonly onClosed: () => void) {}
    async close(): Promise<void> {
      this.onClosed();
    }
  }
  return {
    close: closeHandle,
    closeDuringStartup: closeSynchronously,
    serveStdio: vi.fn(
      (_factory: unknown, options: { transport: FakeTransport }) => {
        if (closeSynchronously.value) void options.transport.close();
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
vi.mock("@pickforge/picklab-mcp-server", () => ({
  createMcpServer: vi.fn(),
}));

import { runMcpServe } from "../src/commands/mcp.js";

afterEach(() => {
  vi.restoreAllMocks();
  close.mockClear();
  closeDuringStartup.value = false;
  serveStdio.mockClear();
});

it("closes the stdio serve handle once and logs readiness to stderr", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdin = process.stdin as EventEmitter;
  const result = runMcpServe();
  const transport = serveStdio.mock.calls[0]?.[1]?.transport as InstanceType<
    typeof StdioServerTransport
  >;
  await transport.close();
  stdin.emit("end");
  stdin.emit("close");

  await expect(result).resolves.toBe(0);
  expect(close).toHaveBeenCalledTimes(1);
  expect(serveStdio).toHaveBeenCalledWith(expect.any(Function), {
    legacy: "serve",
    transport: expect.any(StdioServerTransport),
    onerror: expect.any(Function),
  });
  expect(stderr).toHaveBeenCalledWith("picklab mcp server: listening on stdio");
});

it("closes the handle when the transport closes synchronously during startup", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  closeDuringStartup.value = true;
  const endListeners = process.stdin.listenerCount("end");
  const closeListeners = process.stdin.listenerCount("close");

  await expect(runMcpServe()).resolves.toBe(0);

  expect(close).toHaveBeenCalledTimes(1);
  expect(process.stdin.listenerCount("end")).toBe(endListeners);
  expect(process.stdin.listenerCount("close")).toBe(closeListeners);
});
