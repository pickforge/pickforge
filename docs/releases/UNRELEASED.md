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

- Headed Chrome now reaches its session-confined temporary directory through a
  short private alias under `/tmp/pickforge-browser-<uid>/`, avoiding its fixed
  Unix-socket path limit when `PICKFORGE_HOME` is deeply nested. Before this,
  a browser session under a long home aborted at startup with Chrome's
  `Socket path too long: .../tmp/com.google.Chrome.*/SingletonSocket`. The
  socket and Chrome's temp files still live inside the session directory; the
  alias root must be a real directory owned by the invoking user, and destroy
  and failed-start cleanup verify and remove the alias with the rest of the
  ephemeral runtime.
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

## Android lab start hardening

- The live Android integration test could fail in two seconds with "exited
  before finishing boot" and then delete the emulator log it pointed at (#93).
  Root cause: `avdmanager` honours `XDG_CONFIG_HOME` and wrote the freshly
  created AVD to `~/.config/.android/avd`, while the emulator resolves
  `$ANDROID_AVD_HOME`, then `$ANDROID_USER_HOME/avd`,
  `$ANDROID_EMULATOR_HOME/avd`, `$ANDROID_PREFS_ROOT/.android/avd`,
  `$ANDROID_SDK_HOME/.android/avd`, and finally `$HOME/.android/avd`.
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
  `bootMode` (`warm`/`cold`/`unknown`) and `readOnly`. Sharing one AVD is
  governed by a Pickforge policy, not by what the emulator happens to admit:
  Pickforge shares an AVD only among read-only sessions and refuses to start
  any session, writable or read-only, while a writable emulator holds the
  AVD's lock (`avd-in-use`, reported before spawning). A writable instance
  keeps rewriting the disk overlays and the quickboot snapshot that a
  read-only instance maps, so the refusal fails closed on purpose.
- A `sys.boot_completed` probe that cannot run at all (adb missing or not
  executable mid-boot) no longer surfaces as a bare spawn error: the wait
  keeps polling and ends in the typed `boot-timeout` diagnosis with the adb
  state, the emulator log path, the log tail, and the probe's own error.
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
- Known limit (#105): on a 2 GB Play-Store image the first launch of a freshly
  sideloaded APK right after a quickboot restore can be killed by the guest's
  lowmemorykiller while `am start -W` reports it drawn. Pickforge reports this
  as a distinct launch error and does not retry. RAM and settled-snapshot
  provisioning for new `pickforge-avd` instances is #106.
- `android install-apk` / `android launch-app` and the matching MCP tools accept
  an opt-in `--wait-ready <seconds>` / `waitReadySeconds` (`0` or omitted: no
  wait) that waits until guest lowmemorykiller has been quiet for 30 seconds
  (`logcat -s lowmemorykiller:I` against the guest clock), reports each probe as
  progress, fails with `guest-not-ready` or `aborted` without starting the
  action if the bound is hit or the MCP request is cancelled, and treats an
  unreadable guest clock or logcat as not quiet. This avoids launching into a
  transient storm; it is not a retry, and a storm that never quiets still fails
  closed.

## MCP SDK v2

- The lab MCP server now uses the stable split Model Context Protocol SDK v2
  packages. Its documented dual-era stdio entrypoint keeps the protocol
  revisions used by current Claude Code, Codex, and Pi clients and opts into
  the `2026-07-28` revision without changing the server's tools, prompts, or
  resources. Tasks remain out of scope.
- MCP stdio now exits cleanly on EOF, transport close, `SIGINT`, `SIGTERM`, and
  `SIGHUP`. Malformed-input diagnostics stay on stderr, redact secrets, bound
  each message, and resume after a one-minute rate-limit window. Legacy user
  elicitation keeps its previous 60-second response window.

## Browser readiness probing

- The DevTools readiness probe now gets a one-second budget (bounded by the
  time the overall wait has left) instead of the 100 ms poll interval. A cold
  endpoint on a loaded host no longer looks unready on every poll, and the
  browser wait no longer resets the DevTools connection several times a second
  while Chrome is coming up.

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
- Both gates verify a checksum before they use an artifact: the Rust asset, and
  now the npm tarball where it is installed, re-checked after the install so
  the bytes that were exercised are provably the packed candidate.
- A manual dispatch of the release workflow is a dry run unless the exact
  release tag is typed in its `confirm` input; only the publish job holds any
  write or OIDC permission.
- The release version must be semver, and a release tag must be `v<semver>`,
  before either reaches a tarball name, a container environment, or a workflow
  output.
- The publish job refuses to touch a GitHub release that is no longer a draft,
  so a re-run or a second dispatch cannot replace published assets. Sourcemaps
  are uploaded from inside the verified tarball, unmodified, so what Sentry
  holds describes the bytes npm received.
- The Linux gate's container is pinned by image digest, and nothing is
  installed into it: it already ships the tools the smoke needs, and its
  Node.js is the runner's own, mounted read-only, instead of a remote setup
  script piped into a root shell.
- The pull-request candidate smoke now runs for every input that can change the
  packed bytes, including the lockfile and every workspace package: the CLI
  bundles them all.
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
