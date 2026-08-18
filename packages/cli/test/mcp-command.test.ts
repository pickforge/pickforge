import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const { close, serveStdio, StdioServerTransport } = vi.hoisted(() => {
  const closeHandle = vi.fn(async () => {});
  class FakeTransport {
    onClosed?: () => void;
    async close(): Promise<void> {
      this.onClosed?.();
    }
  }
  return {
    close: closeHandle,
    serveStdio: vi.fn(
      (_factory: unknown, _options: { transport: FakeTransport }) => ({
        close: closeHandle,
      }),
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
