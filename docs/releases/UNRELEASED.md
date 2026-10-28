# Pickforge 0.7.1

Pickforge 0.7.1 gives agents a browser that you can watch and take over.
Browser sessions can keep logins in named profiles. On graphical Linux hosts,
a small native viewer shows a session as a live picture in picture. You can
take control in the viewer, and an agent can ask you for help, for example
with a login. Evidence reports now show where the agent pointed, and one
shareable HTML file can hold a whole run. Desktop typing, process cleanup and
session teardown are also more reliable.

0.7.1 is the first published release of this work. The `v0.7.0` tag exists,
but its release run stopped at the Rust gates before publishing, because that
job lacked the viewer's display test dependencies. Nothing from 0.7.0 reached
npm or GitHub releases. (#398)

## Changes

- `watch` and automatic session viewing prefer the matching native
  `pickforge-viewer` binary on graphical Linux hosts. The native path reads the
  verified lab display without VNC, a bridge, or Chromium. It opens a
  thumbnail with expand, fullscreen, collapse, and close controls. Hyprland Lua
  placement keeps it pinned without initial focus. Session destruction stops
  the detached host and viewer by process identity. Linux x86_64 release assets
  and the installer include the viewer. npm-only installs and mismatched
  binaries keep the noVNC fallback. The external VNC client remains the control
  fallback. (#340)
- The native viewer can hand the session to a human. Its Take control button
  pauses agent activity, and Return control or closing the window gives it
  back. `pickforge-lab watch --control` starts the native viewer with control.
  While a human already holds control, it fails and leaves the open viewer
  running. During control, agent desktop input, launch, exec, screenshots,
  waits and the DevTools relay fail with a busy error, and a takeover also
  stops a wait capture in flight. Returning control releases held keys and
  buttons. The grant renews with each heartbeat. When it is lost, the viewer
  revokes input and must confirm within one second. Viewer control uses the
  existing lease and does not start writable VNC or change a read-only VNC
  server. Recovery of a stale viewer owner stops its verified process group
  first. (#341)
- MCP `request_takeover` asks the human for help with a short message. It
  expands the viewer, shows the message and sends a desktop notification
  without taking focus. Messages stay out of logs and evidence. MCP
  `takeover_wait` waits until control returns. Both return a fresh screenshot
  after the return. The default timeout is 10 minutes, with a one-hour limit,
  and a request can be cancelled. Timeout and cancellation leave live control
  unchanged, and the screenshot stays null while control is active. MCP opens
  a missing viewer only with `viewer.mode: "auto"`, a matching native binary
  and a graphical session. Otherwise it returns the `watch` command for the
  user. (#341)
- Browser sessions accept `--profile <name>` or MCP `session_create`'s `profile`
  argument to keep logins under `~/.pickforge/lab/profiles/<name>`. Private
  directories survive teardown and crash recovery. One session can hold a
  profile at a time. `profile list` shows size, last use, and holder;
  `profile delete <name>` refuses held profiles and requires `--yes` without
  a terminal. MCP provides read-only `profile_list`. Sessions without a
  profile stay ephemeral. Keep banking, payment, and main email accounts out
  of agent profiles. Chrome's Linux basic store relies on file permissions
  for cookie protection when no keyring is available. (#339)
- The noVNC fallback opens a small live view in a browser instead of
  an external VNC client. A loopback bridge serves a bundled noVNC page that
  shows the whole session scaled into a 384 pixel wide thumbnail. A click
  expands it to the session size; Collapse or Escape shrinks it again. The
  click never reaches the session and never grants control. Chromium and
  Google Chrome open a chromeless app window; Firefox opens an ordinary
  window. In Firefox a click shows the Collapse button, but the window keeps
  its size, because Firefox refuses to resize a window that a script did not
  open. Each launch uses a fresh private profile. With no graphical session
  or browser, `watch` prints the URL and an SSH tunnel command. On Hyprland
  with a Lua config, the window opens floating and pinned in the bottom-right
  corner without taking focus. `session create --viewer` and
  `viewer.mode: "auto"` use the same viewer.
  After the window closes, the bridge and the read-only x11vnc keep running
  idle. The bridge exits after 10 minutes without a viewer or request. (#207)
- Evidence reports now show where the agent clicked, double-clicked,
  scrolled or dragged on desktop captures. The viewer draws the marker from
  the recorded action and never paints it into the PNGs, so screenshots and
  MCP tool responses are unchanged. A hollow ring marks the point, and a line
  joins the start and end of a drag. A dashed marker means the input started
  but did not complete. Markers appear only on the before and after captures
  that an input action took with its `capture` option, and only when
  Pickforge verified the session's own Xvfb before and after the action. The
  Pointer markers switch hides them. Older runs show no markers. The CLI
  `desktop click` and `desktop drag` commands now record evidence actions
  too. (#199)
- Each pointer action now has its own glyph in evidence reports: a ring for a
  click, a double ring for a double click, a line with an arrow for a drag, an
  arrow for the scroll direction, and a box with a caret for the window that
  received typing. The before capture shows what was intended, and the after
  capture adds a dot where pointer input landed. Typing marks only the focused
  window, never a text position; Pickforge records the window's position and
  size, never the text. `desktop_move` takes no captures, so it has no
  glyph. (#200)
- `pickforge-lab artifacts export` writes copies of a run's screenshots with
  the glyphs drawn in, a `pointer-track.json` of pointer events for demo
  videos, and a manifest with hashes, into `exports/` inside the run.
  `--video` adds an ffmpeg slideshow of the frames. Originals are never
  changed, and exports do not count toward the evidence size cap. The pointer
  track holds no keyboard data, and its timing comes from action records, so
  it is approximate. (#200)
- Lab evidence finalization now writes `report-share.html` alongside the linked
  `report.html`. Download and open the share report in a browser, or ZIP the
  single file if a channel blocks HTML attachments. Original PNGs are embedded
  once per content hash at full resolution. Limits are 32 MiB per image and
  256 MiB total; excluded files are listed. Large runs produce large files.
  CLI and MCP artifact reports expose its path and byte size. The MCP report
  resource still serves the linked viewer. (#186)
- The MCP prompt `preview-flutter-component` walks an agent through rendering
  one Flutter widget without the full app, auth, routing or backend. Give it
  the widget and, optionally, states and viewports. It uses the Flutter Widget
  Previewer when the SDK has one, a temporary widget-test harness for exact
  sizes, and a temporary web entrypoint only as a fallback. The widget-test
  harness always runs the text scaling, semantics and overflow checks.
  Captures default to 390, 768 and 1440 logical pixels, and previews are
  viewed in a Pickforge browser session. Generated files are removed
  afterwards, and production routing, app startup and golden baselines are
  left alone. (#43)
- The published CLI now carries Sentry debug IDs, so fatal reports from
  opted-in telemetry can resolve to source wherever the package is
  installed. (#140)
- Browser lab sessions send less traffic to Google. Chrome's network time
  queries, Safe Browsing real-time lookups, AI Mode eligibility check and
  startup search preconnect are off. Browser sign-in polling and the on-device
  model update check now go to an unusable loopback address. Chrome therefore
  no longer treats `accounts.google.com` as its own sign-in page; pages can
  still sign in to Google as ordinary websites. The
  `scripts/lab/chrome-egress-check.mjs` release check now closes Chrome and
  cleans up correctly, exits 0 on a successful capture and observes for 120
  seconds. (#139)
- Desktop typing is more reliable on a busy machine. Pickforge now reads and
  plans the keyboard map before it briefly freezes the display, so CPU
  contention no longer uses up the 250 ms freeze limit. If the limit still
  expires, preparation makes up to three attempts within its 3 second budget.
  When preparation fails, no text is sent. (#222)
- Browser lab sessions no longer show Chrome's "unsupported command-line flag"
  bar for `--gaia-url`. Chrome now gets the same loopback sign-in sink through
  `--gaia-config-contents`, which is not on its list of unsupported flags.
  (#348)
- The Flutter skill explains how to keep the Dart MCP server connected. Hot
  reload and hot restart keep the connection. After a full rebuild, connect
  again to the new DTD URI. When the server is not connected, the skill uses
  Pickforge screenshots, the Android UI tree, logcat and adb. (#360)

## Fixes

- Desktop sessions start Xvfb with `-noreset`. A client that is still
  connecting no longer fails with "Can't open display" when another client
  disconnects. (#201)
- An app that exits at once under containment is no longer reported as
  launched on a busy host. (#203)
- Input tools record `not-attempted` when text preparation fails, the agent
  permit is refused, or a human holds control before input starts. Before,
  some of these failures were recorded as attempted. (#267, #284, #295)
- A peer that loses the race for a human lease reports that the lease is
  held, not stale. (#298)
- Teardown closes agent input before it releases a display, so a delayed input
  call for a destroyed session cannot reach a display that a new session
  reuses. A pruned session id is not reused while its takeover record
  remains. (#213, #170)
- Process cleanup sends SIGKILL only to proven members of a session's cgroup
  instead of writing `cgroup.kill`. A scope that cannot be inspected still
  gets the pre-kill guard. An unreadable process or a zombie leader with live
  threads no longer counts as gone, and the viewer stop signals such a
  zombie. (#194, #258, #324, #329)
- Apps in desktop sessions no longer connect to an inherited accessibility
  bus. (#269)
- Session retention removes orphan lease staging and `stopped.json` temp
  files, which blocked pruning of a retained session. (#313, #315)
- Android-only teardown runs under the per-session lock, like desktop and
  browser teardown. (#321)
- Session lock timeout and cancel errors name the session lock, not VNC, so
  they no longer mislead during Android or other teardown. (#326)
- The noVNC viewer bridge no longer fails its readiness check on a busy
  host. (#301)
- The `pickforge` binary reads `pubspec.yaml` with a safe-Rust YAML parser
  with size and depth budgets. (#332)
- Dependencies with published advisories moved to fixed versions, including
  the MCP SDK, which is now 2.3.1. (#343)

## Validation

- Local gates on `5f031e1`, the 0.7.1 branch with main merged: frozen install,
  typecheck, lint, `cargo fmt --check`, clippy with `-D warnings` for the
  Linux and Windows targets, the Rust workspace tests on Xvfb (260 passed), and
  `cargo build --release` with `pickforge 0.7.1` and `pickforge-viewer 0.7.1`
  version checks. The TypeScript suite ran with coverage and with the desktop,
  browser and native viewer requirements on: 3,345 passed, 4 skipped, 90.25%
  of lines covered. The build passed.
- The opt-in live Flutter test passed with Flutter 3.41.6.
- A device pass ran on Omarchy (Arch Linux) x86_64 with Flutter 3.41.6 and
  the CLI packed from `99c28a1`, in an isolated home. `pickforge doctor` and
  `pickforge init` passed, and `flutter run -d linux` ran through
  `pickforge-lab desktop exec` in a managed Xvfb session. Two clicks raised the
  counter from 0 to 2. A label change in `lib/main.dart` hot reloaded with the
  counter kept at 2, and one more click raised it to 3. `pickforge evidence
  record` recorded the run. The 0.7.1 native viewer then showed the same
  session, with the new label and 3, on a separate Xvfb display. An
  independent image review of the five screenshots returned PASS. Hot reload
  used SIGUSR1 to `flutter run`, not a Dart MCP reload call.
- Takeover was checked on the merged `4c6e18e`, before the version change, on
  a Hyprland host with fcitx5. The viewer opened without focus,
  `request_takeover` expanded it, and Take control, typing with accents and
  Return control worked.
- The `v0.7.0` tag run passed the Lab gates and both candidate smokes,
  although its Rust gates failed. The fixed Rust gates passed in a release
  workflow dry run on the 0.7.1 branch.

## Known limits

- Each finalized Lab run stores about 1.33 times its screenshot bytes again in
  `report-share.html`. Rendering near the 256 MiB cap needs roughly 1 GB of
  memory.
- If rewriting the share report fails when an outcome is recorded on an already
  finalized run, the previous reports stay in place and the error is returned;
  `actions.jsonl` stays authoritative.
- The native viewer ships for Linux x86_64 only. npm-only installs and a
  viewer binary from another version use the noVNC fallback. Hyprland with a
  Lua config is also the only placement adapter for the native viewer.
- A repository config can set `viewer.mode: "auto"` and so let MCP open the
  viewer. A later release will read that setting from the global config only.
  (#370)
- A read-only `watch` or MCP launch from another CLI version replaces the
  native viewer host, even when that host holds live human control. The human
  loses control without warning. (#371)
- The native viewer does not start when the session's `host.sock` path is
  longer than 107 bytes, which happens with a `PICKFORGE_HOME` longer than 67
  bytes. `watch` then reports that the viewer host did not report
  readiness. (#376)
- Hyprland with a Lua config is the only window placement adapter. Elsewhere
  the noVNC `watch` window is an ordinary window. Pickforge disables its Hyprland
  runtime rule after launch, but Hyprland keeps a disabled rule registered
  until the config reloads. The viewer token is on the browser's command
  line, which other processes on the same host can read. The window does not
  take focus when it opens, but it is not guaranteed never to. (#207)
- Browser lab sessions still send Chrome's activity ping to
  `update.googleapis.com` when a browser session ends. It has a hardcoded URL
  and no switch to disable it. (#139)
