# Pickforge <version>

<One paragraph on what this release is for.>

## Changes

- Lint now runs oxlint as the primary gate (`bun run lint`) with the same complexity, max-depth, and max-lines-per-function limits as the previous ESLint config. ESLint is no longer a dependency.
- `pickforge-lab agents install` and `agents link` now register only the `pickforge-lab` MCP server by default. Pass `--browser` to also register the browser DevTools relay, which cannot start until a browser session exists. Existing browser entries, including migrated legacy `picklab-browser` registrations, are retained and reported.
- Browser labs redirect GCM transports to an unusable loopback endpoint and disable Web Push/notifications, component updates, phishing checks, reliability reporting, server-backed autofill and Optimization Guide features in addition to existing background-networking and sync controls. Sessions can still reach the network. Added launch-argument tests and a separate 90-second Chrome NetLog check script; real-browser egress acceptance remains pending. Refs #112.
- Desktop, browser and Android teardown now retains session logs consistently while removing runtime data and permits. Failed starts retain diagnostics. `pickforge-lab session prune --older-than 7d` or `--all-stopped` explicitly removes eligible retained logs; nothing is pruned automatically.
- `pickforge-lab doctor` now exits 1 when required checks are missing, in text and JSON modes. Warnings alone still exit 0, and failed repairs still exit 1. Checks reflect the state before `--fix`; rerun doctor after repairs. The Rust `pickforge doctor` is unchanged.
- TypeScript CLI and MCP fatal-error telemetry is now disabled by default, with no Sentry initialization or telemetry traffic. Opt in with `PICKFORGE_TELEMETRY=1`, `true`, or `on` (case-insensitive; surrounding whitespace ignored); all other values or unset disable it. Enabled reports send redacted error messages and stacks, which may include command output, plus OS, Node.js, and app versions, not product analytics. For 0.4, legacy `PICKLAB_TELEMETRY` remains a fallback when the current name is unset, with one deprecation warning per process.

## Validation

- <What was actually run, and where its evidence lives. Nothing aspirational.>

## Known limits

- <What this release does not do, and what is not proven yet.>
