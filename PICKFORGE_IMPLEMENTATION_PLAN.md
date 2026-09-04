# Pickforge Implementation Plan

## Summary

Pickforge gives AI coding agents eyes, hands, and a reproducible lab for native apps.

Positioning:

- Product name: Pickforge
- Tagline: Playwright for native apps and Android emulators.
- Strategic line: Pickforge builds the app. Pickforge lets agents see, run, and test it. PickArena measures the results.
- MVP scope: Linux desktop sessions plus Android emulator automation.
- Primary stack: TypeScript monorepo with Node-compatible CLI/MCP packages and Bun-friendly development.

## Architecture

- [x] Create a TypeScript monorepo in the Pickforge repo.
- [x] Add `packages/cli` for the `pickforge-lab` command.
- [x] Add `packages/mcp-server` for `pickforge-mcp` and `pickforge-lab mcp serve`.
- [x] Add `packages/core` for config, sessions, artifacts, manifests, and process supervision.
- [x] Add `packages/desktop-linux` for Xvfb/VNC/window/input/screenshot automation.
- [x] Add `packages/android` for AVD, emulator, ADB, UIAutomator, screenshot, and logcat orchestration.
- [x] Add `packages/agent-installers` for Codex, Claude Code, Cursor, Pi, and custom agent registration.
- [x] Publish package as `pickforge`, exposing `pickforge-lab` and `pickforge-mcp` binaries.
- [x] Use `$PICKFORGE_HOME` when set, otherwise default to `~/.pickforge/lab`.
- [x] Fall back from `PICKFORGE_*` to deprecated `PICKLAB_*` variables with one warning per process.
- [x] Read earlier `~/.pickforge/picklab` and `~/.picklab` state in place without migrating or deleting it.
- [x] Store project config in `.picklab/config.json`.
- [x] Store run artifacts in `.picklab/runs/<timestamp>-<slug>/`.

## Provisioning Model

Pickforge should own stable, isolated lab identities instead of borrowing random local resources.

- [x] During `pickforge-lab init`, prompt to create missing dedicated resources.
- [x] During `pickforge-lab doctor`, detect and repair missing dedicated resources.
- [x] Ensure MCP tools never create privileged system resources implicitly.
- [x] Add non-interactive mode with `--yes --create-lab-user --create-avd`.
- [x] Make non-interactive provisioning fail closed when required permissions or dependencies are missing.

### Dedicated Android Emulator

- Default AVD name: `pickforge-avd`

- [x] Add `pickforge-lab setup android --create-avd pickforge-avd`.
- [x] Detect Android SDK location.
- [x] Detect `sdkmanager`, `avdmanager`, `emulator`, and `adb`.
- [x] Detect available Android system images.
- [x] Detect hardware acceleration support.
- [x] Create `pickforge-avd` when dependencies are available and the user approves.
- [x] If a system image is missing, print the exact `sdkmanager` command required.
- [x] Persist the selected AVD name in Pickforge config.
- [x] Use `pickforge-avd` by default for Android sessions.

### Dedicated Linux Lab User

- Default user: `pickforge-lab`
- Default home: `/var/lib/pickforge/lab-home`
- User type: locked service user, no password, no login shell, no sudo.

- [x] Add `pickforge-lab setup lab-user --name pickforge-lab`.
- [x] Detect whether `pickforge-lab` already exists.
- [x] Create the user only after explicit prompt or `--yes`.
- [x] Create `/var/lib/pickforge/lab-home` with restrictive ownership and permissions.
- [x] Assign only required runtime groups after detection, such as `kvm`.
- [ ] Run desktop lab processes as `pickforge-lab`. (Deferred post-MVP: requires a privileged runtime path. MCP tools must never invoke sudo, and CLI-side uid switching needs a consented privileged design. Provisioning of the user is implemented.)
- [x] Prevent MCP tools from invoking sudo or creating users.
- [x] Persist the selected lab username and home path in Pickforge config.

## CLI Interface

- [x] Implement `pickforge-lab doctor`.
- [x] Implement `pickforge-lab init --profile flutter-desktop|android|desktop+android|generic`.
- [x] Implement `pickforge-lab setup lab-user --name pickforge-lab`.
- [x] Implement `pickforge-lab setup android --create-avd pickforge-avd`.
- [x] Implement `pickforge-lab session create --type desktop|android|desktop+android`.
- [x] Implement `pickforge-lab session status`.
- [x] Implement `pickforge-lab session destroy`.
- [x] Implement `pickforge-lab desktop launch`.
- [x] Implement `pickforge-lab desktop screenshot`.
- [x] Implement `pickforge-lab desktop click`.
- [x] Implement `pickforge-lab desktop type`.
- [x] Implement `pickforge-lab desktop key`.
- [x] Implement `pickforge-lab android start`.
- [x] Implement `pickforge-lab android install-apk`.
- [x] Implement `pickforge-lab android launch-app`.
- [x] Implement `pickforge-lab android screenshot`.
- [x] Implement `pickforge-lab android tap`.
- [x] Implement `pickforge-lab android type`.
- [x] Implement `pickforge-lab android back`.
- [x] Implement `pickforge-lab android home`.
- [x] Implement `pickforge-lab android ui-tree`.
- [x] Implement `pickforge-lab android logcat`.
- [x] Implement `pickforge-lab android adb`.
- [x] Implement `pickforge-lab artifacts list`.
- [x] Implement `pickforge-lab artifacts open`.
- [x] Implement `pickforge-lab artifacts report`.
- [x] Implement `pickforge-lab mcp serve`.
- [x] Implement `pickforge-lab agents list`.
- [x] Implement `pickforge-lab agents install`.
- [x] Implement `pickforge-lab agents link`.
- [x] Implement `pickforge-lab agents unlink`.
- [x] Implement `pickforge-lab agents doctor`.

## MCP Interface

MCP is the primary agent interface. Skills and prompts help the agent use Pickforge well, but they do not replace the execution engine.

- [x] Expose MCP tools with JSON schemas matching the CLI behavior.
- [x] Add `session_create`.
- [x] Add `session_status`.
- [x] Add `session_destroy`.
- [x] Add `desktop_launch`.
- [x] Add `desktop_screenshot`.
- [x] Add `desktop_click`.
- [x] Add `desktop_type`.
- [x] Add `desktop_key`.
- [x] Add `android_start`.
- [x] Add `android_install_apk`.
- [x] Add `android_launch_app`.
- [x] Add `android_screenshot`.
- [x] Add `android_tap`.
- [x] Add `android_type`.
- [x] Add `android_back`.
- [x] Add `android_home`.
- [x] Add `android_get_ui_tree`.
- [x] Add `android_logcat`.
- [x] Add `android_run_adb`.
- [x] Add `artifact_list`.
- [x] Add `artifact_report`.
- [x] Expose `pickforge://runs`.
- [x] Expose `pickforge://runs/{runId}/manifest`.
- [x] Expose `pickforge://runs/{runId}/screenshots/{name}.png`.
- [x] Expose `pickforge://runs/{runId}/logs/{name}`.
- [x] Expose `pickforge://sessions/{sessionId}/status`.
- [x] Add prompt `test-flutter-desktop-visually`.
- [x] Add prompt `debug-android-apk`.
- [x] Add prompt `run-visual-regression-check`.

## Installer + Agent Integration

- [x] Support `curl -fsSL https://pickforge.dev/install.sh | sh`.
- [x] Support `npx --yes --package pickforge pickforge-lab init`.
- [x] Support `bunx --package pickforge pickforge-lab init`.
- [x] Create shared agent config under `~/.pickforge/lab/agents/`.
- [x] Generate MCP config snippets using `pickforge-lab mcp serve`.
- [x] Symlink or register Codex config when possible.
- [x] Symlink or register Claude Code config when possible.
- [x] Symlink or register Cursor config when possible.
- [x] Register Pi MCP config when possible.
- [x] Support custom agents with `pickforge-lab agents add --name <name> --mcp-command "pickforge-lab mcp serve"`.
- [x] Back up existing agent config before modifying it.
- [x] Add `pickforge-lab agents doctor` checks for broken symlinks and stale config.

## Branding

Brand source of truth: `/home/dev/Projects/Pickforge/branding-visual/`.

- [x] Follow the Pickforge dark/ember visual system.
- [x] Create a Pickforge mark: 128x128 rounded square, dark surface, off-white brackets, one ember dot, restrained lab/viewport glyph.
- [x] Create `pickforge-mark-128.svg`.
- [x] Create `pickforge-app-icon.svg`.
- [x] Create `pickforge-favicon.svg`.
- [x] Create `pickforge-lockup-horizontal.svg`.
- [x] Create `pickforge-og-image.svg`.
- [x] Export required PNG and ICO variants.
- [x] Add README header visual using Pickforge assets.
- [x] Write README with install and usage first.
- [x] Avoid README badges and emojis.
- [x] Add a visual mock titled `PICKFORGE · RUN LAB`.
- [x] Show desktop session, Android emulator, live screenshots, logs, and agent terminal in the mock.

## Testing

- [x] Add unit tests for config loading and precedence.
- [x] Add unit tests for provisioning plans.
- [x] Add unit tests for command argument building.
- [x] Add unit tests for run manifest writing.
- [x] Add unit tests for MCP schemas.
- [x] Add dry-run tests for `pickforge-lab init`.
- [x] Add dry-run tests for `pickforge-lab doctor`.
- [x] Add dry-run tests for `pickforge-lab setup lab-user`.
- [x] Add dry-run tests for `pickforge-lab setup android`.
- [x] Add Linux integration test that runs an Xvfb desktop session.
- [x] Add Linux integration test that launches a tiny GUI app.
- [x] Add Linux integration test for click, type, screenshot, and report output.
- [x] Add Android integration test that creates or reuses `pickforge-avd`.
- [x] Add Android integration test for boot, screenshot, tap, UI tree, and logcat.
- [x] Add installer tests for `npx`.
- [x] Add installer tests for `bunx`.
- [x] Add installer tests for global home creation.
- [x] Add installer tests for symlink behavior.
- [x] Add installer tests for non-interactive fail-closed behavior.
- [x] Add security tests proving MCP tools do not invoke sudo.
- [x] Add security tests proving user inputs are spawned as argument arrays, not shell strings.
- [x] Add security tests proving artifacts do not contain secrets by default.

## Assumptions

- [x] MVP remains Linux + Android only.
- [x] Desktop MVP targets X11/Xvfb first.
- [x] Wayland-native support is post-MVP.
- [x] macOS support is post-MVP.
- [x] Windows support is post-MVP.
- [x] Pickforge orchestrates installed Android SDK/emulator tools and does not bundle them.
- [x] Dedicated resources use `pickforge-lab` and `pickforge-avd` by default.
- [x] The installer may prompt for privileged setup, but MCP tools must not perform privileged setup.
