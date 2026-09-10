# Pickforge <version>

<One paragraph on what this release is for.>

## Changes

- The finalized evidence `report.html` is now a viewer: run and device summary,
  an acceptance outcome banner that says plainly when nothing was recorded,
  device and scenario filters, a full-size capture inspection view, and text
  search. Filters, inspection and navigation work with scripts blocked;
  text search and arrow-key browsing come from one inline script, pinned in
  the report CSP by hash.
- Evidence runs from a browser session now record the browser build and the
  host platform, so the report viewer shows them instead of "unknown". Values
  that cannot be read stay absent; desktop-only runs are unchanged.
- Listing artifact runs now finds each run's latest outcome by reading the end
  of its action journal instead of parsing every line, so only the last 1 MiB
  of a journal decides the outcome a listing shows.

## Validation

- <What was actually run, and where its evidence lives. Nothing aspirational.>

## Known limits

- <What this release does not do, and what is not proven yet.>
