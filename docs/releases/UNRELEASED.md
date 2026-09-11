# Pickforge 0.5.0

Pickforge 0.5.0 turns a device pass into evidence you can open and judge. A
finalized run now ships a self-contained report viewer, agents get a bundled
device-pass workflow that ends in an explicit acceptance outcome, and artifact
commands expose the report path, outcome and device of every run. Browser
session runs now record their browser build and platform, and concurrent
evidence recovery reports a run consistently when a peer recovers it first.

## Changes

- The finalized evidence `report.html` is now a viewer: run and device summary,
  an acceptance outcome banner that says plainly when nothing was recorded,
  device and scenario filters, a full-size capture inspection view, and text
  search. Filters, inspection and navigation work with scripts blocked;
  text search and arrow-key browsing come from one inline script, pinned in
  the report CSP by hash.
- Runs record the session's device metadata when it is known, and explicit
  acceptance outcomes are appended to the run journal with the new MCP
  `evidence_outcome` tool or `pickforge-lab artifacts outcome`. Pass is refused
  without a successful interaction and an inspected screenshot, and on an
  orphaned or failed run; partial requires an inspected screenshot.
- A bundled device-pass workflow: the MCP `device_pass` prompt (required
  `scenario`, optional `revision` and `device`) and a shared `device-pass.md`
  written by `pickforge-lab agents install` and `agents link`. The MCP server
  instructions point agents at both. No harness skills are registered
  automatically, and a device pass does not approve a merge.
- `pickforge-lab artifacts report --json` and MCP `artifact_report` return
  `reportPath`, `outcome` and `device`; text reports end with the report path or
  `Report: not finalized yet`. Run listings and `pickforge://runs` include the
  latest outcome status.
- Runs written by `pickforge evidence record` appear read-only in
  `pickforge-lab artifacts list`, `artifact_report` and `pickforge://runs` with
  `source: "rust"`, summarized with a pointer to their existing `report.md`.
- Evidence runs from a browser session now record the browser build and the
  host platform, so the report viewer shows them instead of "unknown". Values
  that cannot be read stay absent; desktop-only runs are unchanged.
- Listing artifact runs now finds each run's latest outcome by reading the end
  of its action journal instead of parsing every line, so only the last 1 MiB
  of a journal decides the outcome a listing shows.
- The `PICKLAB_*` environment compatibility fallbacks and their deprecation
  warning are retained for 0.5.0 with no new removal date; `PICKFORGE_*` names
  still take precedence. The macOS asset stays ad-hoc signed, un-notarized and
  Developer ID-free under the policy in `docs/releases/SIGNING.md`.

## Fixes

- Concurrent evidence recovery no longer reports a run as an invalid manifest
  when a peer replaced `manifest.json` while it was being read; recovery
  re-reads the manifest under the run's journal lock, and the run is reported
  consistently with the peer's result. Hard-linked, symlinked and special-file
  manifests are still refused.
- The Markdown run report no longer leaves gaps in step numbers, or inflates
  the action count, when an acceptance outcome is recorded mid-run.
- The lab test suite no longer depends on timing for concurrent recovery,
  emulator start and VNC readiness, and the Android emulator port tests pass
  on a machine that is running a real emulator.

## Validation

- Prior-revision evidence, not proof for this candidate: at `f23b9fe`, which
  holds the viewer, device metadata, outcome recording and device-pass workflow
  but none of the later changes above, three device passes were driven through
  the MCP server against isolated scratch state. A Flutter counter on a virtual
  X desktop, the viewer's search, capture inspection and arrow-key navigation
  in a lab browser session, and a Flutter release APK counter on an API 37
  x86_64 emulator each recorded a `pass` outcome after the saved screenshots
  were inspected, and a separate reviewer judged each set of screenshots as
  supporting its outcome.
- The later changes (browser metadata, journal tail lookup, report step
  numbering and the recovery fix) have automated coverage in the lab test suite
  and no device pass of their own at that revision.
- The official release device pass for this candidate has not been run yet.

## Known limits

- The prior-revision passes used virtual X sessions and an emulator only. No
  physical hardware or mobile emulation was exercised, and only the desktop
  run's report was rendered in a browser, over loopback HTTP rather than
  `file://`.
- The viewer's search clear control, device and scenario filters, and the
  Actual size, Open original and Close controls were rendered but not clicked
  in those passes.
- Device scale factor and touch support are not recorded for desktop or
  browser runs, and the viewer shows them as unknown. Browser session runs keep
  the desktop device kind and are counted under Desktop.
- `report.html` is written when a run is finalized, by `session_destroy`, by
  reaping a dead session, or by explicit orphan recovery; `reportPath` is null
  until then.
- Arrow-key browsing acts only while a capture inspection view is open and
  focus is outside the search box.
- Rust evidence runs carry their result in `status` and always list `outcome`
  as null; no HTML viewer is generated for them.
- The lab remains Linux-only. Symbolicated stack traces for fatal-error
  telemetry (#140) remain unverified; their verification is pending for the
  next release.
