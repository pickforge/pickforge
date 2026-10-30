import fs from "node:fs";
import path from "node:path";

export function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

export type FakeChromeMode =
  | "ready"
  | "crash"
  | "crash-after-ready"
  | "launcher"
  | "stall"
  | "stubborn-stall";

/** The browser build the fake reports through `Browser.getVersion`. */
export const FAKE_CHROME_PRODUCT = "Chrome/131.0.6778.85";

/**
 * A fake Chrome binary. It is named `google-chrome-stable` — the first entry in
 * detection's preference order — so it shadows any real browser even when the
 * system bin directory is also on PATH (needed because the real Xvfb resolves
 * from there). It records its scrubbed environment, argv, and PID next to the
 * profile (env/argv inside the profile, pid in the parent session dir so it
 * survives profile deletion), then:
 *   - ready: speaks CDP like `--remote-debugging-pipe`, NUL-terminated JSON
 *     commands on fd 3 and replies on fd 4, and binds no TCP port. It records
 *     each command in `cdp-commands.jsonl` in the session dir and exits when
 *     the pipe closes or on `Browser.close`, like Chrome. After a clean
 *     `Browser.close` it writes `exited-after-close`
 *   - crash: exits non-zero immediately
 *   - crash-after-ready: answers `Browser.getVersion`, then exits non-zero
 *   - stall: stays alive but never answers the pipe
 *   - stubborn-stall: ignores graceful signals and never answers the pipe
 *     (for deterministic failed-cleanup tests). Its `chrome.pid` is written
 *     only after those handlers are installed, so it is the readiness marker.
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
      `const PRODUCT = ${JSON.stringify(FAKE_CHROME_PRODUCT)};`,
      "let profile = null;",
      "for (const a of process.argv.slice(2)) {",
      '  if (a.startsWith("--user-data-dir=")) profile = a.slice("--user-data-dir=".length);',
      "}",
      "const sessionDir = profile ? path.dirname(profile) : null;",
      "function safeWrite(p, data) {",
      "  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); } catch {}",
      "}",
      // Handlers first: chrome.pid is the readiness marker, so a test that waits
      // for it never signals a fake whose handlers are not installed yet.
      'if (MODE === "stubborn-stall") {',
      '  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});',
      "}",
      'if (sessionDir) safeWrite(path.join(sessionDir, "chrome.pid"), String(process.pid));',
      "if (profile) {",
      '  safeWrite(path.join(profile, "fake-chrome-env.json"), JSON.stringify(process.env));',
      '  safeWrite(path.join(profile, "fake-chrome-argv.json"), JSON.stringify(process.argv.slice(2)));',
      "}",
      'if (MODE === "crash") { console.error("fake Chrome crashed before answering its pipe"); process.exit(1); }',
      'if (MODE === "ready" || MODE === "crash-after-ready") {',
      "  const input = new net.Socket({ fd: 3, readable: true, writable: false });",
      "  const output = new net.Socket({ fd: 4, readable: false, writable: true });",
      '  const reply = (message, done) => output.write(JSON.stringify(message) + "\\0", done);',
      "  function handle(message) {",
      '    if (sessionDir) fs.appendFileSync(path.join(sessionDir, "cdp-commands.jsonl"), JSON.stringify(message) + "\\n");',
      '    if (message.method === "Browser.getVersion") {',
      '      const crash = () => { console.error("fake Chrome crashed after answering its pipe"); process.exit(1); };',
      '      reply({ id: message.id, result: { protocolVersion: "1.3", product: PRODUCT, revision: "@fake", userAgent: "FakeChrome", jsVersion: "13.1" } }, MODE === "crash-after-ready" ? crash : undefined);',
      "      return;",
      "    }",
      '    reply({ id: message.id, result: {}, ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }) });',
      '    if (message.method !== "Browser.close") return;',
      // A `slow-close` file in the session dir delays the clean exit by 2s.
      '    const slow = sessionDir !== null && fs.existsSync(path.join(sessionDir, "slow-close"));',
      "    setTimeout(() => {",
      '      if (sessionDir) safeWrite(path.join(sessionDir, "exited-after-close"), "1");',
      "      process.exit(0);",
      "    }, slow ? 2000 : 0);",
      "  }",
      '  let buffered = "";',
      '  input.setEncoding("utf8");',
      '  input.on("data", (chunk) => {',
      "    buffered += chunk;",
      "    let end;",
      '    while ((end = buffered.indexOf("\\0")) !== -1) {',
      "      handle(JSON.parse(buffered.slice(0, end)));",
      "      buffered = buffered.slice(end + 1);",
      "    }",
      "  });",
      // Chrome on --remote-debugging-pipe shuts down when its pipe closes.
      '  input.on("end", () => process.exit(0));',
      '  input.on("error", () => process.exit(0));',
      '  output.on("error", () => {});',
      "}",
      'if (MODE === "stall" || MODE === "stubborn-stall") console.error("fake Chrome stalled before answering its pipe");',
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
