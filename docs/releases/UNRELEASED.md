# Pickforge <version>

<One paragraph on what this release is for.>

## Changes

- `pickforge-lab doctor` now exits 1 when required checks are missing, in text and JSON modes. Warnings alone still exit 0, and failed repairs still exit 1. Checks reflect the state before `--fix`; rerun doctor after repairs. The Rust `pickforge doctor` is unchanged.
- TypeScript CLI and MCP fatal-error telemetry is now disabled by default, with no Sentry initialization or telemetry traffic. Opt in with `PICKFORGE_TELEMETRY=1`, `true`, or `on` (case-insensitive; surrounding whitespace ignored); all other values or unset disable it. Enabled reports send redacted error messages and stacks, which may include command output, plus OS, Node.js, and app versions, not product analytics. For 0.4, legacy `PICKLAB_TELEMETRY` remains a fallback when the current name is unset, with one deprecation warning per process.

## Validation

- <What was actually run, and where its evidence lives. Nothing aspirational.>

## Known limits

- <What this release does not do, and what is not proven yet.>
