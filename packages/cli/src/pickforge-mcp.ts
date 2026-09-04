#!/usr/bin/env node
import { captureFatal, initTelemetry } from "./telemetry.js";

initTelemetry();

try {
  const { runMcpServe } = await import("./commands/mcp.js");
  process.exitCode = await runMcpServe();
} catch (error) {
  await captureFatal(error);
  console.error(
    `error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
