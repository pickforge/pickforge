# Pickforge <version>

<One paragraph on what this release is for.>

## Changes

- The finalized evidence `report.html` is now a viewer: run and device summary,
  an acceptance outcome banner that says plainly when nothing was recorded,
  device and scenario filters, a full-size capture inspection view, and text
  search. Filters, inspection and navigation work with scripts blocked;
  text search and arrow-key browsing come from one inline script, pinned in
  the report CSP by hash.
- Listing artifact runs now finds each run's latest outcome by reading the end
  of its action journal instead of parsing every line, so only the last 1 MiB
  of a journal decides the outcome a listing shows.

## Fixes

- Concurrent evidence recovery no longer reports a run as an invalid manifest
  when a peer replaced `manifest.json` while it was being read; the read is
  retried, and the run is reported consistently with the peer's result.

## Validation

- <What was actually run, and where its evidence lives. Nothing aspirational.>

## Known limits

- <What this release does not do, and what is not proven yet.>
