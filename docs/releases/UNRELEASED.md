# Pickforge <version>

<One paragraph on what this release is for.>

## Changes

- `pickforge-lab doctor` now exits 1 when required checks are missing, in text and JSON modes. Warnings alone still exit 0, and failed repairs still exit 1. Checks reflect the state before `--fix`; rerun doctor after repairs. The Rust `pickforge doctor` is unchanged.

## Validation

- <What was actually run, and where its evidence lives. Nothing aspirational.>

## Known limits

- <What this release does not do, and what is not proven yet.>
