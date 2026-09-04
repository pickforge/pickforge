# Pickforge 0.4.0-alpha.1

Draft release notes for the first Pickforge prerelease. Use this file as the
GitHub release description, then reset it after the release is published.

## PickLab is now Pickforge

- The npm package is now `pickforge`. This alpha is published under the `next`
  dist-tag.
- The TypeScript commands are now `pickforge-lab` and `pickforge-mcp`. Agent
  config uses `pickforge-lab`, and linking replaces an owned legacy `picklab`
  MCP entry in the same config update.
- The durable Rust command remains `pickforge` and now ships beside the npm
  commands through `install.sh`.
- `PICKFORGE_*` environment variables fall back to `PICKLAB_*` for one release
  and print one deprecation warning to stderr per process.
- New TypeScript state is written under `~/.pickforge/lab/`, or
  `PICKFORGE_HOME`. Existing state under `~/.pickforge/picklab/` and
  `~/.picklab/` remains readable in place. Nothing is silently migrated or
  deleted.
- After installing `pickforge`, remove the old package with
  `npm uninstall -g @pickforge/picklab` or
  `bun remove -g @pickforge/picklab`.

## Lab isolation

- x11vnc now uses the isolated lab X11 environment instead of inheriting a
  Wayland host session that prevents it from starting.
- Desktop commands now share one isolated X11 environment that points
  `WAYLAND_DISPLAY` at the non-existent `pickforge-no-wayland` socket, removes
  other inherited `WAYLAND_*` variables, and sets Electron, GLFW, GTK, Qt,
  SDL, winit, and session backend hints. The poison value prevents libwayland
  from falling back to the user's default `wayland-0` socket when the variable
  is unset.
- Desktop sessions now contain daemonising apps. Each session owns a
  containment scope — a private cgroup v2 directory where a delegated cgroup is
  available, otherwise a per-session random `PICKFORGE_CONTAINMENT_TOKEN` — and
  apps start through a supervisor that joins the scope before spawning them, so
  a double-fork or `setsid` descendant cannot escape it, and that verifies its
  cgroup membership from `/proc/self/cgroup` before spawning anything.
  `session destroy` reports success only once the scope is confirmed empty,
  treats a PID that exited during cleanup as gone, refuses to signal a live PID
  whose identity no longer matches, and never kills the process running it:
  a `session destroy` typed into a contained shell moves its own process chain
  out of the session cgroup first, or refuses with an actionable reason.
  `NODE_OPTIONS` and related code-injection variables are stripped from the
  desktop environment. Neither mechanism requires `sudo`.
- A containment scope is bound to the session that owns it. A scope cgroup must
  be named `pickforge-<session id>`, so a tampered record can never point one
  session's launch or cleanup at another session's valid-looking scope, and a
  `cgroup` scope with no path is refused instead of silently starting an app
  uncontained. Immediately before the kill, every process in the scope must be
  shown to carry that session's token (or to descend from one that does), and
  the caller's own process chain is moved out by pinned identity, so an
  ancestor whose PID was recycled is refused rather than migrated. Cleanup also
  never forgets a process it has already identified: one whose environment
  stays unreadable is reported as an unconfirmed survivor instead of vanishing
  from an empty scan.
- A failed x11vnc startup now stops the whole process group it spawned and
  reports what it owned, so a failed `session create` keeps the session runtime
  directory and the VNC identity for a reaper retry unless that cleanup is
  confirmed. `stopXvfb` refuses a live PID when no recorded start identity is
  passed, rather than verifying a snapshot that proves nothing about the Xvfb
  the caller meant.
- Desktop sessions now get their own `XDG_RUNTIME_DIR` (mode `0700`, inside the
  session directory) and their own D-Bus addresses, which point at sockets
  Pickforge never creates, so toolkits and portals fail closed instead of
  routing work back through the real user session. x11vnc gets the same
  runtime whenever it is started, including by `desktop watch` and by a human
  takeover. The directory is removed on destroy only once contained apps,
  x11vnc and Xvfb are confirmed gone, and removal is refused for any path
  outside the session directory, including through a symlink.
- `desktop exec`, `desktop launch` and their MCP tools now report the
  containment mechanism they achieved (`cgroup` or `marker`), and
  `desktop env` prints the runtime, D-Bus and containment recipe so an app
  started by hand from that shell is torn down with the session.
- Xvfb teardown now uses the same group-signal-and-confirm discipline as the
  browser supervisor, so an exited Xvfb is never reported gone while a member of
  its process group survives.
- `pickforge-lab desktop exec`, also available as MCP `desktop_exec`, starts a
  command in its own process group and waits a bounded time for a client
  window. If none appears, it stops the group before reporting a possible
  real-desktop escape and suggests `--window-timeout` for slow first builds.
  `pickforge-lab desktop env` prints the same recipe for parent shells, with
  JSON output available.
- Desktop screenshots now include the client-window count and warn when it is
  zero instead of leaving a black frame unexplained. Without `xdotool`, capture
  still succeeds and warns that the count is unavailable without raising the
  zero-window escape warning.

## Flutter integration alpha

- `pickforge doctor` provides read-only readiness diagnostics for a Flutter
  project, local Flutter and Dart tools, and supported agent harnesses. Human
  and JSON reports include the resolved project and external state paths.
- `pickforge init` provides dry-run planning and transactional, backed-up,
  idempotent config updates for Claude Code, Codex, and Pi. It configures the
  owned `pickforge-dart` server as `dart mcp-server` and installs the portable
  `pickforge-flutter` workflow outside the project.
- `--mobile-integration-alpha` is now visible. It defaults on when the Rust
  crate version has a prerelease tag, including `0.4.0-alpha.1`; stable builds
  continue to require the flag while it exists.
- Flag lifecycle: keep the flag through this first enabled release, verify the
  alpha on real devices, then remove the flag after the enabled release is
  confirmed. The Flutter integration becomes the normal path at removal.
- `pickforge evidence record` validates one bounded JSON envelope, checks the
  owned Flutter init receipt, redacts text secrets, copies validated
  screenshots into an external private run directory, and writes canonical
  `evidence.json` plus `report.md`. Evidence schema v3 supports up to 32 ordered
  intermediate steps between `before` and `after`, with optional check-to-step
  references. It retains v2 source dimensions and bounded PNG previews for
  oversized screenshots, links the full capture, deduplicates artifacts across
  steps, and counts previews toward the total budget.
- The README documents the proven loop in order: doctor, init, isolated
  `pickforge-lab desktop exec`, inspect, click, source edit, hot reload, visual
  verification, and evidence recording.
- An opt-in live Rust end-to-end test creates a real Flutter project and drives
  `doctor`, `init`, a real `dart mcp-server` handshake, and `evidence record`.
  It is gated on `PICKFORGE_LIVE_FLUTTER=1` and skips without `flutter` or
  `dart`, so CI and the default suite remain hermetic.

## Installation and release

- `install.sh` installs `pickforge@next`, then downloads the matching Rust
  `pickforge` binary into the same global bin directory. It verifies the
  release-provided SHA-256 before replacing the binary.
- Rust release assets are `pickforge-linux-x86_64` and
  `pickforge-macos-arm64`, each with a same-named `.sha256` file.
- The release workflow builds and strips both Rust binaries, keeps npm OIDC
  trusted publishing, uses the `next` dist-tag only for prerelease versions,
  and attaches the binaries and checksums to the GitHub release.
- The Cargo workspace has Linux and Windows CI jobs for formatting, clippy with
  warnings denied, and tests. The Rust binary is not published through npm.
- Vulnerable `fast-uri` and `hono` overrides were raised, along with lockfile
  resolutions for both `brace-expansion` majors, `fast-uri`, `hono`,
  `ip-address`, and `nanoid`.

## Validation

- Local Bun install, typecheck, lint, test, and build pass. The full test run
  has 1,169 passing and four skipped tests, including real Xvfb desktop and
  headed Chrome coverage.
- `cargo fmt --check`,
  `cargo clippy --workspace --all-targets --locked -- -D warnings`, and
  `cargo test -p pickforge-cli` pass with 86 tests covering readiness,
  transactions, receipts, Flutter integration, evidence schema v3, bounded
  previews, redaction, and concurrent first use.
- The pinned OSV Scanner v2.3.8 image reports no unfiltered advisories.
- The opt-in live end-to-end test has passed on Linux with Flutter 3.41.6. It
  covers project creation, doctor, idempotent init for Claude Code, Codex, and
  Pi, a real Dart MCP handshake, evidence recording, redaction, and home
  isolation.
- Manual smoke runs of `pickforge doctor` and `pickforge doctor --json` passed
  against temporary fake Flutter and non-Flutter projects with an isolated
  `PATH` and `PICKFORGE_HOME`.

## Known limits

- Desktop, browser, and Android lab sessions remain Linux-only. The macOS arm64
  Rust binary supports the durable `doctor`, `init`, and evidence flow but does
  not make the TypeScript lab cross-platform.
- Windows has no Rust release artifact in this alpha.
- The mobile integration flag is temporary by policy and is not the permanent
  user interface.
- The macOS opt-in live Flutter and MCP path has not been tested.
- The live end-to-end test is not run in CI; it stays a local, opt-in check.
- No npm publish, repository rename, package deprecation, or other external
  runbook step was executed while preparing these notes.

## Release blockers

- None known.
