# Pickforge <version>

<One paragraph on what this release is for.>

## Changes

- Lab evidence finalization now writes `report-share.html` alongside the linked
  `report.html`. Download and open the share report in a browser, or ZIP the
  single file if a channel blocks HTML attachments. Original PNGs are embedded
  once per content hash at full resolution. Limits are 32 MiB per image and
  256 MiB total; excluded files are listed. Large runs produce large files.
  CLI and MCP artifact reports expose its path and byte size. The MCP report
  resource still serves the linked viewer. (#186)

- The MCP prompt `preview-flutter-component` walks an agent through rendering
  one Flutter widget without the full app, auth, routing or backend. Give it
  the widget and, optionally, states and viewports. It uses the Flutter Widget
  Previewer when the SDK has one, a temporary widget-test harness for exact
  sizes, and a temporary web entrypoint only as a fallback. The widget-test
  harness always runs the text scaling, semantics and overflow checks.
  Captures default to 390, 768 and 1440 logical pixels, and previews are
  viewed in a Pickforge browser session. Generated files are removed
  afterwards, and production routing, app startup and golden baselines are
  left alone. (#43)
- The published CLI now carries Sentry debug IDs, so fatal reports from
  opted-in telemetry can resolve to source wherever the package is
  installed. (#140)
- Browser lab sessions send less traffic to Google. Chrome's network time
  queries, Safe Browsing real-time lookups, AI Mode eligibility check and
  startup search preconnect are off. Browser sign-in polling and the on-device
  model update check now go to an unusable loopback address. Chrome therefore
  no longer treats `accounts.google.com` as its own sign-in page; pages can
  still sign in to Google as ordinary websites. The
  `scripts/lab/chrome-egress-check.mjs` release check now closes Chrome and
  cleans up correctly, exits 0 on a successful capture and observes for 120
  seconds. (#139)

## Validation

- <What was actually run, and where its evidence lives. Nothing aspirational.>

## Known limits

- <What this release does not do, and what is not proven yet.>
- Browser lab sessions still send Chrome's activity ping to
  `update.googleapis.com` when a browser session ends. It has a hardcoded URL
  and no switch to disable it. (#139)
