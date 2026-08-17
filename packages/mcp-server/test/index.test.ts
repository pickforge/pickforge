import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createMcpServer, packageName } from "../src/index.js";

describe("@pickforge/picklab-mcp-server", () => {
  it("exposes the package name", () => {
    expect(packageName).toBe("@pickforge/picklab-mcp-server");
  });

  it("creates an MCP server instance", () => {
    expect(createMcpServer()).toBeInstanceOf(McpServer);
  });
});
