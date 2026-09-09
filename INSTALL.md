# Pickforge agent install guide

You are an AI coding agent, and your user asked you to install and configure Pickforge: a Rust Flutter integration CLI plus a Linux-only lab CLI and MCP server. Linux x86_64 is verified for Xvfb desktop and Android emulator journeys. macOS arm64 supports the Rust integration CLI only, not the lab.

Read the [support matrix](README.md#support-matrix) before setup. Headed browser journeys, React Native, native iOS, Windows lab and unlisted combinations are not verified by the published release evidence.

Follow the steps in order. Verify each one before moving on. Rules:

- Never run sudo without telling the user first what the command does.
- Install globally, not into the project. The MCP entry runs `pickforge-lab` from PATH.
- If a step fails, stop and show the user the real error — do not improvise workarounds.

## 1. Install the CLI globally

```sh
curl -fsSL https://pickforge.dev/install.sh | sh
```

The installer installs the release channel that matches this version of the
docs, then downloads the matching Rust binary from the same `v<version>` GitHub
release and verifies its SHA-256 file. It supports Linux x86_64 and Apple silicon macOS. Other hosts are
unsupported by the published evidence. An installed TypeScript package does not
imply a working lab on that host.

On macOS the Rust binary is ad-hoc signed and not notarized. Installed through
this script it runs normally, because a `curl`/`wget` download carries no
quarantine attribute. If the user downloads the asset with a browser instead,
Gatekeeper blocks the first run: verify the `.sha256` file, then clear the
attribute with `xattr -d com.apple.quarantine ./pickforge-macos-arm64`. See the [signing policy](docs/releases/SIGNING.md).

For the TypeScript lab commands only:

```sh
npm install -g pickforge
```

This does not install the Rust binary. Never install with sudo.

### Prereleases

Use `npm install -g pickforge@next` to opt into the TypeScript prerelease
channel. `@next` is not the stable default. Use the installer above for the
matching Rust and TypeScript release.

Verify all three commands and their versions:

```sh
command -v pickforge && pickforge --version
command -v pickforge-lab && pickforge-lab --version
command -v pickforge-mcp && pickforge-mcp --version
```

If they are not on PATH, the global bin dir (`npm prefix -g`/bin or
`~/.bun/bin`) is missing from PATH. Fix the user's shell profile or tell them.
Do not fall back to a local install.

For a local installer smoke test, point the npm install at a packed tarball and
the Rust download at a directory containing `pickforge-linux-x86_64` or
`pickforge-macos-arm64` plus its same-named `.sha256` file:

```sh
PICKFORGE_INSTALL_FROM_TARBALL=/absolute/path/pickforge-0.4.0-beta.1.tgz \
PICKFORGE_INSTALL_RELEASE_BASE_URL=file:///absolute/path/release-assets \
PICKFORGE_INSTALL_RUNTIME=npm \
sh scripts/install.sh
```

Fatal-error telemetry in the TypeScript CLI and MCP server is disabled by default: no Sentry initialization or telemetry network traffic. Tell the user that only `PICKFORGE_TELEMETRY=1`, `true`, or `on` enables it (case-insensitive; surrounding whitespace ignored). Any other value or unset disables it. When enabled, Sentry receives error messages and stack traces, which can reference the failing command and its output, with secrets redacted, plus OS, Node.js, and app versions. This is not product analytics; breadcrumbs and performance tracing are disabled.

For the 0.4 train, the same values work with legacy `PICKLAB_TELEMETRY` only when `PICKFORGE_TELEMETRY` is unset, with one deprecation warning per process. The current name takes precedence, including when empty.

For one release, old `PICKLAB_*` environment variables still work and print a
deprecation warning to stderr. New TypeScript state goes under
`~/.pickforge/lab/`; existing `~/.pickforge/picklab/` and `~/.picklab/` state
is read in place without silent migration or deletion.

## 2. Initialize the Flutter integration

Inside the user's Flutter project, run the read-only diagnostics before the
transactional integration setup:

```sh
pickforge doctor
pickforge init
```

`init --dry-run` previews every change. `init` configures the official
Dart/Flutter MCP server and the portable Flutter workflow for Claude Code,
Codex, and Pi. It needs `dart` on PATH and refuses to run otherwise; there is no
opt-in flag. Flutter must also be installed. The verified runtime targets are
Flutter Linux desktop on Linux x86_64 and a Flutter macOS fixture on macOS arm64.
Android APK automation is a separate lab surface, not proof of Android Dart MCP
hot reload. Flutter iOS/web, React Native and native iOS are not certified.

On macOS, stop after verifying the Rust integration. Steps 3–7 are Linux lab
setup, not macOS lab instructions.

## 3. Register the lab MCP server with the agent the user uses

Verified harnesses on Linux x86_64:

```sh
pickforge-lab agents install codex          # ~/.codex/config.toml
pickforge-lab agents install claude-code    # Claude Code
pickforge-lab agents install pi             # ~/.config/mcp/mcp.json
```

This registers only the `pickforge-lab` server. Add `--browser` to also
register the `pickforge-lab-browser` DevTools relay; it fails to start until a
browser session exists, so only register it when the user wants browser
automation. Without `--browser`, an existing `pickforge-lab-browser` entry is
left untouched and reported as retained. A migrated legacy `picklab-browser`
registration keeps its browser entry without the flag.

Core Pi has no built-in MCP support, so its config requires
`pi-mcp-adapter`. The adapter reads shared global config from the fixed path
`$HOME/.config/mcp/mcp.json`, ignoring `XDG_CONFIG_HOME`. Both
`pickforge init --harness pi` and `pickforge-lab agents install pi` write there
so the adapter can discover the generated config.

Cursor and other agents remain unverified. A manual stdio registration uses `command: pickforge-lab`, `args: ["mcp", "serve"]`:

```json
{ "mcpServers": { "pickforge-lab": { "command": "pickforge-lab", "args": ["mcp", "serve"] } } }
```

Verify with `pickforge-lab agents list`. The agent must show `registered`.
Registration is not a successful tool call. The generated browser relay needs
a live browser session; the published soak recorded startup failures without
one. No headed-browser journey is certified by these packets.

Important: a running agent session only picks up new MCP servers after a restart. Tell the user the `pickforge-lab` tools appear in the *next* session; don't report failure when they are absent from the current one.

## 4. Install system packages (desktop profiles)

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

For headed browser sessions, also install Chrome or Chromium. This lab surface
is unverified for stable support in the published packets.

For Android profiles the user needs an Android SDK with `cmdline-tools`,
`platform-tools` (ADB), `emulator`, a system image and a dedicated AVD.
`pickforge-lab doctor` prints SDK and environment setup guidance. The passing
beta.1 setup used Linux x86_64, working KVM and an API 37 x86_64 guest with
3072 MiB RAM. Provision that guest RAM to reproduce the tested setup: the 2 GB
guest failed twice, including a confirmed lowmemorykiller kill in the background.
The beta.1 3 GB success is one run, not a portable minimum, host RAM floor or automatic
Pickforge default. `--wait-ready` did not prevent the 2 GB failures. Physical
devices, ARM guests and macOS Android hosting are unverified.

## 5. Initialize the lab project

Ask the user which profile fits the app, then run inside the project:

```sh
pickforge-lab init --profile <flutter-desktop|android|desktop+android|generic> --yes
```

Without `--profile`, init defaults to `generic`; it prompts only before privileged provisioning steps. In agent or other non-interactive contexts, use `--yes`. This writes the project config and plans the provisioning for that profile. Privileged lab-user creation happens only with explicit `--yes --create-lab-user`; it is optional for every profile.

## 6. Provision lab resources

Pickforge can provision two lab resources:

- **Lab user** (`pickforge-lab`, desktop profiles) — optional, created with sudo after explicit user approval. It will isolate desktop sessions once run-as-lab-user isolation ships; sessions currently run as the invoking user. If the user wants it: `pickforge-lab setup lab-user`
- **AVD** (`pickforge-avd`, Android profiles) — dedicated emulator image, no sudo: `pickforge-lab setup android --create-avd`. Pickforge auto-allocates emulator ports from 5556, so the user's own emulator on 5554 is untouched.

In text and `--json` modes, `pickforge-lab doctor` exits 1 when any required
check is `missing` (`ok: false`) or `--fix` fails, and 0 otherwise. Warnings
alone do not fail. Checks describe the state before repairs; rerun doctor
after `--fix` to verify readiness.

`pickforge-lab init` plans the AVD automatically for Android profiles and the lab user only with `--create-lab-user`; `pickforge-lab doctor --fix` offers both.

## 7. Verify everything

```sh
pickforge-lab doctor
```

Checks required by the chosen profile must be `[ok]`. Review `[warn]` entries against the chosen surface: x11vnc is needed for VNC,
and the verified Android setup requires working KVM. The lab user is optional. Then smoke-test a session:

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
unavailable instead of reporting a possible escape. See the [desktop session guidance](README.md#running-development-commands-in-a-desktop-session)
for the session environment and isolation limits.

Finally, remind the user to restart the agent so the `pickforge-lab` MCP tools load, and that `session_status` over MCP is the quickest end-to-end check.

Session logs: desktop, browser and Android logs are retained after teardown; runtime sockets, locks, permits, profiles and temporary data are removed once processes stop. Failed starts keep logs and an error record. There is no automatic pruning. After explicit destroy, use `pickforge-lab session prune --older-than 7d` or `--all-stopped`. Age is measured from successful teardown. Pruning keeps registry-backed sessions, symlinks, unknown data and legacy directories without `stopped.json`.

## Report back

Tell the user: install location and version, which agent config was updated, which system packages were installed or are still missing, whether the AVD and the optional lab user exist, and the doctor result. Keep it short and honest — unresolved `[missing]` checks are not "non-blockers", they are setup the user still has to approve.
