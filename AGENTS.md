# Pickforge

TypeScript monorepo behind `pickforge`: a CLI and MCP server that drives Xvfb desktop sessions, Android emulators and headed Chrome for coding agents. Linux only.

```
bun install --frozen-lockfile
bun run typecheck
bun run lint                 # eslint gates complexity 15, depth 4, 100-line functions
bun run test                 # add a path to run one file
bun run test:coverage        # thresholds are a gate, don't lower them
bun run test:live:android    # needs a real emulator
bun run build
```

Things you wouldn't guess:

- Desktop and browser tests need Xvfb, xdotool, ImageMagick, x11vnc, xterm and a Chrome or Chromium on PATH. Missing ones make browser tests skip quietly. CI sets `PICKFORGE_REQUIRE_BROWSER=1` so they fail instead, plus `PICKFORGE_CHROME_NO_SANDBOX=1`, which is a CI-only concession.
- CLI tests build the CLI once into `packages/cli/dist` and spawn it with fake `adb` and SDK scripts on PATH, so a stale build looks like a strange test failure.
- The Rust `pickforge` CLI has an opt-in live test that builds a real Flutter project and runs the doctor/init/evidence flow and a Dart MCP handshake against it: `PICKFORGE_LIVE_FLUTTER=1 cargo test -p pickforge-cli --test live_flutter -- --nocapture`. Without the env var, and without `flutter`/`dart` on PATH, it skips.
- `test/security` pins the guarantees we advertise: argv arrays instead of shell strings, secrets redacted before anything is stored or returned, MCP never calls sudo, VNC loopback-only and read-only. MCP screenshot `out` stays under the project dir; the CLI's `--out` is deliberately unrestricted.
- Releasing: bump every `packages/*/package.json` and `bun.lock` together. CI compares the tag to `packages/cli/package.json`, and only that package is published.
