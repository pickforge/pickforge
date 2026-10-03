Linux-only desktop, Android and browser automation. Keep coverage thresholds intact.

Desktop and browser tests need Xvfb, xdotool, ImageMagick, x11vnc, xterm and Chrome or Chromium on PATH. Missing dependencies can silently skip browser tests; set `PICKFORGE_REQUIRE_BROWSER=1` when validating browser support. `PICKFORGE_CHROME_NO_SANDBOX=1` is a CI-only concession, not a local default. Live Android tests need a real emulator. The Rust CLI live Flutter test requires Flutter and Dart: `PICKFORGE_LIVE_FLUTTER=1 cargo test -p pickforge-cli --test live_flutter -- --nocapture`; it skips without the opt-in flag or tools.

Tests and QA must never start an X server without an explicit free display. Do not use bare `Xvfb -displayfd` or `xvfb-run -d`; pass a display such as `Xvfb :1234 -displayfd 3` or use `xvfb-run -a`. Never bind-mount the host `/tmp/.X11-unix` into a container that runs its own X server or compositor. The security scan is textual, so prose that mentions these unsafe forms in scanned files also fails it. The test run fails if the host `DISPLAY` socket changes; see #234.

CLI tests build into `packages/cli/dist` and spawn with fake adb and SDK scripts. A stale build can masquerade as a runtime failure.

`test/security` protects argv arrays rather than shell strings, redaction before storage or return, no sudo from MCP, and loopback-only, read-only VNC. MCP screenshot `out` stays inside the project directory; CLI `--out` is deliberately unrestricted.

Releases bump all `packages/*/package.json`, `Cargo.toml` and `bun.lock` together. `node scripts/check-release-versions.mjs [tag]` is the gate; only `packages/cli` is published. Publishing waits for `scripts/candidate-smoke.sh` to install and execute the exact artifacts in a clean Flutter container and on Apple silicon. Workflow dispatch publishes only when `confirm` exactly matches the release tag on `main`.
