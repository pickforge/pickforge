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
- Experimental, unpublished `pickforge init` foundation adds read-only planning,
  dry-run/JSON reports, deterministic external project receipts, and
  transactional adapter config writes for Claude Code, Codex, and Pi. The base
  pack is intentionally empty in this slice, so normal init only writes the
  receipt; real Flutter integration content follows separately. Pi MCP config
  requires `pi-mcp-adapter` because core Pi has no built-in MCP support.
  Individual files use atomic replacement and in-process failures roll back
  completed writes while retaining backups. There is deliberately no durable
  journal or daemon: a process interruption can leave a partially applied set;
  owned temporary/backup artifacts are recognized so a later rerun converges it.
- Added a default-off Flutter integration alpha for `pickforge init`. The hidden
  `--mobile-integration-alpha` flag configures the owned `pickforge-dart` MCP
  server for selected harnesses and installs one portable Flutter workflow skill
  into Claude's skill root and/or the shared Codex/Pi agent-skill root. It
  requires discoverable `dart` but never executes it; the default base pack is
  unchanged.

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
  warnings`, and `cargo test --workspace --locked` pass with 56 tests covering
  project/framework detection, tool and harness discovery, state and project-id
  boundaries, adapter preservation/refusal, transaction rollback and drift,
  dry-run, receipt ownership, file modes, idempotency, Git-tree cleanliness,
  JSON/text safety, CLI exits, owned Flutter MCP configuration, per-harness
  arguments, workflow targeting/deduplication, and alpha tool preconditions. The
  Windows MSVC target also passes cross-target check and clippy; Windows-native
  tests run in the CI matrix.
- Manual smoke runs of `pickforge doctor` and `pickforge doctor --json`
  against temporary fake Flutter and non-Flutter projects with an isolated
  `PATH`/`PICKFORGE_HOME`.

### Not tested yet

- macOS for the Rust binary.
- No packaging, installer, or distribution path for `pickforge` yet.

### Release blockers

- None known.
