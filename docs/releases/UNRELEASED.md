# Pickforge <version>

<One paragraph on what this release is for.>

## Changes

- Evidence reports now show where the agent clicked, double-clicked,
  scrolled or dragged on desktop captures. The viewer draws the marker from
  the recorded action and never paints it into the PNGs, so screenshots and
  MCP tool responses are unchanged. A hollow ring marks the point, and a line
  joins the start and end of a drag. A dashed marker means the input started
  but did not complete. Markers appear only on the before and after captures
  that an input action took with its `capture` option, and only when
  Pickforge verified the session's own Xvfb before and after the action. The
  Pointer markers switch hides them. Older runs show no markers. The CLI
  `desktop click` and `desktop drag` commands now record evidence actions
  too. (#199)
- Each pointer action now has its own glyph in evidence reports: a ring for a
  click, a double ring for a double click, a line with an arrow for a drag, an
  arrow for the scroll direction, and a box with a caret for the window that
  received typing. The before capture shows what was intended, and the after
  capture adds a dot where pointer input landed. Typing marks only the focused
  window, never a text position; Pickforge records the window's position and
  size, never the text. `desktop_move` takes no captures, so it has no
  glyph. (#200)
- `pickforge-lab artifacts export` writes copies of a run's screenshots with
  the glyphs drawn in, a `pointer-track.json` of pointer events for demo
  videos, and a manifest with hashes, into `exports/` inside the run.
  `--video` adds an ffmpeg slideshow of the frames. Originals are never
  changed, and exports do not count toward the evidence size cap. The pointer
  track holds no keyboard data, and its timing comes from action records, so
  it is approximate. (#200)
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

- Each finalized Lab run stores about 1.33 times its screenshot bytes again in
  `report-share.html`. Rendering near the 256 MiB cap needs roughly 1 GB of memory.
- If rewriting the share report fails when an outcome is recorded on an already
  finalized run, the previous reports stay in place and the error is returned;
  `actions.jsonl` stays authoritative.

- <What this release does not do, and what is not proven yet.>
- Browser lab sessions still send Chrome's activity ping to
  `update.googleapis.com` when a browser session ends. It has a hardcoded URL
  and no switch to disable it. (#139)
