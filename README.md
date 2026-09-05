<p align="center">
  <img src="https://raw.githubusercontent.com/pickforge/pickforge/main/assets/brand/pickforge-lockup-horizontal.svg" alt="Pickforge" width="560">
</p>

# Pickforge

Playwright for native apps and Android emulators. Pickforge gives AI coding agents eyes, hands, and a reproducible lab: desktop sessions on Xvfb, Android emulators on a dedicated AVD, screenshots, input, logs, and run artifacts — over a CLI and an MCP server.

Pickforge lets agents see, run, and test the app. PickArena measures the results.

Local-first. Open source. Built for people who ship.

## PickLab is now Pickforge

The npm package is now `pickforge`. The TypeScript CLI is `pickforge-lab`, and
the MCP stdio binary is `pickforge-mcp`. Agent config uses the
`pickforge-lab` MCP server name. Run `pickforge-lab agents link <agent>` to
replace owned legacy `picklab` entries. `pickforge-lab init` does not change
Claude Code, Codex, Cursor, or Pi configuration.

All `PICKFORGE_*` environment variables fall back to their matching
`PICKLAB_*` name for one release. Using an old name prints one deprecation
warning to stderr per process.

New TypeScript state is written under `~/.pickforge/lab/`, or the directory
set by `PICKFORGE_HOME`. Existing state under `~/.pickforge/picklab/` and
`~/.picklab/` is still read in place. Nothing is silently migrated or deleted.
The project-local `.picklab/` layout remains supported.

Remove the old package after installing the new one:

```sh
npm uninstall -g @pickforge/picklab
# or: bun remove -g @pickforge/picklab
```

## Install

Let your coding agent do the whole setup — paste this into its prompt:

```text
Install and configure Pickforge by following https://raw.githubusercontent.com/pickforge/pickforge/main/INSTALL.md
```

Or install by hand:

```sh
curl -fsSL https://pickforge.dev/install.sh | sh
```

For the alpha, the npm-only forms use the `next` dist-tag and install the
TypeScript commands without the Rust CLI:

```sh
npx --yes --package pickforge@next pickforge-lab doctor
bunx --package pickforge@next pickforge-lab doctor
npm install -g pickforge@next
bun add -g pickforge@next
```

The installer adds three commands side by side: `pickforge` (Rust),
`pickforge-lab` (TypeScript lab CLI), and `pickforge-mcp` (MCP stdio server).
It verifies the Rust binary's SHA-256 checksum and never uses sudo. The lab is
Linux-only; the Rust CLI also ships for Apple silicon macOS.

The Chrome DevTools relay requires Node.js `^20.19.0`, `^22.12.0`, or `>=23.0.0`.

## Quickstart

This is the Flutter loop proven for the alpha. Start in a Flutter project and
run the Rust readiness and integration steps first:

```sh
cd your-flutter-app
pickforge doctor
pickforge init
```

`init` configures the Flutter integration: the official Dart/Flutter MCP
server and the `pickforge-flutter` workflow for Claude Code, Codex, and Pi.
`init --dry-run` previews every change first. Register the lab
MCP with the agent you use, initialize a Linux desktop profile, and start the
app inside an isolated lab session:

```sh
pickforge-lab agents install codex   # use claude-code or pi when appropriate
pickforge-lab init --profile flutter-desktop --yes
pickforge-lab session create --type desktop
pickforge-lab desktop exec -- flutter run -d linux
```

`desktop exec` starts the command in an isolated process group and waits for a
client window on the lab display. If none appears before the timeout, it stops
the group and reports a possible escape. Restart the coding agent if it did not
already have the Pickforge MCP servers loaded.

Now inspect the running widget tree and runtime with the official Dart/Flutter
MCP tools. Capture the initial screen, inspect the image, and click the target
coordinate you found:

```sh
before_png="${TMPDIR:-/tmp}/pickforge-before.png"
pickforge-lab desktop screenshot --out "$before_png"
pickforge-lab desktop click 760 520
```

Edit the relevant Dart source, run a scoped analysis or test, then use the
official Dart/Flutter MCP hot-reload tool. Repeat the same scenario and inspect
the new screenshot. Do not claim success until the runtime state and pixels
match the intended change.

```sh
flutter analyze lib/main.dart
after_png="${TMPDIR:-/tmp}/pickforge-after.png"
pickforge-lab desktop screenshot --out "$after_png"
```

Record the verified before/after result outside the project. Adjust the
scenario, observations, source file, and checks to match the work you actually
did:

```sh
evidence_input="${TMPDIR:-/tmp}/pickforge-evidence.json"
cat >"$evidence_input" <<JSON
{"schemaVersion":1,"scenario":"Counter updates after hot reload","outcome":"passed","before":{"summary":"Counter showed zero.","observations":[{"label":"Counter","value":"0"}],"artifacts":[{"kind":"screenshot","label":"Before","source":"$before_png"}]},"after":{"summary":"Counter showed one.","observations":[{"label":"Counter","value":"1"}],"artifacts":[{"kind":"screenshot","label":"After","source":"$after_png"}]},"sourceChanges":["lib/main.dart"],"checks":[{"name":"flutter analyze lib/main.dart","status":"passed","summary":"No issues found."}],"limitations":[]}
JSON
pickforge evidence record --project-dir "$PWD" --input "$evidence_input"
pickforge-lab session destroy --all
```

Every screenshot, log, and action lands in a run directory with a manifest, so
a run is inspectable and reproducible after the fact. By default that run
directory lives outside your project. See [Run storage](#run-storage) below.

### Running development commands in a desktop session

Use `desktop exec` for commands that build and start their own GUI process, such
as Flutter. It starts a separate process group with `WAYLAND_DISPLAY` pointed
at the non-existent `pickforge-no-wayland` socket, removes other inherited
`WAYLAND_*` variables, and sets X11 backend hints for Electron, GLFW, GTK, Qt,
SDL, winit, and the session type.
The poison value matters because libwayland falls back to `wayland-0` when
`WAYLAND_DISPLAY` is unset. Pickforge then waits up to 30 seconds for a client
window on the lab display:

```sh
pickforge-lab desktop exec --session <id> -- flutter run -d linux
# For a slower first build:
pickforge-lab desktop exec --session <id> --window-timeout 120000 -- flutter run -d linux
```

If no client window appears while the command is still alive, Pickforge stops
its process group and reports that the app may have escaped to the real desktop
instead of leaving a silent black frame. Increase `--window-timeout` for a slow
first build. `desktop launch` uses the same isolated environment and remains the
shorter path for an already-built app.

A process group is not enough on its own: an app that double-forks or calls
`setsid` leaves the group and would survive a group kill. Every desktop session
therefore also owns a **containment scope**, and `desktop exec`/`desktop launch`
start the app inside it:

- On a host with a delegated cgroup v2 (a normal systemd user session), the
  session gets its own cgroup. A process cannot leave a cgroup without
  privileges, so daemonised descendants stay members and `cgroup.kill` stops
  them all at once.
- Otherwise Pickforge falls back to a per-session random token exported as
  `PICKFORGE_CONTAINMENT_TOKEN`. Descendants inherit it, and cleanup finds them
  by reading `/proc/<pid>/environ`.

Both report which mechanism was used (`containment: cgroup` or
`containment: marker`) and neither ever needs `sudo`. `session destroy` stops
every contained process and only reports success once none remains. It never
kills the shell it was typed into: run from inside a contained shell, it moves
its own process chain out of the session first, or refuses and tells you to run
it from outside.

When a shell or another parent process must launch the app itself, apply the
same environment first:

```sh
eval "$(pickforge-lab desktop env --session <id>)"
flutter run -d linux
```

`desktop env --json` returns the same `exports`, `unset`, and `script` recipe
without including unrelated environment variables or secrets. It also carries
the session's containment token, so an app you start by hand from that shell is
torn down with the session rather than surviving it.

Each desktop session also gets its own `XDG_RUNTIME_DIR` (mode `0700`, inside
the session directory) and its own D-Bus addresses, which point at socket paths
Pickforge never creates. A toolkit or portal therefore fails to reach a bus
instead of quietly routing work back through your real user session, and the
whole directory is removed when the session is destroyed. Desktop
screenshots report the visible client-window count and warn when it is zero.
If `xdotool` is missing, capture still succeeds and warns that the count is
unavailable instead of reporting a possible escape.

### Run storage

By default, run artifacts (screenshots, logs, manifests, evidence journals)
are written under the shared Pickforge company root, **not** inside your
project — a default screenshot or run never shows up in `git status`:

```text
~/.pickforge/lab/projects/<projectId>/runs/<runId>/
```

`<projectId>` is a stable id derived from the project's canonical (symlink-resolved)
path: the same project always resolves to the same id, and different projects
never collide. Use the platform home-directory equivalent on non-Linux systems.
`PICKFORGE_HOME` overrides the Pickforge home root (default `~/.pickforge/lab`);
`pickforge-lab doctor` reports the resolved path.

Two other modes are available via `storage` in the **global** config or the
`PICKFORGE_STORAGE_MODE` / `PICKFORGE_STORAGE_PATH` environment overrides for
automation and tests; `.picklab/config.json` (project-level) can select
`project-local`, but not `custom` — see below:

```json
{
  "storage": { "mode": "project-local" }
}
```

- `home` (default) — the layout above.
- `project-local` — restores the previous default: `.picklab/runs/` inside the
  project. Generated files then do appear in the project's source-control
  view; add `.picklab/runs/` to `.gitignore` if you opt into this mode.
  Selectable from project or global config.
- `custom` — an explicit absolute path outside the project directory:
  `{ "storage": { "mode": "custom", "path": "/abs/path" } }` writes runs
  under `<path>/runs/`. A relative path, a path equal to or nested inside the
  project directory, or `custom` mode with no path, is rejected.

Writes and reads share one trust boundary. Every directory between the trusted
ancestor (the project directory, the Pickforge home, or the custom path) and a
run must be a real directory: a symlinked `.picklab`, `runs`, or project-id
entry is refused with an error before anything is created, the same way the
run catalog ignores such entries when reading. This blocks a `.picklab` symlink
committed in a cloned repository from redirecting `project-local` artifacts.
Pickforge never replaces, moves, or deletes the offending entry; fix it and
rerun.

**`custom` cannot be selected from project-level `.picklab/config.json`.**
That file is repo-committed and travels with `git clone`; honoring a
`custom` selection from it would let a cloned repository silently redirect
run artifacts (screenshots, which may carry secrets) to any absolute path
with no prompt. Only the user-owned global config or an env override may
select `custom`. A project config that requests `custom` is ignored — the
resolver falls back to global config's mode, then `home` — and `pickforge-lab
doctor` surfaces the rejected request as a warning.

`.picklab/config.json` itself always stays project-local regardless of
`storage` mode — only generated runtime artifacts move.

**Upgrading from an earlier version:** existing runs already written under a
project's `.picklab/runs/` remain discoverable by `artifact_list` /
`artifact_report` / MCP resources without any migration step. Existing global
config, agent state, sessions, and runs under `~/.pickforge/picklab/` or
`~/.picklab/` are also read as non-destructive fallbacks when the new
`~/.pickforge/lab/` location has no matching state. Nothing is moved or
deleted. `pickforge-lab doctor` prints the active state directory and flags a
detected legacy home.

### Project state ownership

Two programs write per-project state: the Rust integration CLI (`pickforge`)
and the TypeScript lab (`pickforge-lab`). They default to separate roots —
`~/.pickforge/pickforge` and `~/.pickforge/lab` — but a single `PICKFORGE_HOME`
points both at one root, which is the normal setup for CI, automation, and
isolated smokes. Inside that shared root they share exactly one directory per
project:

```text
<PICKFORGE_HOME>/projects/<projectId>/
```

Ownership there is by entry name, exhaustive, and non-overlapping:

| entry                             | owner                             |
| --------------------------------- | --------------------------------- |
| `layout.json`                     | shared — the layout marker        |
| `runs/`                           | shared — one run tree, two writers |
| `project.json`                    | `pickforge` — integration receipt |
| `project.json.pickforge-backup-*` | `pickforge` — receipt backups     |
| `.pickforge-tmp-*`                | transient, either tool            |
| anything else                     | nobody                            |

`runs/` is shared because both tools write into it: the lab creates run
directories there, and `pickforge evidence record` writes its own. Each writes
only its own run directories and neither reads, rewrites, or deletes the
other's. Everything else each tool writes is its own, and neither writes,
moves, or deletes anything unowned. Above this directory the split is by name
too: `sessions/`, `agents/`, and `config.json` at the root are the lab's, and
`projects/` is the only shared parent.

**Command order does not matter.** `pickforge init`, `pickforge evidence
record`, and a lab run can happen in any order for the same project; whichever
runs first claims the directory and the others join it. Every writer on both
sides goes through the same claim, so the layout version, the marker's shape,
and the ownership rule below are checked on one path. (Before 0.4.0-alpha.2,
`pickforge init` refused a project whose state directory already held lab runs
— see #104.)

**Layout version.** `layout.json` records the layout version, currently `1`:

```json
{
  "layout": "pickforge-project-state",
  "layoutVersion": 1
}
```

Version 1 *describes the layout alpha.1 and alpha.2 already wrote* rather than
replacing it, so no existing state needs migrating. A directory from an earlier
release is adopted in place the next time either tool writes to it: the marker
appears beside what is already there and nothing else changes.

**First adoption checks the whole directory.** Before either tool stamps the
marker on a directory nobody has claimed yet, every entry directly inside it
must be one the table above assigns to an owner. A single unowned entry stops
the adoption, and nothing is written. After a directory carries a marker it is
not re-judged: ownership was settled when it was claimed, and re-policing it
would let an entry added later break a tool that never reads it.

**The marker is created at most once.** It is staged in an exclusively created,
unpredictably named file inside the same directory, with its bytes complete and
flushed, and published with `link(2)` — which fails rather than replacing
anything that is already there. It is therefore never observed half-written,
never overwrites another file, and never follows a link out of the directory.
Cleanup removes the staging entry only when that name still resolves to the
file this run created, so a crash remnant or a planted entry is left alone. On
Linux every lookup resolves through the state directory's own descriptor, so an
ancestor swapped mid-run cannot redirect any of it. A marker that is a symlink,
a hard link to another file, or not a regular file is refused rather than
trusted, by both tools. When both tools reach a fresh project directory
simultaneously, exactly one claims it and the other reads back and validates
the winner's marker — first use cannot leave partial ownership.

**Compatibility policy.** A tool refuses, with the exact manual action to take,
rather than guessing:

- A `layoutVersion` this build does not understand: upgrade Pickforge, or use a
  different `PICKFORGE_HOME`. Nothing is written.
- A `layout.json` that is not a Pickforge marker, or is a link rather than a
  regular file: move it aside, or use a different `PICKFORGE_HOME`.
- An unowned entry in an unclaimed project state directory: the tool names the
  path and a shell-quoted `mv -n -- <path> <unused>.bak` to run. It never moves
  or deletes it for you, and the suggested command never clobbers. A path whose
  name cannot be shown as a safe shell word is described instead, without a
  copyable command.

A future layout version may add entries, but only under a name the table above
does not already assign, and only with both tools able to read version 1.

### Evidence recording

Computer-use tools record one session-scoped evidence run by default. MCP
desktop, Android, and session actions share the same append-only timeline as
browser DevTools actions. Destroying a session, or reaping a dead one, finalizes
the run and writes a static `report.html` filmstrip.

A finalized evidence run directory (see [Run storage](#run-storage) for where
it lives) contains:

- `manifest.json` — run identity, status, and evidence metadata
- `actions.jsonl` — authoritative, append-only sanitized action timeline
- `report.html` — escaped, no-script human filmstrip generated at finalization
- `screenshots/` and `logs/` — associated artifacts, when explicitly captured

Typed values are stored only as length and input type. Network failures keep
only allowlisted method, URL origin/path without its query, status, resource
type, timing, and sanitized error metadata; headers and bodies are never kept.
Pickforge does not take implicit screenshots for input actions. Explicit
screenshot tools still capture the screen exactly as displayed.

The journal and associated artifacts have a 100 MiB recording threshold per
run. The record that crosses the threshold may exceed it; Pickforge then writes a
durable metadata-only truncation marker and stops appending further payloads.
Only the latest 20 finalized evidence runs are retained; active/running and
legacy runs are never pruned.

Evidence recording is enabled by default. Disable the action timeline for a
project in `.picklab/config.json`:

```json
{
  "evidence": {
    "enabled": false
  }
}
```

This does not block an explicitly requested screenshot command. Screenshot
pixels cannot be redacted; see [SECURITY.md](SECURITY.md#recorded-evidence-and-screenshots).

### Supervised pause and human takeover

```sh
pickforge-lab watch --session <id> --control   # pause the agent, take a temporary writable viewer
pickforge-lab takeover status --session <id>   # check whether a session is under human control
```

`pickforge-lab watch --control` pauses Pickforge-managed agent input for a session,
grants a temporary writable VNC viewer for a human, and hands control back
with a fresh screenshot and an evidence record once the viewer closes (or the
terminal is interrupted). Unlike `--vnc-control`'s persistent writable
session, control here is leased: while a human holds it, every desktop input
tool (`desktop_click`/`move`/`scroll`/`drag`/`double_click`/`type`/`key`),
`desktop_launch`/`desktop_exec` (a newly launched client could otherwise grab
input focus), and every DevTools relay request fail closed with a stable busy
error —
`takeover_status` (MCP) / `pickforge-lab takeover status` (CLI) let an agent check
before retrying, and `request_user_input` is the recommended way to ask a
human to run it. `desktop_screenshot` is the only desktop tool left ungated
(read-only).

The lease is a 30-second TTL, heartbeat-renewed-every-5-seconds record in the
session's state directory. Closing the viewer, an interrupted terminal, or a
Pickforge crash all release it and revert VNC to read-only. A crash of the
`watch --control` process itself is reclaimed *actively*, not only the next
time something else happens to touch the session: a detached watchdog
process, spawned alongside the takeover and immune to a `SIGKILL` of its
parent, polls the lease and stops a stale writable VNC on its own — writable
VNC does not survive its lease going stale, whichever side crashes.

### Concurrent sessions

Each session gets its own isolated display or emulator, so several agents and projects can run labs side by side. When a command or tool is called without an explicit session id, the default resolves per project: only running sessions created for the same project directory are considered. Pass `session` ids (CLI: `--session <id>`) to target a specific lab, including one belonging to another project.

`pickforge-lab browser devtools-mcp` is intentionally stricter: it always resolves exactly one live browser session for the current project. It does not accept a session id, browser URL, or WebSocket endpoint.

<p align="center">
  <img src="https://raw.githubusercontent.com/pickforge/pickforge/main/assets/brand/pickforge-run-lab-mock.svg" alt="PICKFORGE · RUN LAB — desktop session, Android emulator, live screenshots, logs, and agent terminal" width="900">
</p>

## Telemetry

When the `pickforge-lab` CLI or `pickforge-mcp` server hits a fatal error, it reports the error message and stack trace — the message can reference the failing command and its output, with secrets redacted — plus OS, Node.js, and app versions to Sentry so we can fix it. Nothing else is collected. Disable with `PICKFORGE_TELEMETRY=0`.

## MCP setup for agents

Register the MCP server with your coding agent:

```sh
pickforge-lab agents install claude-code   # also: codex, cursor, pi
pickforge-lab agents list
pickforge-lab agents doctor
```

Pi uses `~/.config/mcp/mcp.json`; core Pi needs `pi-mcp-adapter` to load it.

For any other agent, add the stdio server yourself:

```json
{
  "mcpServers": {
    "pickforge-lab": {
      "command": "pickforge-lab",
      "args": ["mcp", "serve"]
    },
    "pickforge-lab-browser": {
      "command": "pickforge-lab",
      "args": ["browser", "devtools-mcp"]
    }
  }
}
```

`pickforge-lab-browser` is static. Each invocation discovers the one live browser session for the agent's project and derives its loopback CDP URL in memory, so recreating a session never requires an agent config edit. The relay runs the bundled, exact `chrome-devtools-mcp@1.5.0`; it does not use `npx` or connect to a personal browser.

Custom agents can be stored under the Pickforge home's `agents/` dir (default
`~/.pickforge/lab/agents`, override via `PICKFORGE_HOME`):

```sh
pickforge-lab agents add --name my-agent --mcp-command "pickforge-lab mcp serve"
```

## CLI reference

| Group | Commands |
| --- | --- |
| Setup | `doctor`, `init`, `setup lab-user`, `setup android` |
| Sessions | `session create`, `session status [id]`, `session destroy <id\|--all>` |
| Watch | `watch [--session <id>] [--control]` |
| Takeover | `takeover status [--session <id>]` |
| Desktop | `desktop launch <cmd>`, `desktop exec <cmd>`, `desktop env`, `desktop screenshot`, `desktop click <x> <y>`, `desktop move <x> <y>`, `desktop scroll <deltaX> <deltaY>`, `desktop drag <fromX> <fromY> <toX> <toY>`, `desktop double-click <x> <y>`, `desktop type <text>`, `desktop key <keys>` |
| Android | `android start`, `android install-apk <apk> [--wait-ready <s>]`, `android launch-app <pkg> [--wait-ready <s>]`, `android screenshot`, `android tap <x> <y>`, `android type <text>`, `android back`, `android home`, `android ui-tree`, `android logcat`, `android adb [args...]` |
| Artifacts | `artifacts list`, `artifacts open <runId>`, `artifacts report [runId]` |
| Agents | `agents list`, `agents install <agent>`, `agents link <agent>`, `agents unlink <agent>`, `agents doctor`, `agents add` |
| Browser | `browser devtools-mcp` |
| MCP | `mcp serve` |

Session types: `desktop` (Xvfb, optional VNC), `android` (emulator on the dedicated AVD), `desktop+android`, and `browser` (isolated headed Chrome with loopback CDP). Most commands accept `--json` for machine-readable output and `--project-dir` to target another project.

Android sessions boot from the AVD's saved state when it has one; the session summary and `session status` report `bootMode` (`warm`, `cold`, or `unknown`). `--cold-boot` skips the saved state (emulator `-no-snapshot-load`) and `--read-only` lets several sessions share one AVD (emulator `-read-only`; such a session cannot save a snapshot). The emulator only shares an AVD when *every* instance on it is read-only: a writable session blocks any further session on that AVD, and Pickforge reports that before spawning. `android launch-app` resolves the package's launcher activity, starts it with `am start -W`, and confirms a process for the package is alive, so a launch that the device silently drops is an error rather than a success. `android install-apk` and `android launch-app` (and the MCP tools) accept an opt-in `--wait-ready <seconds>` / `waitReadySeconds` that waits until guest lowmemorykiller has been quiet for 30 seconds before starting the action, reports each probe as progress, and fails with `guest-not-ready` without installing or launching if the bound is hit. `0` or omitted means no wait on both CLI and MCP. The wait uses `logcat -s lowmemorykiller:I` against the guest clock, treats an unreadable clock or logcat as not quiet, honours MCP cancellation (`aborted`), and keeps each probe inside the remaining wall-clock bound. Pickforge still does not retry a launch the guest drops. On a 2 GB Play-Store image the first launch of a freshly sideloaded APK right after a quickboot restore can be killed while `am start -W` reports it drawn. Pickforge pins `avdmanager` and the emulator to one AVD directory through `ANDROID_AVD_HOME` (defaulting to `~/.android/avd`, or the emulator's `ANDROID_USER_HOME`/`ANDROID_EMULATOR_HOME`/`ANDROID_PREFS_ROOT`/`ANDROID_SDK_HOME` conventions), because `avdmanager` alone honours `XDG_CONFIG_HOME` and the emulator does not. A start that fails names one cause — `avd-missing`, `avd-in-use`, `port-collision`, `snapshot`, `kvm`, `process-exit`, `boot-timeout` (with the adb device state), or `aborted` — with the emulator log path and its last lines, and the same diagnosis is kept in the session record's `meta.androidStartFailure`. Console ports are checked against adb, the per-home reservation registry, and a loopback bind probe before launch, so sessions from different Pickforge homes do not collide.

`session create --vnc` is read-only. `--vnc-control` creates an explicitly writable VNC session up front and does not coordinate with agent input — pause agent activity yourself while using it. For a coordinated, leased handoff instead, use `pickforge-lab watch --control` (see [Supervised pause and human takeover](#supervised-pause-and-human-takeover)), which fails agent input closed for the lease's duration and hands back a fresh screenshot automatically.

Scroll deltas are integer wheel steps: positive `deltaY` scrolls down, negative up; positive `deltaX` scrolls right, negative left (put negative values after `--`, e.g. `pickforge-lab desktop scroll -- 0 -3`). `desktop scroll` accepts `--at <x,y>` to position the pointer first; `desktop drag` accepts `--button` and `--duration <ms>`; `desktop double-click` accepts `--button` and `--interval <ms>`.
`pickforge-lab watch [--session <id>]` attaches a normal host-side VNC window to an
already-running desktop-capable session. It lazily starts one loopback-only,
server-enforced read-only x11vnc server and reuses it on later watches. Closing
the viewer leaves x11vnc, Xvfb, and the session running. With no matching
session it prints the create command; with multiple matches it fails closed
until `--session` selects one.
Desktop capability is resolved from the persisted desktop leg rather than the
session type, so browser sessions are watchable without watch-specific browser
contracts.

Viewer launch defaults to manual. Set it globally or in
`.picklab/config.json` for a project:

```json
{
  "viewer": {
    "mode": "auto"
  }
}
```

`session create --viewer` and `session create --no-viewer` override that mode
for one desktop or browser creation. If the host has no graphical session or
supported client
(`remote-viewer` from virt-viewer, or a TigerVNC-compatible `vncviewer`),
Pickforge opens nothing and prints the loopback endpoint, install guidance, and
an SSH tunnel command instead.
Explicit `pickforge-lab watch` waits until the viewer closes and fails if the client
exits nonzero or on a signal, while leaving the session and VNC running.
Automatic or `session create --viewer` launch returns as soon as the client
starts, so the viewer never owns or delays session creation. A requested attach
failure is reported alongside the successfully created session. `--viewer` and
`--vnc-control` are rejected together before creation; `viewer.mode: "auto"` is
reported as suppressed for an explicitly writable `--vnc-control` session.

## MCP surface

`pickforge-lab mcp serve` exposes 28 tools over stdio:

- Sessions: `session_create`, `session_status`, `session_destroy`
- Desktop: `desktop_launch`, `desktop_exec`, `desktop_screenshot`, `desktop_click`, `desktop_move`, `desktop_scroll`, `desktop_drag`, `desktop_double_click`, `desktop_type`, `desktop_key` — all fail closed with a busy error while a human lease is active except `desktop_screenshot` (read-only). `desktop_launch` and `desktop_exec` are gated too: a newly launched client can grab input focus on the shared display, which is exactly what the lease protects against. `desktop_exec` applies the isolated X11 environment and waits for a client window; `desktop_screenshot` reports the client-window count and warns when it is zero, or reports that the count is unavailable when `xdotool` is missing.
- Android: `android_start`, `android_install_apk`, `android_launch_app`, `android_screenshot`, `android_tap`, `android_type`, `android_back`, `android_home`, `android_get_ui_tree`, `android_logcat`, `android_run_adb`
- Artifacts: `artifact_list`, `artifact_report`
- Takeover: `takeover_status` — check whether a session is under human control (see [Supervised pause and human takeover](#supervised-pause-and-human-takeover)); read-only, always safe to call
- User: `request_user_input` — ask the human a question (via MCP elicitation when the client supports it) and wait for the answer; never used for secrets

Resources, addressable as `pickforge://` URIs:

- `pickforge://runs` — recorded runs
- `pickforge://runs/{runId}/manifest` — run manifest
- `pickforge://runs/{runId}/screenshots/{name}` — screenshots
- `pickforge://runs/{runId}/logs/{name}` — logs
- `pickforge://runs/{runId}/actions` — sanitized action timeline JSON
- `pickforge://runs/{runId}/report` — static HTML evidence filmstrip
- `pickforge://sessions/{sessionId}/status` — session liveness
  The status includes a read-only viewer endpoint/readiness report when VNC is
  present. MCP never opens a host GUI; only the CLI launches viewer windows.

Prompts: `test-flutter-desktop-visually`, `debug-android-apk`, `run-visual-regression-check`.

## Architecture

A TypeScript monorepo. `pickforge` is the published package; the rest are internal and bundled into it.

| Package | Role |
| --- | --- |
| `packages/core` | Config, sessions, artifacts, manifests, process supervision |
| `packages/desktop-linux` | Xvfb, VNC, window, input, and screenshot automation |
| `packages/android` | AVD, emulator, ADB, UIAutomator, and logcat orchestration |
| `packages/browser` | Isolated Chrome sessions and the session-aware DevTools MCP relay |
| `packages/mcp-server` | MCP tools, resources, and prompts |
| `packages/agent-installers` | Codex, Claude Code, Cursor, Pi, and custom agent registration |
| `packages/cli` | The `pickforge-lab` and `pickforge-mcp` binaries |

## Security model

- MCP tools never invoke sudo. Privileged provisioning happens only through the CLI (`pickforge-lab setup lab-user`, or `init` with explicit `--create-lab-user`), with explicit consent (`--yes` or a prompt).
- Privileged provisioning commands run through graphical `sudo` (`sudo -A`) on Linux, never a plain terminal password prompt: Pickforge detects a graphical session (`WAYLAND_DISPLAY`/`DISPLAY`) and a `SUDO_ASKPASS` helper (your own `SUDO_ASKPASS`, or the first of `ksshaskpass`/`ssh-askpass`/`lxqt-openssh-askpass`/the standard distro paths) before spawning anything privileged, and injects `SUDO_ASKPASS` — the only environment variable this feature ever adds — into that one command. Pickforge never ships, generates, or installs its own askpass helper, and never captures, logs, or persists the password prompt. macOS/Windows are out of scope for this release: no graphical prompt is attempted there. If no graphical session or helper is available (headless, SSH, CI, or a missing helper), or the platform isn't Linux, the command fails closed with an actionable error naming the manual fallback — run the same command yourself with `sudo` in a terminal. A cancelled or denied graphical prompt surfaces as a distinct failure with no automatic retry, and nothing about the prompt is written to logs, config, or run artifacts.
- All user inputs are spawned as argument arrays — never interpolated into shell strings.
- The DevTools relay validates the installed upstream package name, exact version, declared bin, and confined real path before spawning Node with an argument array. Its browser URL is always derived as `http://127.0.0.1:<session-cdp-port>`.
- Relay stdout is protocol-only. A pending JSON-RPC record is capped at 16 MiB. Upstream diagnostic lines are capped at 64 KiB, redacted, and forwarded only to stderr; an over-limit line is dropped with a safe notice. Upstream update checks and usage statistics are disabled.
- VNC binds to loopback only by default: `x11vnc` is started with `-localhost`, so the server listens on `127.0.0.1` and is not reachable from the network. Tunnel over SSH for remote access. Normal `--vnc` and `pickforge-lab watch` observation is server-enforced read-only (`-viewonly`); viewer exit never stops the session or its Xvfb/VNC processes. `--vnc-control` is an explicit, persistent writable escape hatch for human secret entry and does not coordinate with agent input. `pickforge-lab watch --control` is the coordinated alternative: an atomic, TTL-bounded lease gates a temporary writable VNC server, and every agent desktop-input call (including `desktop_launch` and `desktop_exec`, which could otherwise grab input focus on the shared display) and DevTools relay request fails closed (a live human lease is checked immediately before delivery) for as long as it is held. A crash on either side is reclaimed actively — the controlling process force-ends on the first failed lease renewal (never waiting for the viewer to close) and carries a hard deadline timer at the lease's `expiresAt` as a backstop; a detached watchdog process, immune to a `SIGKILL` of its parent, independently polls and stops a stale writable VNC. Writable VNC never outlives its lease in wall-clock terms, on any exit path.
- Artifacts are redacted by default: logcat output strips tokens and secrets before it is stored or returned. Only `android adb` is raw, and it says so.
- Evidence timelines persist only allowlisted metadata; typed values become length/type metadata, and network headers, bodies, and URL queries are dropped. Static HTML reports escape page-controlled text and use a no-script, no-network CSP.
- Screenshot files contain raw pixels and cannot be redacted. Avoid explicit captures on screens containing secrets, and use `evidence.enabled: false` when an action timeline is not appropriate. See [SECURITY.md](SECURITY.md#recorded-evidence-and-screenshots).
- Pickforge provisions a dedicated locked lab user (`pickforge-lab`) and a dedicated AVD (`pickforge-avd`) so lab workloads do not borrow your personal resources. Running session processes under the lab user is planned post-MVP.
- Agent config edits are atomic, with backups of the previous config.

## Development

```sh
bun install
npm run build       # bundle all packages
npm run typecheck
npx vitest run
```

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">
  <a href="https://pickforge.dev">
    <img src="https://raw.githubusercontent.com/pickforge/pickforge/main/assets/brand/pickforge-studio-footer.svg" alt="Pickforge Studio — local-first, open source, built for people who ship" width="560">
  </a>
</p>
