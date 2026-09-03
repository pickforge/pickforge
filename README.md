<p align="center">
  <img src="https://raw.githubusercontent.com/pickforge/picklab/main/assets/brand/picklab-lockup-horizontal.svg" alt="PickLab" width="560">
</p>

# PickLab

Playwright for native apps and Android emulators. PickLab gives AI coding agents eyes, hands, and a reproducible lab: desktop sessions on Xvfb, Android emulators on a dedicated AVD, screenshots, input, logs, and run artifacts — over a CLI and an MCP server.

PickForge builds the app. PickLab lets agents see, run, and test it. PickArena measures the results.

Local-first. Open source. Built for people who ship.

## Install

Let your coding agent do the whole setup — paste this into its prompt:

```text
Install and configure PickLab by following https://raw.githubusercontent.com/pickforge/picklab/main/INSTALL.md
```

Or install by hand:

```sh
curl -fsSL https://pickforge.dev/picklab/install.sh | sh
```

Or without installing:

```sh
npx -y @pickforge/picklab doctor
bunx @pickforge/picklab doctor
```

Or globally:

```sh
npm install -g @pickforge/picklab
bun add -g @pickforge/picklab
```

This ships two binaries: `picklab` (CLI) and `picklab-mcp` (MCP stdio server). The installer never uses sudo.

The Chrome DevTools relay requires Node.js `^20.19.0`, `^22.12.0`, or `>=23.0.0`.

## Quickstart

```sh
cd your-app
picklab init --profile desktop+android   # write project config and provision the AVD (lab user is opt-in: --create-lab-user)
picklab doctor                           # verify dependencies; --fix repairs what it can
picklab session create --type desktop+android
picklab desktop launch ./build/your-app
picklab watch                              # attach a read-only host viewer
picklab desktop screenshot
picklab android install-apk build/app-release.apk
picklab android launch-app com.example.app
picklab android screenshot
picklab artifacts report                 # render the latest run
picklab session destroy --all
```

Every screenshot, log, and action lands in a run directory with a manifest, so a run is inspectable and reproducible after the fact. By default that run directory lives outside your project — see [Run storage](#run-storage) below.

### Running development commands in a desktop session

Use `desktop exec` for commands that build and start their own GUI process, such
as Flutter. It starts a separate process group with `WAYLAND_DISPLAY` pointed
at the non-existent `picklab-no-wayland` socket, removes other inherited
`WAYLAND_*` variables, and sets X11 backend hints for GTK, Qt, SDL, and winit.
The poison value matters because libwayland falls back to `wayland-0` when
`WAYLAND_DISPLAY` is unset. PickLab then waits up to 30 seconds for a client
window on the lab display:

```sh
picklab desktop exec --session <id> -- flutter run -d linux
# For a slower first build:
picklab desktop exec --session <id> --window-timeout 120000 -- flutter run -d linux
```

If no client window appears while the command is still alive, PickLab reports
that the app may have escaped to the real desktop instead of leaving a silent
black frame. `desktop launch` uses the same isolated environment and remains
the shorter path for an already-built app.

When a shell or another parent process must launch the app itself, apply the
same environment first:

```sh
eval "$(picklab desktop env --session <id>)"
flutter run -d linux
```

`desktop env --json` returns the same `exports`, `unset`, and `script` recipe
without including unrelated environment variables or secrets. Desktop
screenshots report the visible client-window count and warn when it is zero.

### Run storage

By default, run artifacts (screenshots, logs, manifests, evidence journals)
are written under the shared Pickforge company root, **not** inside your
project — a default screenshot or run never shows up in `git status`:

```text
~/.pickforge/picklab/projects/<projectId>/runs/<runId>/
```

`<projectId>` is a stable id derived from the project's canonical (symlink-resolved)
path: the same project always resolves to the same id, and different projects
never collide. Use the platform home-directory equivalent on non-Linux systems.
`PICKLAB_HOME` overrides the PickLab home root (default `~/.pickforge/picklab`);
`picklab doctor` reports the resolved path.

Two other modes are available via `storage` in the **global** config or the
`PICKLAB_STORAGE_MODE` / `PICKLAB_STORAGE_PATH` environment overrides for
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

**`custom` cannot be selected from project-level `.picklab/config.json`.**
That file is repo-committed and travels with `git clone`; honoring a
`custom` selection from it would let a cloned repository silently redirect
run artifacts (screenshots, which may carry secrets) to any absolute path
with no prompt. Only the user-owned global config or an env override may
select `custom`. A project config that requests `custom` is ignored — the
resolver falls back to global config's mode, then `home` — and `picklab
doctor` surfaces the rejected request as a warning.

`.picklab/config.json` itself always stays project-local regardless of
`storage` mode — only generated runtime artifacts move.

**Upgrading from an earlier version:** existing runs already written under a
project's `.picklab/runs/` remain discoverable by `artifact_list` /
`artifact_report` / MCP resources without any migration step — nothing is
moved or deleted. Likewise, an existing `~/.picklab` global config, agent
state, or session registry (the previous default PickLab home) is still read
as a non-destructive fallback if the new `~/.pickforge/picklab` default has
nothing yet; `picklab doctor` flags a detected legacy home.

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
PickLab does not take implicit screenshots for input actions. Explicit
screenshot tools still capture the screen exactly as displayed.

The journal and associated artifacts have a 100 MiB recording threshold per
run. The record that crosses the threshold may exceed it; PickLab then writes a
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
picklab watch --session <id> --control   # pause the agent, take a temporary writable viewer
picklab takeover status --session <id>   # check whether a session is under human control
```

`picklab watch --control` pauses PickLab-managed agent input for a session,
grants a temporary writable VNC viewer for a human, and hands control back
with a fresh screenshot and an evidence record once the viewer closes (or the
terminal is interrupted). Unlike `--vnc-control`'s persistent writable
session, control here is leased: while a human holds it, every desktop input
tool (`desktop_click`/`move`/`scroll`/`drag`/`double_click`/`type`/`key`),
`desktop_launch`/`desktop_exec` (a newly launched client could otherwise grab
input focus), and every DevTools relay request fail closed with a stable busy
error —
`takeover_status` (MCP) / `picklab takeover status` (CLI) let an agent check
before retrying, and `request_user_input` is the recommended way to ask a
human to run it. `desktop_screenshot` is the only desktop tool left ungated
(read-only).

The lease is a 30-second TTL, heartbeat-renewed-every-5-seconds record in the
session's state directory. Closing the viewer, an interrupted terminal, or a
PickLab crash all release it and revert VNC to read-only. A crash of the
`watch --control` process itself is reclaimed *actively*, not only the next
time something else happens to touch the session: a detached watchdog
process, spawned alongside the takeover and immune to a `SIGKILL` of its
parent, polls the lease and stops a stale writable VNC on its own — writable
VNC does not survive its lease going stale, whichever side crashes.

### Concurrent sessions

Each session gets its own isolated display or emulator, so several agents and projects can run labs side by side. When a command or tool is called without an explicit session id, the default resolves per project: only running sessions created for the same project directory are considered. Pass `session` ids (CLI: `--session <id>`) to target a specific lab, including one belonging to another project.

`picklab browser devtools-mcp` is intentionally stricter: it always resolves exactly one live browser session for the current project. It does not accept a session id, browser URL, or WebSocket endpoint.

<p align="center">
  <img src="https://raw.githubusercontent.com/pickforge/picklab/main/assets/brand/picklab-run-lab-mock.svg" alt="PICKLAB · RUN LAB — desktop session, Android emulator, live screenshots, logs, and agent terminal" width="900">
</p>

## Telemetry

When the `picklab` CLI or `picklab-mcp` server hits a fatal error, it reports the error message and stack trace — the message can reference the failing command and its output, with secrets redacted — plus OS, Node.js, and app versions to Sentry so we can fix it. Nothing else is collected. Disable with `PICKLAB_TELEMETRY=0`.

## MCP setup for agents

Register the MCP server with your coding agent:

```sh
picklab agents install claude-code   # also: codex, cursor
picklab agents list
picklab agents doctor
```

For any other agent, add the stdio server yourself:

```json
{
  "mcpServers": {
    "picklab": {
      "command": "picklab",
      "args": ["mcp", "serve"]
    },
    "picklab-browser": {
      "command": "picklab",
      "args": ["browser", "devtools-mcp"]
    }
  }
}
```

`picklab-browser` is static. Each invocation discovers the one live browser session for the agent's project and derives its loopback CDP URL in memory, so recreating a session never requires an agent config edit. The relay runs the bundled, exact `chrome-devtools-mcp@1.5.0`; it does not use `npx` or connect to a personal browser.

Custom agents can be stored under the PickLab home's `agents/` dir (default
`~/.pickforge/picklab/agents`, override via `PICKLAB_HOME`):

```sh
picklab agents add --name my-agent --mcp-command "picklab mcp serve"
```

## CLI reference

| Group | Commands |
| --- | --- |
| Setup | `doctor`, `init`, `setup lab-user`, `setup android` |
| Sessions | `session create`, `session status [id]`, `session destroy <id\|--all>` |
| Watch | `watch [--session <id>] [--control]` |
| Takeover | `takeover status [--session <id>]` |
| Desktop | `desktop launch <cmd>`, `desktop exec <cmd>`, `desktop env`, `desktop screenshot`, `desktop click <x> <y>`, `desktop move <x> <y>`, `desktop scroll <deltaX> <deltaY>`, `desktop drag <fromX> <fromY> <toX> <toY>`, `desktop double-click <x> <y>`, `desktop type <text>`, `desktop key <keys>` |
| Android | `android start`, `android install-apk <apk>`, `android launch-app <pkg>`, `android screenshot`, `android tap <x> <y>`, `android type <text>`, `android back`, `android home`, `android ui-tree`, `android logcat`, `android adb [args...]` |
| Artifacts | `artifacts list`, `artifacts open <runId>`, `artifacts report [runId]` |
| Agents | `agents list`, `agents install <agent>`, `agents link <agent>`, `agents unlink <agent>`, `agents doctor`, `agents add` |
| Browser | `browser devtools-mcp` |
| MCP | `mcp serve` |

Session types: `desktop` (Xvfb, optional VNC), `android` (emulator on the dedicated AVD), `desktop+android`, and `browser` (isolated headed Chrome with loopback CDP). Most commands accept `--json` for machine-readable output and `--project-dir` to target another project.

`session create --vnc` is read-only. `--vnc-control` creates an explicitly writable VNC session up front and does not coordinate with agent input — pause agent activity yourself while using it. For a coordinated, leased handoff instead, use `picklab watch --control` (see [Supervised pause and human takeover](#supervised-pause-and-human-takeover)), which fails agent input closed for the lease's duration and hands back a fresh screenshot automatically.

Scroll deltas are integer wheel steps: positive `deltaY` scrolls down, negative up; positive `deltaX` scrolls right, negative left (put negative values after `--`, e.g. `picklab desktop scroll -- 0 -3`). `desktop scroll` accepts `--at <x,y>` to position the pointer first; `desktop drag` accepts `--button` and `--duration <ms>`; `desktop double-click` accepts `--button` and `--interval <ms>`.
`picklab watch [--session <id>]` attaches a normal host-side VNC window to an
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
PickLab opens nothing and prints the loopback endpoint, install guidance, and
an SSH tunnel command instead.
Explicit `picklab watch` waits until the viewer closes and fails if the client
exits nonzero or on a signal, while leaving the session and VNC running.
Automatic or `session create --viewer` launch returns as soon as the client
starts, so the viewer never owns or delays session creation. A requested attach
failure is reported alongside the successfully created session. `--viewer` and
`--vnc-control` are rejected together before creation; `viewer.mode: "auto"` is
reported as suppressed for an explicitly writable `--vnc-control` session.

## MCP surface

`picklab mcp serve` exposes 28 tools over stdio:

- Sessions: `session_create`, `session_status`, `session_destroy`
- Desktop: `desktop_launch`, `desktop_exec`, `desktop_screenshot`, `desktop_click`, `desktop_move`, `desktop_scroll`, `desktop_drag`, `desktop_double_click`, `desktop_type`, `desktop_key` — all fail closed with a busy error while a human lease is active except `desktop_screenshot` (read-only). `desktop_launch` and `desktop_exec` are gated too: a newly launched client can grab input focus on the shared display, which is exactly what the lease protects against. `desktop_exec` applies the isolated X11 environment and waits for a client window; `desktop_screenshot` reports the client-window count and warns when it is zero.
- Android: `android_start`, `android_install_apk`, `android_launch_app`, `android_screenshot`, `android_tap`, `android_type`, `android_back`, `android_home`, `android_get_ui_tree`, `android_logcat`, `android_run_adb`
- Artifacts: `artifact_list`, `artifact_report`
- Takeover: `takeover_status` — check whether a session is under human control (see [Supervised pause and human takeover](#supervised-pause-and-human-takeover)); read-only, always safe to call
- User: `request_user_input` — ask the human a question (via MCP elicitation when the client supports it) and wait for the answer; never used for secrets

Resources, addressable as `picklab://` URIs:

- `picklab://runs` — recorded runs
- `picklab://runs/{runId}/manifest` — run manifest
- `picklab://runs/{runId}/screenshots/{name}` — screenshots
- `picklab://runs/{runId}/logs/{name}` — logs
- `picklab://runs/{runId}/actions` — sanitized action timeline JSON
- `picklab://runs/{runId}/report` — static HTML evidence filmstrip
- `picklab://sessions/{sessionId}/status` — session liveness
  The status includes a read-only viewer endpoint/readiness report when VNC is
  present. MCP never opens a host GUI; only the CLI launches viewer windows.

Prompts: `test-flutter-desktop-visually`, `debug-android-apk`, `run-visual-regression-check`.

## Architecture

A TypeScript monorepo. `@pickforge/picklab` is the published package; the rest are internal and bundled into it.

| Package | Role |
| --- | --- |
| `packages/core` | Config, sessions, artifacts, manifests, process supervision |
| `packages/desktop-linux` | Xvfb, VNC, window, input, and screenshot automation |
| `packages/android` | AVD, emulator, ADB, UIAutomator, and logcat orchestration |
| `packages/browser` | Isolated Chrome sessions and the session-aware DevTools MCP relay |
| `packages/mcp-server` | MCP tools, resources, and prompts |
| `packages/agent-installers` | Codex, Claude Code, Cursor, and custom agent registration |
| `packages/cli` | The `picklab` and `picklab-mcp` binaries |

## Security model

- MCP tools never invoke sudo. Privileged provisioning happens only through the CLI (`picklab setup lab-user`, or `init` with explicit `--create-lab-user`), with explicit consent (`--yes` or a prompt).
- Privileged provisioning commands run through graphical `sudo` (`sudo -A`) on Linux, never a plain terminal password prompt: PickLab detects a graphical session (`WAYLAND_DISPLAY`/`DISPLAY`) and a `SUDO_ASKPASS` helper (your own `SUDO_ASKPASS`, or the first of `ksshaskpass`/`ssh-askpass`/`lxqt-openssh-askpass`/the standard distro paths) before spawning anything privileged, and injects `SUDO_ASKPASS` — the only environment variable this feature ever adds — into that one command. PickLab never ships, generates, or installs its own askpass helper, and never captures, logs, or persists the password prompt. macOS/Windows are out of scope for this release: no graphical prompt is attempted there. If no graphical session or helper is available (headless, SSH, CI, or a missing helper), or the platform isn't Linux, the command fails closed with an actionable error naming the manual fallback — run the same command yourself with `sudo` in a terminal. A cancelled or denied graphical prompt surfaces as a distinct failure with no automatic retry, and nothing about the prompt is written to logs, config, or run artifacts.
- All user inputs are spawned as argument arrays — never interpolated into shell strings.
- The DevTools relay validates the installed upstream package name, exact version, declared bin, and confined real path before spawning Node with an argument array. Its browser URL is always derived as `http://127.0.0.1:<session-cdp-port>`.
- Relay stdout is protocol-only. A pending JSON-RPC record is capped at 16 MiB. Upstream diagnostic lines are capped at 64 KiB, redacted, and forwarded only to stderr; an over-limit line is dropped with a safe notice. Upstream update checks and usage statistics are disabled.
- VNC binds to loopback only by default: `x11vnc` is started with `-localhost`, so the server listens on `127.0.0.1` and is not reachable from the network. Tunnel over SSH for remote access. Normal `--vnc` and `picklab watch` observation is server-enforced read-only (`-viewonly`); viewer exit never stops the session or its Xvfb/VNC processes. `--vnc-control` is an explicit, persistent writable escape hatch for human secret entry and does not coordinate with agent input. `picklab watch --control` is the coordinated alternative: an atomic, TTL-bounded lease gates a temporary writable VNC server, and every agent desktop-input call (including `desktop_launch` and `desktop_exec`, which could otherwise grab input focus on the shared display) and DevTools relay request fails closed (a live human lease is checked immediately before delivery) for as long as it is held. A crash on either side is reclaimed actively — the controlling process force-ends on the first failed lease renewal (never waiting for the viewer to close) and carries a hard deadline timer at the lease's `expiresAt` as a backstop; a detached watchdog process, immune to a `SIGKILL` of its parent, independently polls and stops a stale writable VNC. Writable VNC never outlives its lease in wall-clock terms, on any exit path.
- Artifacts are redacted by default: logcat output strips tokens and secrets before it is stored or returned. Only `android adb` is raw, and it says so.
- Evidence timelines persist only allowlisted metadata; typed values become length/type metadata, and network headers, bodies, and URL queries are dropped. Static HTML reports escape page-controlled text and use a no-script, no-network CSP.
- Screenshot files contain raw pixels and cannot be redacted. Avoid explicit captures on screens containing secrets, and use `evidence.enabled: false` when an action timeline is not appropriate. See [SECURITY.md](SECURITY.md#recorded-evidence-and-screenshots).
- PickLab provisions a dedicated locked lab user (`picklab-lab`) and a dedicated AVD (`picklab-avd`) so lab workloads do not borrow your personal resources. Running session processes under the lab user is planned post-MVP.
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
    <img src="https://raw.githubusercontent.com/pickforge/picklab/main/assets/brand/pickforge-studio-footer.svg" alt="Pickforge Studio — local-first, open source, built for people who ship" width="560">
  </a>
</p>
