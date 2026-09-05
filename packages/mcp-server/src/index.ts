import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { resolveContext, type CreateMcpServerOptions } from "./context.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerAndroidTools } from "./tools/android.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerDesktopTools } from "./tools/desktop.js";
import { registerSessionTools } from "./tools/session.js";
import { registerTakeoverTools } from "./tools/takeover.js";
import { registerUserTools } from "./tools/user.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export const packageName = "@pickforge/lab-mcp-server";

export type { CreateMcpServerOptions, ServerContext } from "./context.js";

export function createMcpServer(
  opts: CreateMcpServerOptions = {},
): McpServer {
  const ctx = resolveContext(opts);
  const server = new McpServer({ name: "pickforge-lab", version });
  registerSessionTools(server, ctx);
  registerDesktopTools(server, ctx);
  registerAndroidTools(server, ctx);
  registerArtifactTools(server, ctx);
  registerTakeoverTools(server, ctx);
  registerUserTools(server);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}
