#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { nativeViewerLauncher } from "./viewer/native.js";
import { createRequire } from "node:module";
import { captureFatal, initTelemetry } from "./telemetry.js";

const arg = process.argv[2];
if (arg === "--version" || arg === "-V") {
  const require = createRequire(import.meta.url);
  const { version } = require("../package.json") as { version: string };
  console.log(version);
  process.exit(0);
}
if (arg === "--help") {
  console.log(`Usage: pickforge-mcp [options]

Start the MCP server on stdio.

Options:
  -V, --version  Print the package version
  --help         Show usage`);
  process.exit(0);
}

initTelemetry();

try {
  const { runMcpServe } = await import("./commands/mcp.js");
  process.exitCode = await runMcpServe({ viewerLauncher: nativeViewerLauncher(
    fileURLToPath(new URL("./pickforge-lab.js", import.meta.url)),
  ) });
} catch (error) {
  await captureFatal(error);
  console.error(
    `error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
