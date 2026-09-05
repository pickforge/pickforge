import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createMcpServer, packageName } from "../src/index.js";

describe("@pickforge/lab-mcp-server", () => {
  it("exposes the package name", () => {
    expect(packageName).toBe("@pickforge/lab-mcp-server");
  });

  it("creates an MCP server instance", () => {
    expect(createMcpServer()).toBeInstanceOf(McpServer);
  });
});
