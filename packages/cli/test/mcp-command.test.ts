import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const { close, serveStdio } = vi.hoisted(() => {
  const closeHandle = vi.fn(async () => {});
  return {
    close: closeHandle,
    serveStdio: vi.fn(() => ({ close: closeHandle })),
  };
});

vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio }));
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
  stdin.emit("end");
  stdin.emit("close");

  await expect(result).resolves.toBe(0);
  expect(close).toHaveBeenCalledTimes(1);
  expect(serveStdio).toHaveBeenCalledWith(expect.any(Function), {
    legacy: "serve",
    onerror: expect.any(Function),
  });
  expect(stderr).toHaveBeenCalledWith("picklab mcp server: listening on stdio");
});
