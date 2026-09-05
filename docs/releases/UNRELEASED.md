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
