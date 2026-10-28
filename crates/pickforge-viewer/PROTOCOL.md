# pickforge-viewer host protocol

`pickforge-viewer` shows one lab session in a native window. A TypeScript viewer
host starts it as a child process and talks to it over stdio. This file is the
contract between the two sides. #340 implements the watch-only part. #341 adds
the control messages marked as reserved below.

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
- `--xvfb-pid` and `--xvfb-start-ticks` identify the Xvfb process. The viewer
  treats a different start time in `/proc/<pid>/stat` as session end.
- `--width` and `--height` are the session size in pixels.
- `--class` is the Wayland `app_id` and the X11 `WM_CLASS` instance and class.
- `--thumbnail-width` is the thumbnail width in logical pixels.
- `--placement host` means the host moves and resizes the window through the
  compositor, so the viewer asks before it changes size. `--placement self`
  means the viewer resizes itself and reports the result.
- The window itself uses the caller's environment (`WAYLAND_DISPLAY` or
  `DISPLAY`). The session display is used only for capture and, in #341, input.

Other entry points:

- `pickforge-viewer --version` prints `pickforge-viewer <version>` and exits 0.
- `pickforge-viewer --self-test` runs headless checks that need no display
  (scaler goldens, protocol framing) and exits 0 on success.

Exit codes: 0 after `closed`, `shutdown`, or stdin end of file; 2 for invalid
arguments; 3 when the session display cannot be opened or is refused; 4 when no
host window system is available.

## Framing

- stdin carries commands from the host. stdout carries events to the host.
- Each message is one JSON object on one line, UTF-8, at most 64 KiB.
- stderr carries human-readable logs only. It never carries frames, message
  text from #341, or input.
- Each side ignores unknown fields. An unknown `cmd` or `event` is logged and
  ignored.
- End of file on stdin means the host is gone. The viewer then exits within one
  second.

## Events (viewer to host)

| Event | Fields | Meaning |
| --- | --- | --- |
| `ready` | `version`, `pid`, `backend` (`"wayland"` or `"x11"`), `scale` | The window is mapped and the first frame is drawn. |
| `mode` | `mode` (`"thumbnail"`, `"expanded"`, `"fullscreen"`) | The window changed mode. |
| `expandRequested` | none | The user clicked the thumbnail. Sent only with `--placement host`. |
| `collapseRequested` | none | The user chose Collapse or pressed Esc in watch mode. Sent only with `--placement host`. |
| `closed` | none | The user closed the window. The viewer exits after this event. |
| `sessionEnded` | `reason` (`"x11-eof"` or `"xvfb-gone"`) | The viewer saw the session end. It keeps the last frame and shows "Session ended". |
| `error` | `code`, `message` | A fatal error. The viewer exits after this event. |

Reserved for #341: `takeRequested`, `returnRequested`, and
`controlAck` with `leaseId` and `state`.

## Commands (host to viewer)

| Command | Fields | Meaning |
| --- | --- | --- |
| `setMode` | `mode` (`"thumbnail"` or `"expanded"`), optional `width`, `height` in logical pixels | The host placed the window. The viewer requests that inner size and updates its layout. |
| `status` | `code` (`"connecting"`, `"sessionEnded"`, `"stopping"`) | Show this status text. |
| `sessionEnded` | none | The host saw the session end. Same display as the event. |
| `shutdown` | none | Exit cleanly. |

Reserved for #341: `attention` with `message`, `clearAttention`, and `control`
with either `state: "granted"`, `leaseId`, `grantMs`, or `state: "revoked"`,
`reason`.

## Window behavior

- Thumbnail: `--thumbnail-width` logical pixels wide, session aspect ratio, no
  controls. A click expands the window and is never forwarded.
- Expanded: a 32 logical pixel bar at the top with Fullscreen, Collapse and
  Close. Close sends `closed`. Esc collapses in watch mode.
- Fullscreen: the viewer handles it itself and reports `mode`. Esc or the
  Fullscreen button leaves it.
- Status text sits in the bottom-left corner: "Connecting", "Session ended",
  "Stopping".
- The viewer never takes keyboard focus on its own.
