# Pickforge 0.6.0

Pickforge 0.6.0 is for driving native Linux apps on a managed X11 desktop.
New managed desktop sessions get a private home, agents can list and focus
windows, screenshots report the geometry that input coordinates use, waits are
bounded, input tools can save before and after captures, and the device-pass
workflow describes the inspection loop. Desktop teardown no longer fails on
owned symlinks in the private home, and process cleanup no longer confirms a
process it can no longer verify.

## Changes

- New managed desktop sessions default to a fresh `HOME` at
  `<session>/runtime/home`, with the config, data, cache and state XDG home
  directories inside it, all mode `0700`. Nothing is copied from your real
  home. To keep the caller's home instead, create the session with
  `pickforge-lab session create --type desktop --inherit-home` or MCP
  `session_create` with `inheritHome: true`. `session status` reports
  `desktop.homePolicy`, and new evidence manifests record
  `meta.desktopHomePolicy`. Sessions created before this policy report
  `legacy-inherit` and must be recreated before new managed launches or
  takeover; an unknown or corrupt policy also refuses new managed processes.
  Managed VNC always uses private home storage. (#150)
- `pickforge-lab desktop windows` and MCP `desktop_windows` list visible named
  X11 windows with id, redacted name and class, geometry and focus.
  `desktop focus --id <id>` or `--name <exact-name>` (MCP `desktop_focus`)
  takes exactly one selector, matches names literally and refuses duplicate
  names. Focus sets X input focus with a 1-10000 ms timeout; it does not raise
  windows or switch workspaces. Inventory needs `xprop`. (#151)
- Desktop screenshots report display size, captured image size, scale 1 and
  that input coordinates are image pixels, taken from the captured PNG.
  `pickforge-lab desktop wait` and MCP `desktop_wait` poll until pixels differ
  from a baseline PNG, sampled frames stay unchanged, or a window name appears,
  and record `ok` or `timeout`. Baselines are regular files capped at 64 MiB;
  MCP refuses symlink traversal. `desktop_launch` accepts `windowTimeoutMs`.
  (#152)
- MCP `desktop_click`, `desktop_double_click`, `desktop_drag`,
  `desktop_scroll`, `desktop_type`, `desktop_key` and `desktop_focus` accept
  `capture: "after"` or `capture: "both"`. Captures require enabled evidence
  and are saved in the action's run under `screenshots/`. Input is attempted
  at most once and never retried. It is not attempted when a required before
  capture fails or the run is already capped; a cap that drops the attachment
  record is reported as `captureRecording: "capped"`. Capturing does not mark
  images inspected or establish a pass. (#153)
- The device-pass workflow and README describe the native desktop loop:
  screenshot, inspect, act, bounded wait, recapture. Agents take coordinates
  from the current capture, focus a window before typing, treat a black or
  empty capture as a possible escape and report a timeout as a timeout. (#154)

## Fixes

- Pointer moves, clicks, scrolls, drags and double-clicks no longer pass
  `--sync` to `xdotool mousemove`, which could wait forever when the pointer
  was already at the requested coordinates. (#175)
- Desktop session teardown now removes owned symlink leaves, such as the
  Fontconfig cache links LibreOffice writes into the private home, without
  following their targets. Removal of the runtime root checks the directory
  identity it validated and refuses a replaced root, and a root that was
  absent is not adopted if one appears later. Foreign ownership and replaced
  entries are still refused. (#177)
- Containment cleanup no longer reports success while a previously identified
  process is still alive but its `/proc` stat cannot be read. Such a process
  is kept as unconfirmed and is not signalled until its identity can be
  verified again; gone, zombie and reused PIDs are handled as before. (#180)

## Validation

- Before this version change, the native desktop features were exercised on
  managed Xvfb sessions with private homes against CI candidate builds that
  still carried version 0.5.0. That is prior candidate evidence, not
  qualification of a published 0.6.0 package. Form and file chooser journeys
  ran on the #176 candidate (`e20c5ab`, the tree merged as `2881c6e`). LibreOffice
  Writer scroll and drag, focus change, takeover refusal and resume, failed
  actions and SIGINT cancellation were repeated on the repaired candidate
  `8a8d3ba`, whose tree was merged unchanged as `64c6fd4`. Failed-action runs
  recorded `fail`, interrupted and auxiliary runs recorded `partial`, and those
  runs are retained. Writer edits were not saved. An independent image-only
  review assessed 57 preview images.
- The CI run for the merged commit `64c6fd4`
  ([35096758039](https://github.com/pickforge/pickforge/actions/runs/35096758039))
  passed. Device validation and published-package validation of 0.6.0 have not
  run yet.

## Known limits

- Native desktop support covers managed X11 (Xvfb) sessions only. Wayland is
  tracked separately in #155.
- The private home is environment isolation, not an OS, filesystem or network
  sandbox, and not a secret-variable allowlist. Apps can still read and write
  other paths, reach the network and see other inherited variables. Launch only
  apps you trust.
- The inherited-home choice is made when the session is created and cannot be
  changed on a running session. Inherited-home process starts are refused while
  a human lease is live.
- Captured pixels are stored exactly as displayed, including visible typed
  text. They are not OCR-redacted; do not request captures on sensitive
  screens.
- Passive `watch` does not pause agent input. Only `watch --control` holds the
  lease that refuses agent input.
- A wait that ends is a bounded observation, not proof of success. Stability
  compares sampled frames, not every intervening frame, and subprocess cleanup
  can finish up to four seconds after the deadline.
- `PICKFORGE_*` variables take precedence over their `PICKLAB_*` fallbacks,
  including when set to an empty value.
- The macOS asset stays ad-hoc signed, not notarized and without a Developer
  ID, under `docs/releases/SIGNING.md`.
- The cause of the historical CI failure in #179 is still unknown. Cleanup
  failure wording for unverifiable processes is tracked in #181.
