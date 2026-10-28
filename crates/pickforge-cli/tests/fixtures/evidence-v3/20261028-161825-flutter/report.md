# Flutter evidence: Counter increments and keeps state after hot reload

**Outcome:** passed

## Before

Counter was zero with the old theme.

- **Counter:** 0

## Step: Clicks complete

Counter reached two before reload.

- **Counter:** 2

### Artifacts

- None

## After

The new theme appeared and counter stayed at two.

- **Counter:** 2

## Source changes

- lib/main.dart

## Checks

- **desktop click** (Passed; step: Clicks complete): Counter advanced to two.
- **flutter test** (Passed): Focused tests passed.

## Artifacts

- [Initial frame](artifacts/before-initial-frame-a874ead9968c.png) (4x8, 74 bytes, `a874ead9968c10c86189afd3395889c28225240ba5a299e0953983a77470c6aa`)
- [Reloaded frame](artifacts/after-reloaded-frame-fdb14ef3ce60.png) (4x8, 73 bytes, `fdb14ef3ce6054588fb486f85ae7d5fa2fb43cec60e7b44eb4c9e640d3d71a25`)

## Limitations

- Pixel review was manual.
