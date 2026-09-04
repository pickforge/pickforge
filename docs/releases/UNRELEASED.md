# Unreleased

Working draft for the next PickLab release. Use this to polish the generated
GitHub release description, then reset it after the release is published.

## User-facing changes

- Desktop commands now share one isolated X11 environment that points
  `WAYLAND_DISPLAY` at the non-existent `picklab-no-wayland` socket, removes
  other inherited `WAYLAND_*` variables, and sets Electron, GLFW, GTK, Qt,
  SDL, winit, and session backend hints. The poison value prevents libwayland
  from falling back to the user's default `wayland-0` socket when the variable
  is unset.
  New `picklab desktop exec` (also available as MCP `desktop_exec`) starts a
  command in its own process group. If no client window appears within a
  bounded wait, it stops the group before reporting a possible real-desktop
  escape and suggests `--window-timeout` for slow first builds. `picklab desktop env`
  prints the same recipe for parent shells, with JSON output available.
  Desktop screenshots now include the client-window count and warn when it is
  zero instead of leaving a black frame unexplained. Without `xdotool`, capture
  still succeeds and warns that the count is unavailable without raising the
  zero-window escape warning.
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
- Added an opt-in live Rust end-to-end test
  (`crates/pickforge-cli/tests/live_flutter.rs`) that creates a real Flutter
  project and drives `doctor`, `init`, a real `dart mcp-server` handshake and
  `evidence record` against it. It is gated on `PICKFORGE_LIVE_FLUTTER=1` and
  skips without `flutter`/`dart`, so CI and the default suite are unchanged.
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
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D
  warnings`, and `cargo test --workspace --locked` pass with 84 tests covering
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
- The opt-in live end-to-end test (`PICKFORGE_LIVE_FLUTTER=1 cargo test -p
  pickforge-cli --test live_flutter`) passes on Linux against a project made by
  the real Flutter SDK (`flutter create --offline`, Flutter 3.41.6): doctor
  reports the project ready as Flutter, `init` plans and applies Claude
  Code/Codex/Pi configs and skills and is idempotent on a second run, a real
  `dart mcp-server` completes an initialize and tools/list handshake, and
  evidence is recorded outside the project with the planted secret redacted and
  the real home untouched. Without `PICKFORGE_LIVE_FLUTTER=1`, or without
  `flutter`/`dart` on PATH, the test skips, so the default suite stays hermetic.
- Manual smoke runs of `pickforge doctor` and `pickforge doctor --json`
  against temporary fake Flutter and non-Flutter projects with an isolated
  `PATH`/`PICKFORGE_HOME`.

### Not tested yet

- macOS for the Rust binary, including the opt-in live Flutter/MCP path.
- No packaging, installer, or distribution path for `pickforge` yet.
- The live end-to-end test is not run in CI; it stays a local, opt-in check.

### Release blockers

- None known.
