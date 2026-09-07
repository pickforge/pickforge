# Pickforge 0.4.0-beta.1

The first Pickforge beta ships the 0.4.0-alpha.2 code unchanged, with the product proof the beta gate required: real macOS, clean-container Linux, Android emulator, and three-harness validation of the published artifacts.

## Changes

- No functional changes since 0.4.0-alpha.2. Version strings, agent instruction docs, and release notes are the only differences.
- The 0.4.0-alpha.2 notes remain the reference for what this release train contains: Flutter integration as the normal `pickforge init` path, desktop and run isolation hardening, Android startup diagnostics, MCP SDK v2, and artifact-gated releases.

## Validation

- The 0.4.0-alpha.2 artifacts, built from the same source as this beta apart from version strings and documentation, passed the evidence gates recorded under `~/Projects/Boards/pickforge/0.4-release/published-alpha2/` and linked from #89: fresh isolated Linux install with matching versions, npm trusted-publishing provenance, real Android emulator journey with independent visual review, real Claude Code, Codex, and Pi integrations with actual model calls, legacy 0.3.0 state preservation, and the Apple silicon Rust CLI, Dart MCP, and Flutter GUI pass with zero real-home writes.
- This tag's own release workflow runs the clean Linux container and Apple silicon candidate smokes on the exact artifacts before publishing.

## Known limits

- The TypeScript lab is Linux-only. macOS support covers the Rust integration CLI (`doctor`, `init`, evidence) and was proven with a disposable Flutter fixture, not the desktop, browser, or Android lab.
- Desktop containment owns processes started in a session; it is not a security sandbox for hostile code.
- Fatal-error telemetry is still on by default and redacted; the opt-in contract for stable is tracked in #98.
- The macOS asset is ad-hoc signed and not notarized; see `docs/releases/SIGNING.md`.
- Beta.1 is a prerelease on the npm `next` tag. `latest` stays on the previous stable line until 0.4.0.
