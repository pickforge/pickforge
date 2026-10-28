# Flutter evidence: Sign in stays labelled after unfolding

**Outcome:** passed

## Before

Folded phone in dark mode.

### Capture

- **Captured at:** 2026-10-28T15:59:00Z
- **App build:** 1.4.0+42
- **Emulator:** 35.2.10
- **System image:** system-images;android-35;google\_apis;x86\_64
- **Requested:** foldState folded, darkMode true
- **Observed:** displayMode unknown, foldState folded, posture unknown, rotation 0, density 420, fontScale 1.0, darkMode true, locale en-US

## After

Unfolded tablet posture.

### Capture

- **Captured at:** 2026-10-28T16:00:00Z
- **App build:** 1.4.0+42
- **Emulator:** unknown
- **System image:** unknown
- **Requested:** foldState flat, posture open
- **Observed:** displayMode unknown, foldState flat, posture unknown, rotation 90, density unknown, fontScale unknown, darkMode unknown, locale unknown

## Source changes

- None

## Checks

- **labels** (Passed): Every tappable control has a label.

## Artifacts

- [UI tree](artifacts/before-ui-tree-7ddbcdc4b028.txt) (tree from android-ui-tree, xml, captured at 2026-10-28T15:59:01Z, 204 bytes, `7ddbcdc4b0281f282ef2f0bdf739d6cbb9e4efc78ecaf46935cf0e1ea1f38c6b`)
- [Logcat](artifacts/before-logcat-921da56f023f.txt) (log from android-logcat, text, captured at 2026-10-28T15:59:02Z, 80 bytes, `921da56f023f5c928a417346efe0f08dac03555ef3222ff42c7be637637e1ddb`)
- [Unfolded](artifacts/after-unfolded-fdb14ef3ce60.png) (4x8, 73 bytes, `fdb14ef3ce6054588fb486f85ae7d5fa2fb43cec60e7b44eb4c9e640d3d71a25`)
- [Lighthouse](artifacts/after-lighthouse-2dc745debb1a.txt) (report from lighthouse, html, captured at 2026-10-28T16:00:05Z, 124 bytes, `2dc745debb1a1daf252d1b1dbe11802c4e9c60a87682e82c2a6ce01eec6303ce`)
- Desktop tree (tree from atspi-tree): unavailable, AT-SPI capture lands with \#359

## Limitations

- Emulator only.
