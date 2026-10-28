# pickforge-viewer host protocol

`pickforge-viewer` shows one lab session in a native window. A TypeScript viewer
host starts it as a child process and talks to it over stdio. This file is the
contract between the two sides. #340 implements watching. #341 adds taking
control: the control messages below and input to the session display.

## Launch

```sh
pickforge-viewer \
  --display :N \
  --xvfb-pid P \
  --xvfb-start-ticks T \
  --width W --height H \
  --class pickforge-viewer-<launchId> \
  --thumbnail-width 384 \
  --placement host|self
```

- `--display` is the session's owned Xvfb display. The host verifies it before
  launch. The viewer refuses a display equal to its own `DISPLAY`.
- The viewer connects through `/tmp/.X11-unix/X<N>` with empty authorization. It
  never reads `XAUTHORITY` or `~/.Xauthority`.
- `--xvfb-pid` and `--xvfb-start-ticks` identify the Xvfb process. A different
  start time at launch is refused with exit 3 and error code `xvfb-mismatch`.
  A change after launch is treated as session end.
- `--width` and `--height` are the session size in pixels.
- `--class` is the Wayland `app_id` and the X11 `WM_CLASS` instance and class.
- `--thumbnail-width` is the thumbnail width in logical pixels.
- `--placement host` means the host moves and resizes the window through the
  compositor, so the viewer asks before it changes size. `--placement self`
  means the viewer resizes itself and reports the result. The default is
  `self`.
- `--thumbnail-width` defaults to 384. All other flags are required.
- The window itself uses the caller's environment (`WAYLAND_DISPLAY` or
  `DISPLAY`). The session display is used only for capture and input.

Other entry points:

- `pickforge-viewer --version` prints `pickforge-viewer <version>` and exits 0.
- `pickforge-viewer --self-test` runs headless checks that need no display
  (scaler goldens, protocol framing) and exits 0 on success.

Exit codes: 0 after `closed`, `shutdown`, or stdin end of file; 1 for an
internal or event loop failure after an `error` event; 2 for invalid
arguments; 3 when the session display cannot be opened or is refused; 4 when no
host window system is available or the window cannot be created.

Error codes in the `error` event: `display-refused`, `xvfb-mismatch`,
`display-open`, `no-window-system`, `window`, `event-loop`, `internal`.

## Framing

- stdin carries commands from the host. stdout carries events to the host.
- Each message is one JSON object on one line, UTF-8, at most 64 KiB.
- stderr carries human-readable logs only. It never carries frames, attention
  message text, or input.
- Each side ignores unknown fields. An unknown `cmd` or `event` is logged and
  ignored.
- End of file on stdin means the host is gone. The viewer then exits within one
  second.

## Events (viewer to host)

| Event | Fields | Meaning |
| --- | --- | --- |
| `ready` | `version`, `pid`, `backend` (`"wayland"` or `"x11"`), `scale` | The window is mapped and the first frame is drawn. |
| `mode` | `mode` (`"thumbnail"`, `"expanded"`, `"fullscreen"`) | The window changed mode, including after a host `setMode` that changed it. |
| `expandRequested` | none | The user clicked the thumbnail. Sent only with `--placement host`. |
| `collapseRequested` | none | The user chose Collapse or pressed Esc in watch mode. Sent only with `--placement host`. |
| `closed` | none | The user closed the window. The viewer exits after this event. |
| `sessionEnded` | `reason` (`"x11-eof"` or `"xvfb-gone"`) | The viewer saw the session end. It keeps the last frame and shows "Session ended". |
| `error` | `code`, `message` | A fatal error. The viewer exits after this event. |
| `takeRequested` | none | The user pressed Take control in the bar or the attention banner. Never sent while a grant is live. A second press within 10 s of an unanswered request sends nothing. |
| `returnRequested` | `reason` (`"button"` or `"closed"`) | The user pressed Return control, or closed the window while holding control. Sent after the viewer released every held key and button. With `"closed"`, the viewer then sends `closed` and exits. |
| `controlAck` | `leaseId`, `state` (`"granted"` or `"revoked"`) | The viewer applied a `control` command. For `"revoked"` it is sent after the release of held input, with the command's `leaseId`, which is empty for `"unavailable"`. |

## Commands (host to viewer)

| Command | Fields | Meaning |
| --- | --- | --- |
| `setMode` | `mode` (`"thumbnail"` or `"expanded"`), optional `width`, `height` in logical pixels | The host placed the window. The viewer requests that inner size and updates its layout. The viewer drops a `setMode` that arrives before `ready`, so the host waits for `ready`. |
| `status` | `code` (`"connecting"`, `"sessionEnded"`, `"stopping"`) | Show this status text. "Connecting" clears when the first frame is drawn. "Stopping" and "Session ended" stay. |
| `sessionEnded` | none | The host saw the session end. Same display as the event. |
| `shutdown` | none | Exit cleanly. Held input is released first. |
| `attention` | `message` | Show a banner with the message and a highlighted Take control button. It changes neither mode nor focus. The viewer refuses a message over 500 characters or with control characters. |
| `clearAttention` | none | Remove the banner. |
| `pulse` | `x`, `y` | An agent click completed at this session pixel. The viewer draws a short ember ring there, only in its own window. It ignores a point outside the session, a pulse while the human holds control and a pulse after the session ended. `x` and `y` are integers from 0 to 32767. |
| `control` | `state: "granted"`, `leaseId`, `grantMs` | Input is allowed until now plus `grantMs` on a monotonic clock. Each renewal re-sends it with the same `leaseId` and extends the grant. The viewer clears the banner. A grant in thumbnail mode expands the window as a thumbnail click does. `leaseId` is 1 to 128 bytes without control characters. `grantMs` is a positive integer; a value over 120000 counts as 120000. The viewer ignores a grant after the session ended or when it cannot send input. |
| `control` | `state: "revoked"`, `leaseId`, `reason` (`"returned"`, `"lease-lost"`, `"session-ended"`, `"stopping"`, `"unavailable"`) | Release all held input, stop forwarding, acknowledge, and show the watch bar. `"unavailable"` answers a `takeRequested` that the host could not grant, with an empty `leaseId`. A revoke with a missing or unknown field still revokes. |

## Control

- No socket and no other channel can grant control or inject input. Only the
  host's `control` command grants it. The host grants control after a
  `takeRequested`, or at startup of `pickforge-lab watch --control`, where
  the user asked for control explicitly. The viewer does not check this.
- The viewer sends input through XTEST on its own connection to the session
  display, and only while a grant is live and the window is expanded or
  fullscreen. Without XTEST or XKB the viewer stays watch only and offers no
  Take control.
- The viewer stops input on its own when a grant expires without renewal, on
  stdin end of file, on `shutdown`, on session end, and on close. Each time it
  releases every key and button it holds. Focus loss and a change to thumbnail
  release held input too, but keep control.
- The host sends a revoke when it loses the lease, waits at most 1 s for
  `controlAck`, and otherwise kills the viewer.

## Window behavior

- Thumbnail: `--thumbnail-width` logical pixels wide, session aspect ratio, no
  controls. A click expands the window and is never forwarded, even while
  controlling.
- Expanded: a 32 logical pixel bar at the top with Fullscreen, Collapse and
  Close, and Take control at the left when control is offered. Close sends
  `closed`. Esc collapses in watch mode.
- Controlling: the bar shows only Return control at the left and Fullscreen
  at the right, with an ember line under it. Every key, Esc too, goes to the
  session, so Esc neither collapses nor leaves fullscreen. Closing the window
  through the compositor returns control first. Pointer positions map through
  the current scale and letterbox; clicks on the bar or the letterbox stay in
  the viewer. A button pressed in the image is released in the session
  wherever the pointer is let go. Text comes from the host's composed key text
  and IME commits, so dead keys and input methods work in any host layout.
- Attention banner: at the top of the image, below the bar. The message wraps
  to at most three lines and ends with an ellipsis when it is longer. The
  thumbnail shows the message without the button, because a thumbnail click
  only expands. The banner hides while controlling.
- Click pulse: a ring that grows from 4 to 20 logical pixels and fades out
  in 500 ms, mapped through the current scale and letterbox and clipped to
  the image. It shows in every mode. A new pulse replaces the running one.
- Fullscreen: the viewer handles it itself and reports `mode`. Esc or the
  Fullscreen button leaves it.
- Status text sits in the bottom-left corner: "Connecting", "Session ended",
  "Stopping". "Control unavailable" after a revoke with `"unavailable"`, and
  "Control ended" after `"lease-lost"` or an expired grant, show for 4 s
  unless a host status is shown.
- The viewer never takes keyboard focus on its own. Esc works once the
  compositor focuses the window, for example after a click.
- Capture pauses while the window is occluded or minimized. Wayland reports no
  occlusion to winit, so there the viewer pauses when a redraw waits more than
  500 ms for a frame callback, and resumes with a full fetch.
