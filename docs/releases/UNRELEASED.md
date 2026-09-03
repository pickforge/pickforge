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
- `pickforge evidence record` validates one bounded before/after JSON envelope,
  checks the owned Flutter init receipt, redacts text secrets, copies validated
  screenshots into an external private run directory, and writes canonical
  `evidence.json` plus `report.md`. Oversized screenshots retain the original
  and add a bounded PNG preview.
- The README now documents the proven loop in order: doctor, init, isolated
  `pickforge-lab desktop exec`, inspect, click, source edit, hot reload, visual
  verification, and evidence recording.

## Installation and release

- `install.sh` installs `pickforge@next`, then downloads the matching Rust
  `pickforge` binary into the same global bin directory. It verifies the
  release-provided SHA-256 before replacing the binary.
- Rust release assets are `pickforge-linux-x86_64` and
  `pickforge-macos-arm64`, each with a same-named `.sha256` file.
- The release workflow builds and strips both Rust binaries, keeps npm OIDC
  trusted publishing, uses the `next` dist-tag only for prerelease versions,
  and attaches the binaries and checksums to the GitHub release.

## Known limits

- Desktop, browser, and Android lab sessions remain Linux-only. The macOS arm64
  Rust binary supports the durable `doctor`, `init`, and evidence flow but does
  not make the TypeScript lab cross-platform.
- Windows has no Rust release artifact in this alpha.
- The mobile integration flag is temporary by policy and is not the permanent
  user interface.
