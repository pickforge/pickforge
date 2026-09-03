# Unreleased

Working draft for the next Pickforge release. Use this to polish the generated
GitHub release description, then reset it after the release is published.

## PickLab is now Pickforge

- The npm package is now `pickforge` at version `0.4.0-alpha.1`.
- The TypeScript commands are now `pickforge-lab` and `pickforge-mcp`.
- Agent config uses `pickforge-lab`. Linking replaces an owned legacy
  `picklab` MCP entry in the same config update.
- `PICKFORGE_*` environment variables fall back to `PICKLAB_*` for one
  release and print one deprecation warning to stderr per process.
- New TypeScript state is written under `~/.pickforge/lab/`, or
  `PICKFORGE_HOME`. State under `~/.pickforge/picklab/` and `~/.picklab/`
  remains readable in place. Nothing is silently migrated or deleted.
- After installing `pickforge`, remove the old package with
  `npm uninstall -g @pickforge/picklab` or
  `bun remove -g @pickforge/picklab`.

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
- Experimental, unpublished `pickforge evidence record` accepts a bounded JSON
  document from stdin or `--input`, verifies the existing Flutter init receipt,
  copies validated screenshots byte-for-byte into an external private run directory,
  and writes canonical `evidence.json` plus Markdown `report.md`. Evidence schema v2
  records source dimensions and adds a 1568px bounded PNG preview for oversized
  screenshots; reports use the preview while preserving the original artifact. Text
  secrets are redacted, Markdown is escaped without changing canonical JSON strings,
  and the command
  accepts a valid owned Flutter receipt v1 or newer and fails closed when it is
  missing or belongs elsewhere; the Flutter integration pack itself is now v2.
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
## Internal/release changes

- Added an unpublished, default-off Flutter integration alpha for `pickforge
  init`. The hidden `--mobile-integration-alpha` flag configures the owned
  `pickforge-dart` MCP server for selected harnesses and installs one portable
  Flutter workflow skill into Claude's skill root and/or the shared Codex/Pi
  agent-skill root. It requires discoverable `dart` but never executes it; the
  default base pack and every release surface remain unchanged.
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

- Local Bun validation: install, typecheck, lint, and build pass. The full test
  run has 1,141 passing and four skipped tests. Four live desktop/browser tests
  fail on this host because `xterm` is absent and its Chromium exits during
  startup; CI installs `xterm` and uses its documented Chrome runner setting.
- The pinned OSV Scanner v2.3.8 image reports no unfiltered advisories.
- `cargo check --workspace` and `cargo test -p pickforge-cli` pass with 83 tests
  covering
  project/framework detection, tool and harness discovery, state and project-id
  boundaries, adapter preservation/refusal, transaction rollback and drift,
  dry-run, receipt ownership, file modes, idempotency, Git-tree cleanliness,
  JSON/text safety, CLI exits, owned Flutter MCP configuration, per-harness
  arguments, workflow targeting/deduplication, alpha tool preconditions, evidence
  storage/redaction, bounded screenshot previews, byte-identical source retention,
  preview deduplication and budgeting, receipt compatibility, and concurrent first
  use. Exact local validation also includes `cargo check --workspace --all-targets --locked
  --target x86_64-pc-windows-msvc` and target-specific clippy with `-D warnings`.
  Windows-native tests run in the CI matrix.
- Manual smoke runs of `pickforge doctor` and `pickforge doctor --json`
  against temporary fake Flutter and non-Flutter projects with an isolated
  `PATH`/`PICKFORGE_HOME`.

### Not tested yet

- macOS for the Rust binary.
- No npm publish, repository rename, package deprecation, or other external
  runbook step was executed.

### Release blockers

- None known.
