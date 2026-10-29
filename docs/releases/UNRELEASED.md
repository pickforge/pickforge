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

## Validation

- <What was actually run, and where its evidence lives. Nothing aspirational.>

## Known limits

- <What this release does not do, and what is not proven yet.>
