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
produces an escaped, no-script `report.html` with a restrictive content
security policy and no external requests.

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

## VNC binds to loopback (SEC-01 — mitigated)

The desktop VNC server (`x11vnc`) is started with `-localhost`, so it listens on
`127.0.0.1` only and is not reachable from the network. It runs without a VNC
password (`-nopw`); that is safe precisely because the socket never leaves the
loopback interface. Normal `--vnc` and `pickforge-lab watch` observation is
server-enforced read-only (`-viewonly`): a connecting client cannot inject
keyboard or mouse input into the session, only watch it. `pickforge-lab watch`
starts this server lazily and closing its host-side viewer does not stop VNC,
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

Do not strip `-localhost` to put VNC on a shared network. An unauthenticated,
all-interface VNC server is a remote-takeover risk.

## desktop_launch runs as you (SEC-02 — known limitation)

`desktop_launch` and the `desktop_*` input tools run the target app as the user
who started Pickforge. There is no uid sandbox yet, so a launched app has your
filesystem and network access. Pickforge provisions a dedicated locked
`pickforge-lab` user and a dedicated `pickforge-avd`, but session processes do not
yet run under that user — uid isolation is planned. Until then, launch only apps
you trust, and prefer a throwaway user or VM for untrusted binaries.

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

What Pickforge does do:

- Each session gets its own private Xvfb and its own **ephemeral** Chrome
  profile under the session directory. Profiles are never borrowed from your
  real browser and are deleted on destroy.
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
