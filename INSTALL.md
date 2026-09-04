# Pickforge agent install guide

You are an AI coding agent, and your user asked you to install and configure Pickforge: a CLI + MCP server that gives you a reproducible lab for native desktop apps (Xvfb) and Android emulators — screenshots, input, logs, and run artifacts. Linux only for now.

Follow the steps in order. Verify each one before moving on. Rules:

- Never run sudo without telling the user first what the command does.
- Install globally, not into the project. The MCP entry runs `pickforge-lab` from PATH.
- If a step fails, stop and show the user the real error — do not improvise workarounds.

## 1. Install the CLI globally

```sh
curl -fsSL https://pickforge.dev/install.sh | sh
```

Or directly: `npm install -g pickforge` (needs Node >= 20) or `bun add -g pickforge`. Never with sudo.

Verify:

```sh
command -v pickforge-lab && pickforge-lab --version
```

If `pickforge-lab` is not on PATH, the global bin dir (`npm prefix -g`/bin or `~/.bun/bin`) is missing from PATH — fix the user's shell profile or tell them, don't fall back to a local install.

On fatal errors the CLI and MCP server report the error message and stack trace — the message can reference the failing command and its output, with secrets redacted — plus OS, Node.js, and app versions to Sentry; nothing else is collected. Tell the user they can disable this with `PICKFORGE_TELEMETRY=0`.

For one release, old `PICKLAB_*` environment variables still work and print a
deprecation warning to stderr. New TypeScript state goes under
`~/.pickforge/lab/`; existing `~/.pickforge/picklab/` and `~/.picklab/` state
is read in place without silent migration or deletion.

## 2. Register the MCP server with the agent the user uses

That is probably you. Built-in support:

```sh
pickforge-lab agents install codex          # ~/.codex/config.toml
pickforge-lab agents install claude-code    # Claude Code
pickforge-lab agents install cursor         # Cursor
pickforge-lab agents install pi             # ~/.config/mcp/mcp.json
```

Core Pi has no built-in MCP support, so its config requires
`pi-mcp-adapter`.

Any other agent gets a stdio server with `command: pickforge-lab`, `args: ["mcp", "serve"]`:

```json
{ "mcpServers": { "pickforge-lab": { "command": "pickforge-lab", "args": ["mcp", "serve"] } } }
```

Verify with `pickforge-lab agents list` — the agent must show `registered`.

Important: a running agent session only picks up new MCP servers after a restart. Tell the user the `pickforge-lab` tools appear in the *next* session; don't report failure when they are absent from the current one.

## 3. Install system packages (desktop profiles)

Check what is missing:

```sh
pickforge-lab doctor
```

For desktop sessions Pickforge needs `Xvfb`, `xdotool`, and one screenshot path: `import` from ImageMagick, `scrot`, or `xwd` plus `convert`. `x11vnc` is optional but recommended — it lets the user watch lab sessions live. These come from the distro package manager and need sudo, so show the user the command and ask before running it:

| Distro | Command |
| --- | --- |
| Debian/Ubuntu | `sudo apt install xvfb xdotool imagemagick x11vnc` |
| Arch | `sudo pacman -S --needed xorg-server-xvfb xdotool imagemagick x11vnc` |
| Fedora | `sudo dnf install xorg-x11-server-Xvfb xdotool ImageMagick x11vnc` |

For Android profiles the user needs an Android SDK with `cmdline-tools`, `platform-tools`, `emulator`, and a system image. `pickforge-lab doctor` prints exact `sdkmanager` commands for missing SDK pieces, and exact `export` commands when the SDK root is unset.

## 4. Initialize the project

Ask the user which profile fits the app, then run inside the project:

```sh
pickforge-lab init --profile <flutter-desktop|android|desktop+android|generic> --yes
```

Without `--profile`, init defaults to `generic`; it prompts only before privileged provisioning steps. In agent or other non-interactive contexts, use `--yes`. This writes the project config and plans the provisioning for that profile. Privileged lab-user creation happens only with explicit `--yes --create-lab-user`; it is optional for every profile.

## 5. Provision lab resources

Pickforge can provision two lab resources:

- **Lab user** (`pickforge-lab`, desktop profiles) — optional, created with sudo after explicit user approval. It will isolate desktop sessions once run-as-lab-user isolation ships; sessions currently run as the invoking user. If the user wants it: `pickforge-lab setup lab-user`
- **AVD** (`pickforge-avd`, Android profiles) — dedicated emulator image, no sudo: `pickforge-lab setup android --create-avd`. Pickforge auto-allocates emulator ports from 5556, so the user's own emulator on 5554 is untouched.

`pickforge-lab init` plans the AVD automatically for Android profiles and the lab user only with `--create-lab-user`; `pickforge-lab doctor --fix` offers both.

## 6. Verify everything

```sh
pickforge-lab doctor
```

Checks required by the chosen profile must be `[ok]`. `[warn]` entries are acceptable for optional items like x11vnc, KVM, and the lab user. Then smoke-test a session:

```sh
pickforge-lab session create --type desktop   # or android / desktop+android
pickforge-lab session status
pickforge-lab desktop screenshot
pickforge-lab session destroy --all
```

For a desktop development runner that launches its own GUI, do not set only
`DISPLAY`. Use the session environment so `WAYLAND_DISPLAY` points at the
non-existent `pickforge-no-wayland` socket, other inherited `WAYLAND_*` variables
are removed, and Electron, GLFW, GTK, Qt, SDL, winit, and the session type use
X11. The poison value is required
because libwayland falls back to `wayland-0` when `WAYLAND_DISPLAY` is unset:

```sh
pickforge-lab desktop exec --session <id> -- flutter run -d linux
# Or, when the current shell must be the parent:
eval "$(pickforge-lab desktop env --session <id>)"
flutter run -d linux
```

`desktop exec` waits a bounded time for a client window. If none appears while
the command is alive, it stops the process group and reports a possible
real-desktop escape. Increase `--window-timeout` for a slow first build. Desktop
screenshots also report the client-window count and warn when it is zero. If
`xdotool` is missing, capture still succeeds and warns that the count is
unavailable instead of reporting a possible escape. XDG runtime and D-Bus
isolation for desktop sessions is tracked in
[#86](https://github.com/pickforge/pickforge/issues/86).

Finally, remind the user to restart the agent so the `pickforge-lab` MCP tools load, and that `session_status` over MCP is the quickest end-to-end check.

## Report back

Tell the user: install location and version, which agent config was updated, which system packages were installed or are still missing, whether the AVD and the optional lab user exist, and the doctor result. Keep it short and honest — unresolved `[missing]` checks are not "non-blockers", they are setup the user still has to approve.
