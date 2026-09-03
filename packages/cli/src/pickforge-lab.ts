#!/usr/bin/env node
import { captureFatal, initTelemetry } from "./telemetry.js";

initTelemetry();

try {
  const { buildProgram } = await import("./program.js");
  await buildProgram().parseAsync();
} catch (error) {
  await captureFatal(error);
  console.error(
    `error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
