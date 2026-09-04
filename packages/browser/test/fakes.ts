import fs from "node:fs";
import path from "node:path";

export function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

export type FakeChromeMode =
  | "ready"
  | "crash"
  | "crash-after-port"
  | "launcher"
  | "stall"
  | "stubborn-stall";

/**
 * A fake Chrome binary. It is named `google-chrome-stable` — the first entry in
 * detection's preference order — so it shadows any real browser even when the
 * system bin directory is also on PATH (needed because the real Xvfb resolves
 * from there). It records its scrubbed environment, argv, and PID next to the
 * profile (env/argv inside the profile, pid in the parent session dir so it
 * survives profile deletion), then:
 *   - ready: binds a loopback socket and publishes DevToolsActivePort
 *   - crash: exits non-zero immediately
 *   - crash-after-port: publishes a port, closes it, then exits non-zero
 *   - stall: stays alive but never publishes a port
 *   - stubborn-stall: publishes a readiness marker, ignores graceful signals,
 *     and never publishes a port (for deterministic failed-cleanup tests)
 */
export function writeFakeChrome(binDir: string, mode: FakeChromeMode): void {
  const server = path.join(binDir, "fake-chrome.cjs");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    server,
    [
      'const fs = require("node:fs");',
      'const net = require("node:net");',
      'const path = require("node:path");',
      `const MODE = ${JSON.stringify(mode === "launcher" ? "ready" : mode)};`,
      "let profile = null;",
      "for (const a of process.argv.slice(2)) {",
      '  if (a.startsWith("--user-data-dir=")) profile = a.slice("--user-data-dir=".length);',
      "}",
      "const sessionDir = profile ? path.dirname(profile) : null;",
      "function safeWrite(p, data) {",
      "  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); } catch {}",
      "}",
      'if (sessionDir) safeWrite(path.join(sessionDir, "chrome.pid"), String(process.pid));',
      "if (profile) {",
      '  safeWrite(path.join(profile, "fake-chrome-env.json"), JSON.stringify(process.env));',
      '  safeWrite(path.join(profile, "fake-chrome-argv.json"), JSON.stringify(process.argv.slice(2)));',
      "}",
      'if (MODE === "stubborn-stall") {',
      '  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});',
      "}",
      'if (MODE === "crash") { console.error("fake Chrome crashed before publishing a port"); process.exit(1); }',
      'if (MODE === "ready" || MODE === "crash-after-port") {',
      '  const response = "HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n{}";',
      "  const server = net.createServer((s) => s.end(response));",
      '  server.listen(0, "127.0.0.1", () => {',
      "    const addr = server.address();",
      '    const port = typeof addr === "object" && addr ? addr.port : 0;',
      '    if (profile) safeWrite(path.join(profile, "DevToolsActivePort"), port + "\\n/devtools/browser/fake-guid-deadbeef\\n");',
      '    if (sessionDir) safeWrite(path.join(sessionDir, "cdp-published"), String(port));',
      '    if (MODE === "crash-after-port") server.close(() => { console.error("fake Chrome crashed after publishing a port"); process.exit(1); });',
      "  });",
      "}",
      'if (MODE === "stall" || MODE === "stubborn-stall") console.error("fake Chrome stalled before publishing a port");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  writeExecutable(
    path.join(binDir, "google-chrome-stable"),
    mode === "launcher"
      ? `#!/bin/sh\n'${process.execPath}' '${server}' "$@" &\nexit 0\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${server}' "$@"\n`,
  );
}

/**
 * A PATH that finds the fake browser first, then the real system directories so
 * the production Xvfb (a light, concurrency-tested dependency) resolves. The
 * fake is named after the top detection candidate, so it still wins over any
 * real browser under /usr/bin.
 */
export function fakePath(binDir: string): string {
  return [binDir, "/usr/bin", "/bin"].join(path.delimiter);
}
