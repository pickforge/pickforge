import fs from "node:fs";
import { startXvfb, stopXvfb } from "../../src/display.js";

const [gate, release, ready, result, logDir, binDir, startRaw] =
  process.argv.slice(2);
if (
  gate === undefined ||
  release === undefined ||
  ready === undefined ||
  result === undefined ||
  logDir === undefined ||
  binDir === undefined ||
  startRaw === undefined
) {
  process.exit(2);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

fs.writeFileSync(ready, "ready");
while (!fs.existsSync(gate)) await sleep(5);

try {
  const xvfb = await startXvfb({
    displayStart: Number(startRaw),
    width: 64,
    height: 64,
    depth: 8,
    waitTimeoutMs: 5_000,
    logDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
  fs.writeFileSync(result, JSON.stringify({ ok: true, display: xvfb.display }));
  while (!fs.existsSync(release)) await sleep(5);
  const stopped = await stopXvfb(xvfb.pid, xvfb.startTimeTicks);
  if (!stopped) process.exitCode = 3;
} catch (error) {
  fs.writeFileSync(
    result,
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
