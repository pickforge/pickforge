# Security

Pickforge automates real software on your machine. It spawns and drives native
desktop apps and Android emulators, starts a local X display (Xvfb) and an
optional VNC server, and runs ADB. Treat it like any tool that can launch
processes and read screens: run it on hardware you control, against code you
trust.

This is the honest short version. The [README](README.md#security-model) has the
fuller model.

## Boundaries

- MCP tools never invoke sudo. Privileged provisioning happens only through the
  CLI, with explicit consent.
- User input is spawned as argument arrays, never interpolated into shell strings.
- Logcat and other artifacts are redacted by default. Only `android adb` is raw,
  and it says so.
- Agent config edits are atomic, with a backup of the previous config.

## Recorded evidence and screenshots

Computer-use evidence is stored as local run data, by default under
`~/.pickforge/lab/projects/<projectId>/runs/<runId>/` (outside the
project; see the README's "Run storage" section for storage modes).
Run directories are created and read through the same trust boundary: every
entry below the project directory, the Pickforge home, or the custom path must
be a real directory, so a symlinked `.picklab` committed in a repository cannot
redirect `project-local` artifact writes. An unsafe entry is reported, never
replaced or removed.

Sensitive run writes — manifests, the action journal and its lock and
truncation sentinel, the session's active-run pointer, HTML reports, and
screenshots and other run artifacts — are additionally bound to the *directory* that passed
verification, not to its pathname. Each directory is opened once with
`O_DIRECTORY|O_NOFOLLOW`, verified through that descriptor (its real path is
read back from `/proc/self/fd/<fd>`), and every write of the operation is
issued through the same descriptor. Replacing an ancestor after verification
therefore cannot redirect the write: it lands in the verified directory or
fails. Screenshots are produced into a process-private staging directory and
published through the held descriptor, since an external capture tool cannot be
handed a descriptor. This mechanism is Linux-only (as is the lab); where
`/proc/self/fd` is unavailable, run-storage writes fail closed rather than
falling back to pathname writes.

Reads (listing runs, reading manifests and journals) and retention pruning
apply the lstat/realpath trust boundary, but are not descriptor-bound in the
same way.
`actions.jsonl` is the authoritative sanitized timeline; finalization
produces an escaped `report.html` with a restrictive content security policy
and no external requests. Its policy allows exactly one inline script, pinned
by the sha256 of the emitted text. Filters, capture inspection, and the
navigation links remain usable with scripts blocked; only text search and
arrow-key browsing depend on that script. `report-share.html` uses the same
viewer with a hash-pinned hydration script and allows images only from `data:`.
It embeds original PNG bytes once per content hash, using bounded reads through
the verified screenshot directory. Symlinks, hardlinks, unsafe paths and files
without a PNG signature, or with incomplete or corrupt PNG data, are excluded
and listed. Limits are 32 MiB per image
and 256 MiB total. Text stays escaped and redacted; image bytes are unchanged.
Without JavaScript, report text remains readable and a notice explains that
embedded captures cannot be displayed.

The recorder persists only allowlisted metadata. Typed and filled text becomes
length plus input type. Failed network records keep method, URL origin/path
without the query, status, resource type, timing, and a sanitized error
classification. Request/response headers and bodies are dropped. Cookie,
authorization, session, JWT, CSRF, OTP, query-token, and CDP capability values
are redacted or omitted before persistence.

**Screenshots are different: pixels cannot be redacted.** An explicitly
requested desktop, Android, or DevTools screenshot stores the screen exactly as
displayed and may therefore contain passwords, tokens, personal data, or other
secrets. Pickforge never takes an implicit screenshot for typing/fill actions.
Do not explicitly capture a sensitive screen. Files are ordinary local files,
not encrypted storage; anyone who can read the project directory can read its
evidence.

Action evidence is enabled by default. Disable it per project when recording is
not appropriate:

```json
{
  "evidence": {
    "enabled": false
  }
}
```

This opt-out disables the action timeline and its screenshot association; it
does not block a screenshot command that was explicitly requested. The journal
and associated artifacts have a 100 MiB recording threshold per run. The
crossing record may exceed it; Pickforge then writes one durable metadata-only
truncation marker and stops appending payloads. Pickforge retains the latest 20
finalized evidence runs, while active/running and legacy runs are not pruned.

The native `pickforge-viewer` path starts no network server.
It connects to the session's local X socket with empty authorization and never reads `~/.Xauthority`.
The host verifies the session's Xvfb arguments, UID, process start time, lock PID, and socket ownership before launch.
The viewer window uses the caller's graphical environment. The capture target is passed through explicit launch arguments.
The detached host uses stdio for viewer commands and a Unix socket for local watch operations.
That socket is mode 0600 inside the session's mode 0700 `viewer` directory.
Readiness records include verified host and viewer process identities and the socket inode.
The socket accepts only status, expand, collapse, and shutdown. It cannot grant control or inject input.
Teardown checks process identities before stopping the host and viewer, and uses SIGKILL if SIGTERM fails.

Paste in the native viewer types host clipboard text into the session during control.
The viewer reads the clipboard only after a click on Paste while a grant is live. A read whose paste stopped starts no further step, and its result is dropped; on Wayland a stop during setup can still let the source write into a pipe that the viewer closes unread. A read that never answers blocks further reads instead of starting new ones.
On X11 it connects to the caller's `DISPLAY` with normal authorization. The empty-authorization rule above is for the session display.
On Wayland it uses the data-control protocol where the compositor offers it.
Without data-control, such as on GNOME, it uses the `wl_data_device` of the viewer window's own Wayland connection. The compositor sends that device the selection while the window has keyboard focus. The viewer notes the text types of each selection but asks the source for the text only after the click. A compositor with neither shows "Paste unavailable".
It asks for UTF-8 text only and reads at most 16 KiB within one second. It refuses INCR transfers, other formats, and text over 4096 characters.
The text never crosses the host channel. It never enters logs, errors, protocol events, or evidence records.
The viewer owns no selection on the session display, so no session process can read the text from a clipboard.
Session processes receive the typed keys like any keyboard input, and a resume screenshot shows what the session displays.
Characters missing from the session keyboard map are bound to spare keycodes, which stay bound. The map then shows which of those characters were typed, but not their order.
The viewer zeroes its text buffers after typing, but the X11 client library and the typing code keep short-lived copies that are not zeroed. A core dump of a crashed viewer can hold the text, as its frame buffer holds the screen.
The VNC fallback has no paste.

## VNC binds to loopback (SEC-01 — mitigated)

The desktop VNC server (`x11vnc`) is started with `-localhost`, so it listens on
`127.0.0.1` only and is not reachable from the network. It runs without a VNC
password (`-nopw`); that is safe precisely because the socket never leaves the
loopback interface. Normal `--vnc` and fallback `pickforge-lab watch` observation is
server-enforced read-only (`-viewonly`): a connecting client cannot inject
keyboard or mouse input into the session, only watch it. `pickforge-lab watch`
starts this server lazily on the fallback path. Closing its host-side viewer does not stop VNC,
Xvfb, or the session. `--vnc-control` is an explicit writable escape hatch for
entering a password, API key, or OTP directly into the lab app. Watch refuses
to reuse an active writable server rather than weakening its read-only
guarantee. Writable VNC does not yet pause or coordinate agent input, so stop
agent actions while using it. For remote viewing, forward the port over SSH:

```sh
# `session status` prints the VNC port (5900 + display number)
ssh -N -L <vncPort>:127.0.0.1:<vncPort> you@host
```

VNC PIDs are reused, reported alive, and stopped only when their persisted
process-start identity still matches. Session VNC creation and desktop/browser
destruction share one per-session mutation lock, preventing teardown races from
orphaning a late x11vnc process.

The native viewer input transport holds the existing human lease and drains
agent permits without starting writable x11vnc. Existing read-only VNC stays
read-only. Return releases held keys and mouse buttons on the session's explicit
`DISPLAY` before the resume screenshot. Stale viewer recovery first stops the
owner process group by its recorded process identity, then releases input.
Recovery keeps the lease when it cannot verify that the owner group stopped.
The host sends a grant every heartbeat, valid for twice the heartbeat interval.
A lost lease triggers revoke. The host allows at most one second for an input
release acknowledgement, then kills an unresponsive viewer.

The private host socket accepts attention, cancellation, and lifecycle subscriptions.
No socket operation can grant control or inject input. Only viewer stdio or an
explicit CLI control startup can acquire a lease. Messages have at most 500
characters and no control characters. They never enter logs or evidence.
Notifications use an argv array. Expansion and notification never take focus.
MCP opens a missing viewer only with `viewer.mode: "auto"`, a matching native
binary, and a graphical session. Without these, it returns a CLI command.

MCP and CLI desktop screenshots and waits fail closed during a live human
lease, like input. Each screenshot and wait capture holds an agent permit, so a
takeover drains it. A takeover also stops a wait capture in flight, which then
fails with busy. The internal capture primitive remains available for the resume shot.
`request_takeover` and `takeover_wait` capture only after the lease is gone, through the same guarded
observation path. Timeout or cancellation does not end human control or capture
its pixels; the screenshot field stays null while control remains active.

Do not strip `-localhost` to put VNC on a shared network. An unauthenticated,
all-interface VNC server is a remote-takeover risk.

## desktop_launch runs as you (SEC-02 — known limitation)

`desktop_launch` and the `desktop_*` input tools run the target app as the user
who started Pickforge. There is no uid sandbox yet, so a launched app has your
filesystem and network access. Pickforge provisions a dedicated locked
`pickforge-lab` user and a dedicated `pickforge-avd`, but session processes do not
yet run under that user — uid isolation is planned. Until then, launch only apps
you trust, and prefer a throwaway user or VM for untrusted binaries.

New managed desktops use a fresh session-local `HOME` and config, data, cache
and state XDG home directories under `<session>/runtime/home`. This keeps normal
app configuration writes away from the caller's home; it does not prevent an
app from reading or writing other paths, reaching the network, or using other
inherited environment variables. Desktop environments are not a secret-variable
allowlist. Do not launch untrusted applications.

The explicit creation-time opt-in is CLI `--inherit-home` or MCP
`session_create.inheritHome`. It preserves the caller's HOME/XDG home values,
including absent or empty XDG values, for subsequent managed launches. The
session's stored `desktop.homePolicy` is immutable through the CLI and MCP;
status reports it and new evidence manifests record `meta.desktopHomePolicy`
as an enum, not host paths. Inherited-home sessions allow human takeover without
relabeling their apps private. No inherited-home process is started while a human
lease is live. VNC control processes always use private home storage; takeover
starts require the matching human lease authority instead of an agent permit.
The runtime, dead D-Bus endpoints and other desktop guards still apply.

Legacy sessions without policy are reported as `legacy-inherit`. Their running
apps are neither changed nor claimed private. New managed processes require
recreation; invalid policy fails closed. Old evidence remains unchanged.
Private home creation refuses symlinks, checks ownership before tightening mode
`0700`, and binds writes and chmod to verified directory descriptors. Teardown
removes the private home with the runtime only after ownership and process
cleanup are confirmed. Pickforge never migrates or copies the caller's home.
The shell recipe from `desktop env` cannot revoke a shell's environment later;
do not reuse it during human takeover.

## Desktop session containment and runtime isolation

A desktop session owns everything it starts, and cleanup is confirmed rather
than assumed:

- **Containment scope.** Each session gets a cgroup v2 directory inside the
  delegated cgroup Pickforge already runs in, or, where no delegation exists, a
  256-bit random token exported as `PICKFORGE_CONTAINMENT_TOKEN`. Apps are
  started through a supervisor that joins the scope *before* spawning them, so
  a double-fork or `setsid` descendant cannot be created outside it. The
  supervisor does not trust a successful `cgroup.procs` write: it reads its
  membership back from `/proc/self/cgroup` and exits with status 126 without
  spawning the app if the kernel does not confirm the join. Neither mechanism
  needs `sudo`; MCP never calls it.
- **Nothing unrelated is ever signalled.** Cleanup selects targets by cgroup
  membership or by an exact token match read from `/proc/<pid>/environ`,
  re-checked immediately before each signal together with the process start
  time recorded by the scan, never by a remembered PID alone. A PID that exited
  between the scan and the re-check is treated as gone; a PID whose start time
  changed belongs to an unrelated process and is refused instead of killed; the
  same process whose token is momentarily unreadable (dying, mid-exec) is
  neither killed nor refused but decided on a later pass. A
  recorded cgroup path is only used when it is a `pickforge-*` directory on
  the cgroup v2 filesystem, so a tampered session record cannot aim
  `cgroup.kill` at the lab's own cgroup or at any other directory.
- **The caller is never killed.** The process performing the cleanup and its
  ancestors are excluded from every signal. When `session destroy` runs from
  inside a contained shell (for example one started with `desktop exec xterm`),
  that chain is a member of the session cgroup; cleanup first moves it into the
  parent cgroup, confirms from `cgroup.procs` that it is no longer a member,
  and only then writes `cgroup.kill`. If the chain cannot be moved out, cleanup
  refuses with a reason that says to run the command from outside the session,
  rather than terminating the caller.
- **Confirmed cleanup.** `session destroy` reports success only once the scope
  is empty. Otherwise it fails with the surviving or refused PIDs, leaves the
  session in `error` with a reaper retry marker, and does not delete session
  state that a live process could still be writing to: the runtime directory
  is removed only after contained apps, x11vnc and Xvfb are all confirmed
  gone.
- **Per-session runtime and D-Bus.** Each session gets its own
  `XDG_RUNTIME_DIR` (mode `0700`, inside the session directory) and its own
  `DBUS_SESSION_BUS_ADDRESS`/`DBUS_SYSTEM_BUS_ADDRESS`, pointing at socket paths
  that are never created, so toolkits and portals fail closed instead of
  reaching the real user session. Related `DBUS_*` variables are dropped from
  the child environment. Every x11vnc start (session create, `desktop watch`,
  human takeover and its revert) goes through one helper that attaches this
  runtime, so a server started after create never keeps the caller's bus.
  Removal is refused for any runtime path that is not confined to the session
  directory, including through a symlink.
- **No code injection into the supervisor.** `NODE_OPTIONS`, `NODE_PATH`,
  `NODE_REPL_EXTERNAL_MODULE` and `BUN_OPTIONS` are stripped from the desktop
  environment, so a hostile caller environment cannot run code inside the Node
  supervisor before it joins the scope. Contained apps do not receive them
  either; `desktop env` lists them under `unset`.
- **Xvfb teardown** uses the same group-signal-and-confirm discipline as the
  browser supervisor: an exited daemon is not reported gone while a member of
  its process group is still alive.

Limits to account for: containment holds processes that are descendants of a
Pickforge launch. It does not sandbox them — see SEC-02 — and it cannot recover
a descendant that erases its own environment block, or execs a setuid image,
on a host without cgroup delegation. On the marker path there is an irreducible
window between the last token re-read and `kill(2)`; the cgroup path has no
such window. `PICKFORGE_CONTAINMENT=marker` forces the marker mechanism on a
host that would get a cgroup; it exists to exercise the fallback path in tests
and is reported as `marker` like any other degraded scope.

## Browser sessions run as you (SEC-03 — known limitation)

Browser sessions launch real headed Chrome/Chromium inside a private Xvfb
display. Pickforge hardens the launch, but v1 is for authorized, trusted
development and QA — it is **not** a sandbox for hostile web pages.

Named profiles store cookies, login tokens, history, local storage, and site
settings. Pickforge always selects Chrome's basic store. Cookies are encrypted
with a fixed key, so only file permissions protect them. Profile directories
require mode 0700 and ownership by the current user. Symlinks and group or other permission bits
are refused. Processes running as your user can still read them. Keep banking,
payment, and main email accounts out of agent profiles.

A profile has one session holder. Teardown releases the hold after process
cleanup. Crash recovery checks the old owner before reclaiming the hold or
clearing Chrome singleton entries. `profile list` shows size, last use, and
holder. `profile delete <name>` refuses held profiles and requires `--yes`
without a terminal. MCP exposes only read-only `profile_list`.

What Pickforge does do:

- By default, each session gets its own private Xvfb and an **ephemeral** Chrome
  profile under the session directory. Profiles are never borrowed from your
  real browser. Ephemeral profiles are deleted on destroy. Named profiles
  selected with `--profile` survive teardown and crash recovery under
  `~/.pickforge/lab/profiles/<name>` (or the `PICKFORGE_HOME` override).
  Chrome's temporary files stay in
  the session directory, reached through a short, private `/tmp` symlink so its
  fixed Unix-socket path limit also works with deeply nested Pickforge homes;
  the symlink is identity-checked and removed on destroy.
- Chrome starts from a **scrubbed environment** (`cleanEnv`): only the isolated
  display, isolated `HOME`/`XDG_*` paths, `PATH`, and locale reach it. Secrets
  in your shell environment are not inherited by the browser.
- The DevTools/CDP endpoint uses an OS-assigned port bound to loopback
  (`--remote-debugging-port=0` plus an explicit `127.0.0.1` address). It is not
  reachable off-host.
- The DevTools websocket path is a capability URL: whoever holds it controls the
  browser. Pickforge reads only the port from `DevToolsActivePort` and **never**
  persists the websocket path/GUID in session records or diagnostics.
- `pickforge-lab browser devtools-mcp` resolves only a live browser session owned by the current project and derives `http://127.0.0.1:<port>` in memory. It accepts no arbitrary browser URL and stores no CDP endpoint or websocket GUID.
- The relay validates the installed `chrome-devtools-mcp` package name, exact `1.5.0` version, declared bin, and confined real path before starting it directly with Node (`shell: false`). Runtime `npx`, upstream update checks, and upstream usage statistics are disabled.
- Relay stdout contains only validated LF-delimited JSON-RPC records, with pending records capped at 16 MiB. Upstream stderr lines are capped at 64 KiB, redacted, and forwarded only to stderr; over-limit lines are dropped with a safe notice. Malformed or incomplete protocol input fails closed and terminates the upstream process.
- On destroy or reap, the whole Chrome **process group** is terminated and
  verified dead (PID plus `/proc` start-time identity, so a reused PID is never
  signalled) **before** the profile is deleted — no orphaned renderers, no
  leftover profile data.

What it does not do, and you must account for:

- **Loopback is not isolation from local processes.** Chrome and the CDP
  endpoint run as the user who started Pickforge. Any local process running as
  that user can reach the loopback CDP port and drive the browser. Loopback
  binding only keeps the network out, not other local processes.
- There is **no uid sandbox** for the browser yet (same limitation as SEC-02).
  Launch only content you trust; prefer a throwaway user or VM otherwise.
- The official Chrome DevTools MCP runs with the same user privileges as Pickforge and exposes its upstream tool surface without method filtering. An agent with access to `pickforge-lab-browser` can inspect and control the isolated browser; grant that MCP entry only to agents you trust.

Planned hardening tracked separately: per-session uid isolation, and moving CDP
off a TCP port onto `--remote-debugging-pipe`.

## Reporting a vulnerability

Please report privately. Do not open a public issue for security bugs.

- GitHub: open a private advisory at
  <https://github.com/pickforge/pickforge/security/advisories/new>
- Email: <security@pickforge.dev>

We aim to acknowledge within a few days, and we will credit reporters who want it.

---

<p align="center">
  <a href="https://pickforge.dev">
    <img src="assets/brand/pickforge-studio-footer.svg" alt="Pickforge Studio — local-first, open source, built for people who ship" width="560">
  </a>
</p>
