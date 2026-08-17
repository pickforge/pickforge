# Unreleased

Working draft for the next PickLab release. Use this to polish the generated
GitHub release description, then reset it after the release is published.

## User-facing changes

- None yet.

## Internal/release changes

- Raised vulnerable npm override and lockfile resolutions for `brace-expansion`,
  `fast-uri`, `hono`, `ip-address`, and `nanoid` to their patched releases.

## Validation

### Tested

- Pinned Bun 1.3.12: frozen install, typecheck, lint, and build pass.
- The pinned OSV Scanner v2.3.8 image reports no unfiltered advisories.
- Local suite: 1,082 tests pass and 44 skip. Eight existing desktop CLI tests
  cannot run because this machine lacks Xvfb, x11vnc, xdotool, and xterm.

### Not tested yet

- Full desktop suite with CI's X11 dependencies.

### Release blockers

- None known; CI must confirm the desktop suite and dependency audit.
