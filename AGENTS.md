Linux-only desktop, Android and browser automation. Keep coverage thresholds intact.

Desktop and browser tests need Xvfb, xdotool, ImageMagick, x11vnc, xterm and Chrome or Chromium on PATH. Missing dependencies can silently skip browser tests; set `PICKLAB_REQUIRE_BROWSER=1` when validating browser support. `PICKLAB_CHROME_NO_SANDBOX=1` is a CI-only concession, not a local default. Live Android tests need a real emulator.

CLI tests build into `packages/cli/dist` and spawn with fake adb and SDK scripts. A stale build can masquerade as a runtime failure.

`test/security` protects argv arrays rather than shell strings, redaction before storage or return, no sudo from MCP, and loopback-only, read-only VNC. MCP screenshot `out` stays inside the project directory; CLI `--out` is deliberately unrestricted.

Releases bump all `packages/*/package.json` versions and `bun.lock` together. CI compares the tag to `packages/cli/package.json`; only that package is published.
