# Pickforge 0.4.0-alpha.2

The second Pickforge prerelease makes Flutter integration the normal setup path, hardens desktop and run isolation, improves Android startup diagnostics, and gates releases on artifacts that were actually installed and executed.

## Flutter setup and shared project state

- `pickforge init` now always installs the Flutter integration for Claude Code, Codex, and Pi. The temporary `--mobile-integration-alpha` switch is gone. Dart must be on `PATH`, and a missing Dart executable fails before any config is written. (#91)
- The Rust integration CLI and TypeScript lab now have one versioned ownership contract when they share a `PICKFORGE_HOME`. `project.json` belongs to the integration CLI, `runs/` is shared, and unknown entries fail closed. Existing alpha state is adopted in place without moving or deleting it. (#109)
- First use is atomic. Both tools reject symlinked project state, unsafe `runs/`, malformed or unsupported layout markers, non-regular markers, and unowned entries before writing. `init --dry-run` previews the same refusals without changing state. (#109)
- New state directories are owner-only. A partial `init` reports any layout marker it left behind instead of claiming a complete rollback. (#109)
- Legacy `PICKLAB_*` environment variables remain supported, with a deprecation warning, throughout the 0.4 release train.

## Desktop, browser, and process isolation

- Desktop sessions get a private `XDG_RUNTIME_DIR`, fail-closed D-Bus addresses, and X11-only toolkit hints. x11vnc uses the same isolated runtime rather than inheriting the host Wayland session. (#92)
- Apps launched by a desktop session are contained with a private cgroup v2 scope when available, or a per-session random process marker as the fallback. Daemonised and double-forked descendants are included in teardown. Cleanup verifies process identity, avoids the caller and unrelated processes, and reports success only after the session is empty. This is process containment, not a hostile-code sandbox. (#92)
- Xvfb and x11vnc teardown now signals owned process groups and confirms they are gone. Display allocation uses a cross-process reservation and determines liveness from the lock owner and Unix socket instead of stale pathnames. (#92, #103)
- Headed Chrome can start from deeply nested isolated homes. A short private alias avoids Chrome's Unix-socket path limit while its profile and temporary files remain in the session directory. The alias is ownership-checked and removed during teardown. (#108)
- A desktop integration test that previously wrote screenshot-run state under the developer's real home now uses its isolated test home. (#108)
- Chrome readiness gets a bounded cold-start budget and preserves a redacted diagnostic tail when startup fails. The release tests no longer hide failures behind retries. (#90, #100)

## Run storage

- Run creation and sensitive writes now enforce the same symlink and realpath trust boundary as reads. Unsafe project-local, home, and custom roots are refused without migration, replacement, or deletion. (#91)
- Manifests, evidence journals, active-run pointers, reports, screenshots, and other artifacts are written through the verified run-directory descriptor. Swapping an ancestor after verification cannot redirect those writes. (#91)
- Screenshot capture uses a private staging directory before publishing into the verified run. Traversing artifact names and out-of-root run adoption are rejected. (#91)

## Android

- Android startup now reports distinct, durable failures for a missing or in-use AVD, port collision, snapshot or KVM failure, early process exit, boot timeout, and cancellation. The failed session record keeps the diagnosis and bounded emulator-log tail. (#101)
- AVD creation and launch use one resolved AVD home. Console and adb ports are probed before launch, collisions get at most two fresh-pair retries, and writable/read-only AVD sharing follows an explicit fail-closed policy. (#101)
- `android launch-app` resolves the launcher activity, waits for `am start -W`, and confirms the package process instead of treating a sent launch event as success. Graceful emulator shutdown allows time for snapshot saving. (#101)
- `--cold-boot` and `--read-only` are available on Android session creation and start commands, with matching MCP fields. (#101)
- `android install-apk` and `android launch-app` add optional `--wait-ready <seconds>` support, exposed as `waitReadySeconds` over MCP. It waits within the caller's bound for 30 seconds without a guest lowmemorykiller event, reports progress, and fails before install or launch if the guest never becomes ready. The default remains no wait, and Pickforge does not retry an app launch the guest drops. (#107)
- Readiness deadline tests now assert the fail-closed contract under coverage load rather than an incidental final probe value. (#113)

## MCP

- The Pickforge MCP server now uses the stable split Model Context Protocol SDK v2 packages and the dual-era stdio transport. Existing tools, prompts, resources, current client protocol revisions, progress, and elicitation behavior remain available. (#100)
- Stdio shuts down cleanly on EOF, transport close, `SIGINT`, `SIGTERM`, and `SIGHUP`. Malformed-input diagnostics are bounded, redacted, and rate-limited with recovery after one minute. (#100)

## Release safety

- The release workflow packs one npm tarball and builds each Rust asset once, then gates publishing on the same downloaded bytes passing clean Linux and Apple silicon candidate smokes. The smokes verify checksums, all three command versions, Flutter detection, `doctor`, dry-run isolation, `init` apply and idempotency, real Dart and Pickforge MCP handshakes, evidence redaction, an unchanged project tree, and an unchanged bounded set of real-home targets. (#99)
- The macOS arm64 asset is stripped, re-signed ad hoc, signature-checked, and executed before release. It is not Developer ID signed or notarized. The installer verifies the published SHA-256 checksum. See `docs/releases/SIGNING.md`. (#99)
- Only the publish job receives GitHub write and npm OIDC permissions. A manual run publishes only when its confirmation exactly matches `v0.4.0-alpha.2` on `main`; otherwise it is read-only. A published GitHub release cannot be overwritten by a rerun. (#99)
- Release versions are checked as semver across every workspace package, the root package, Cargo, and the tag before they enter artifact names or workflow outputs. Candidate-smoke path filters cover every package bundled into the CLI. (#99)
- Display teardown and Android readiness regressions found under loaded CI are pinned by deterministic or load-safe tests rather than rerun masking. (#90, #103, #113)

## Telemetry and source-map limit

Fatal-error telemetry behavior is unchanged in this prerelease. The TypeScript CLI and MCP server send redacted fatal error details to Sentry by default; set `PICKFORGE_TELEMETRY=0`, `false`, or `off` to disable it. The opt-in telemetry contract planned for stable remains tracked in #98.

The release workflow uploads the JavaScript and source maps from the checksum-verified npm tarball without modifying it. That proves the uploaded maps describe the shipped bytes, but source-map resolution for absolute installed stack-frame paths without debug IDs has not been demonstrated. The upload also currently occurs before the already-published-version check on a confirmed rerun. Follow-up: inject Sentry debug IDs before `npm pack` so the smoked and published artifact is identical, and run the upload only when that npm version will be published. Until then, resolved Sentry stack traces are not a release claim or gate.

## Known limits

- The TypeScript lab is Linux-only. The macOS candidate gate covers the Rust integration CLI, not desktop, browser, or Android lab support.
- Desktop containment owns processes started in a session; it is not a security sandbox for hostile code.
- Descriptor-bound run writes use Linux `/proc/self/fd` capability paths. On unsupported platforms the lab fails closed instead of falling back to pathname writes.
- The Android readiness wait is opt-in and does not provision or modify existing AVDs. A low-memory guest can still fail to become ready within the selected bound.
- Candidate artifact smokes do not cover Android or interactive desktop behavior. Those require separate isolated device evidence.
