# Pickforge 0.4.0-alpha.2

Draft release notes for the second Pickforge prerelease. `0.4.0-alpha.1` is
published; its notes live on the GitHub release. Use this file as the next
release description, then reset it after that release is published.

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

## Android lab start hardening

- The live Android integration test could fail in two seconds with "exited
  before finishing boot" and then delete the emulator log it pointed at (#93).
  Root cause: `avdmanager` honours `XDG_CONFIG_HOME` and wrote the freshly
  created AVD to `~/.config/.android/avd`, while the emulator only searches
  `$ANDROID_AVD_HOME`, `$ANDROID_SDK_HOME/avd` and `$HOME/.android/avd`.
  Pickforge now resolves one AVD directory and passes it as `ANDROID_AVD_HOME`
  to `avdmanager`, `emulator -list-avds`, and the emulator, verifies the ini
  landed there after creation, and fails before spawning when the requested AVD
  is not where the emulator will look.
- Start failures are diagnosed distinctly: `avd-missing`, `avd-in-use` (a live
  emulator pid holds the AVD's lock; `--read-only` shares it), `port-collision`,
  `snapshot`, `kvm`, `process-exit`, `boot-timeout` with the adb device state
  (`missing`, `offline`, `unauthorized`, `device`), and `aborted`. Every message
  carries the kind, a hint, the emulator log path, and the log's last lines, and
  the failed session record keeps the same diagnosis under
  `meta.androidStartFailure`, so a deleted temp directory no longer erases the
  cause.
- Console ports are probed with a loopback bind on the console and adb ports
  before launch, on top of the adb listing and the per-home reservation
  registry, so sessions from different Pickforge homes do not race for the same
  pair. An emulator that still reports a collision is retried on a fresh pair,
  at most twice, with each attempt reported as progress.
- New `--cold-boot` (`-no-snapshot-load`) and `--read-only` (`-read-only`)
  options on `session create` and `android start`, and `coldBoot`/`readOnly` on
  the `session_create` and `android_start` MCP tools. Sessions report
  `bootMode` (`warm`/`cold`/`unknown`) and `readOnly`. The emulator shares an
  AVD only among read-only instances; a running writable instance is reported
  as `avd-in-use` before spawning, for read-only requests too.
- `android launch-app` / `android_launch_app` no longer fire a `monkey` event
  and report success regardless. They resolve the package's launcher activity
  (`cmd package resolve-activity`), start it with `am start -W`, and confirm a
  process for the package is alive, returning the component, pid, and launch
  state. A launch the device drops at startup is now a distinct error. The real
  APK pass exposed this: the first launch after install on a freshly restored
  snapshot returned success while the launcher stayed on screen.
- Graceful emulator shutdown now waits up to 30 seconds after `adb emu kill`
  before signalling, so a snapshot save is not interrupted.
- The live integration test preserves its temp root (emulator logs and session
  records) on failure, copies them to `PICKFORGE_LIVE_ANDROID_ARTIFACTS` when
  set, boots an existing AVD named by `PICKFORGE_LIVE_ANDROID_AVD` or creates a
  throwaway one under its temp root instead of the real AVD home, optionally
  installs and launches a real APK, and proves a cold-boot session and a
  concurrent read-only session from a second home do not collide.

## Validation

- Updated during release preparation.

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
