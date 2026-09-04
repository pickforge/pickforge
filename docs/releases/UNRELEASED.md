# Pickforge 0.4.0-alpha.2

The second Pickforge prerelease: the Flutter integration becomes the normal
`pickforge init` path, run storage is hardened, and releases are now gated on
candidate artifacts that were actually executed.

## Flutter integration is the normal path

- `pickforge init` always configures the Flutter integration: the owned
  `pickforge-dart` server as `dart mcp-server` and the portable
  `pickforge-flutter` workflow for Claude Code, Codex, and Pi. It requires
  `dart` on PATH and fails before writing anything otherwise.
- The temporary `--mobile-integration-alpha` flag is removed, along with its
  prerelease-only default. Stable and prerelease builds behave the same.
- Receipt remediation messages now point at plain `pickforge init`.
- Legacy `PICKLAB_*` environment variables keep working with a deprecation
  warning through the 0.4 release train.

## Run storage hardening

- Run directories are now created through the same lstat/realpath trust
  boundary the run catalog uses when reading (#54). In `project-local` mode a
  symlinked `.picklab` or `.picklab/runs`, whether committed in the repository
  or planted later, is refused with a clear error instead of redirecting
  screenshots and manifests. `home` and `custom` modes verify their
  `projects/<id>/runs` and `runs` components the same way.
- Sensitive run writes are now bound to the verified *directory*, not to its
  pathname. Each directory is opened once with `O_DIRECTORY|O_NOFOLLOW` and
  verified through that descriptor, and the manifest, the evidence journal (and
  its lock and truncation sentinel), the session's active-run pointer, HTML
  report, and screenshots and other run artifacts are all written through the
  same descriptor. Swapping an ancestor after verification can no longer redirect
  those writes: they land in the verified directory or fail with a named error.
- Screenshots are captured into a process-private staging directory and
  published into the run through the descriptor held across the capture, so an
  external capture tool can no longer be pointed outside the run directory by a
  swap while it runs. Artifact names and subdirectories are validated before
  staging starts, so traversal cannot write outside that private directory.
- Run adoption stays internal: `openRun` is no longer exported. Adoption goes
  through one helper that requires a single-component run id naming a real
  directory directly under the verified root, and a manifest that describes
  that run, so an out-of-root or traversing id is refused.
- Nothing is migrated, replaced, or deleted when an unsafe entry is found; the
  offending path is named in the error.

## Release gates

- Publishing now depends on two smokes that run the exact candidate artifacts
  this release ships. The npm tarball is packed once and published unchanged;
  the Rust assets are built once and executed before they are attached.
- The Linux gate installs only the candidate tarball and the candidate
  `pickforge-linux-x86_64` asset into a clean Flutter container, then checks
  all three command versions, Flutter project detection, `doctor`, `init`
  dry-run isolation, `init` idempotency, a real Dart MCP handshake, evidence
  recording, an unchanged project tree, and an untouched real home.
- The macOS gate runs on Apple silicon, verifies the asset checksum and its
  ad-hoc signature, executes the binary, and repeats the same Flutter workflow
  with an isolated `HOME` and `PICKFORGE_HOME`.
- The macOS asset is re-signed after `strip`. Stripping invalidates the ad-hoc
  signature that Apple silicon requires, so earlier assets could fail to run.
- A manual dispatch of the release workflow is a dry run unless the exact
  release tag is typed in its `confirm` input; only the publish job holds any
  write or OIDC permission.
- macOS signing and notarization policy: `docs/releases/SIGNING.md`. Assets are
  ad-hoc signed and not notarized, verified by checksum and npm provenance.

## Known limits

- Descriptor-bound writes rely on Linux `/proc/self/fd` capability paths, since
  Node exposes no `openat`/`mkdirat` family. The TypeScript lab is Linux-only;
  on any other platform run-storage writes now fail closed with a clear error
  instead of falling back to pathname writes.
- The binding covers run-storage writes and report rendering. General reads
  (run listing and catalog manifest/journal reads) and retention pruning still
  apply the lstat/realpath trust boundary by pathname and are not
  descriptor-bound.
- A swap performed *before* an operation opens its directory is not silently
  tolerated: the open fails verification and the operation reports the unsafe
  path. Only the redirection of an already verified write is prevented.
- The macOS gate covers the Rust CLI only. The TypeScript lab stays Linux-only
  and is not installed or exercised on macOS.
- The clean container has no agent harness installed, so `doctor` reports that
  one readiness gap by design. The gate requires every other check to pass and
  requires `doctor` to exit non-zero rather than claim readiness.
- Neither gate covers the Android lab or a real desktop session; those stay
  covered by the device pass and the Android live tests.
