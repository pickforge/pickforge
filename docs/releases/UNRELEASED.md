# Pickforge <version>

<One paragraph on what this release is for.>

## Changes

- Desktop pointer input and key presses now verify that the display is still the session's own Xvfb before they send anything, as typing already did. If another X server took the display number, the action is refused and recorded as not attempted. (#219)
- The MCP input tool descriptions and the README now say that an after capture can precede the app's redraw, and show how to wait for the change with `desktop_wait`. (#223)
- Viewer window placement on Hyprland also works with a hyprlang config, on Hyprland 0.53 and later. (#228)
- `session prune` removes the input closure and takeover identity markers of a destroyed session one day after its teardown. Until then they keep the id reserved, so late input for that session still fails. (#317)
- Each viewer shows its session id and project folder name in the window title and on the thumbnail, so two open viewers are easy to tell apart. (#367)
- The native viewer shows a short ember ring where an agent click or double click lands, so you can see each click happen. The ring is drawn only in the viewer window; session pixels and screenshots do not change. (#368)
- During human control, the native viewer's Paste button types up to 4096 characters of host clipboard text into the session, without logging it or putting it on the session clipboard. (#366)
- Desktop pointer input refuses a point outside the session's live screen before it sends anything. Before, X moved such a point to the edge or wrapped values above 32767, so the click landed somewhere else. (#424)
- `desktop move`, `scroll`, `double-click`, `key` and `type` in the CLI now record evidence, as `click`, `drag` and the MCP tools already did. Typed text and key names never enter evidence. (#409)
- A session record that is not a regular file, such as a FIFO, is refused with an error instead of blocking input. (#410)
- The native viewer draws text that its embedded font lacks, such as CJK, Arabic, Hebrew or Thai, with a host font. Right-to-left text reads in the right order. (#421)
- The native viewer keeps a combining mark with its character when it wraps or shortens text. A mark that no font draws with its character shows as an ellipsis, not a box. (#438, #439)
- On Wayland compositors without data-control, such as GNOME, the native viewer's Paste button now reads the clipboard through the viewer window. (#426)
- New session ids have 16 hex characters, so a new session does not reuse a pruned id. Sessions with older 8-character ids still work. The native viewer now also opens when the Pickforge home path is long. (#413, #376)
- `session prune` now also removes a session directory left without `stopped.json`, a `permits/` folder left in a retained directory, and takeover identity staging files that a killed process left. (#414, #434, #431)
- The browser DevTools relay refuses a call once its session has ended or its browser was replaced, so a call cannot reach another Chrome on the old debugging port. When it cannot check the session, it refuses only that call. (#444)
- The native viewer spaces a long word evenly. Before, a long word in the attention banner showed an empty column about every 31 letters. (#450)
- Two `session prune` runs at the same time no longer make the slower one fail. Each pruned session is reported once. (#453)
- Session teardown now waits for DevTools relay calls in flight before it stops Chrome. The relay ends those calls with the session-ended error and exits. (#454)
- An Android session start no longer refuses an AVD as in use when its lock names a process that only mentions an emulator in its arguments, such as an editor or a test runner. (#458)
- `session prune` no longer removes a retained session file that was replaced after prune checked it. It reports an error and keeps the file and its directory. (#463)
- A Pickforge command that pauses while another one publishes the layout marker no longer refuses the marker as a hard link. (#468)
- Browser sessions serve DevTools through a pipe and a private Unix socket instead of a loopback TCP port, so other local processes can no longer find it on a port. Session output no longer shows `cdpPort`. Only one DevTools relay can attach to a session at a time. Recreate browser sessions made by an older version to use the relay. (#459)

## Validation

- <What was actually run, and where its evidence lives. Nothing aspirational.>

## Known limits

- <What this release does not do, and what is not proven yet.>
