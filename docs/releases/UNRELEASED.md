# Unreleased

Working draft for the next PickLab release. Use this to polish the generated
GitHub release description, then reset it after the release is published.

## User-facing changes

- Experimental `pickforge doctor` (new Rust binary, not yet released or
  published): read-only readiness diagnostics for a Flutter project —
  `pickforge doctor [--project-dir <path>] [--json]`. Reports the resolved
  project path/id/state directory plus checks for a Flutter `pubspec.yaml`,
  `flutter`/`dart` on `PATH`, and at least one agent harness (`claude`,
  `codex`, `pi`). Exits 1 when not ready. It never writes, never runs the
  tools it finds, and makes no network calls. `PICKFORGE_HOME` (absolute
  only) overrides the state root, which defaults to
  `~/.pickforge/pickforge`. Project paths that cannot satisfy the shared
  UTF-8 project-id contract fail closed without resolving a state directory.

## Internal/release changes

- Raised the vulnerable `fast-uri` and `hono` overrides, plus lockfile
  resolutions for both `brace-expansion` majors, `fast-uri`, `hono`,
  `ip-address`, and `nanoid`, to patched releases.
- Added a Cargo workspace (`crates/pickforge-cli`, `Cargo.lock` committed) and
  a `rust` CI matrix for `ubuntu-latest` and `windows-latest` (fmt, clippy `-D
  warnings`, tests). The Bun job, its pinned Bun version, and all release
  artifacts are unchanged; the Rust binary is not part of any release pipeline
  yet.

## Validation

### Tested

- Pinned Bun 1.3.12 CI: frozen install, typecheck, lint, 1,133 tests pass,
  one skips, coverage passes at 82.48% lines, and build passes.
- The pinned OSV Scanner v2.3.8 image reports no unfiltered advisories.
- `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D
  warnings`, `cargo test --workspace --locked` (29 tests: project/framework
  detection, tool and harness discovery on a fake `PATH`, `PICKFORGE_HOME`
  handling, project-id parity and path boundary cases, JSON/text safety, and CLI
  exit codes). The Windows target also passes cross-target check and clippy;
  Windows-native tests run in the CI matrix.
- Manual smoke runs of `pickforge doctor` and `pickforge doctor --json`
  against temporary fake Flutter and non-Flutter projects with an isolated
  `PATH`/`PICKFORGE_HOME`.

### Not tested yet

- macOS for the Rust binary.
- No packaging, installer, or distribution path for `pickforge` yet.

### Release blockers

- None known.
