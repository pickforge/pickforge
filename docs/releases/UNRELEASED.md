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
- The report viewer's `<meta>` CSP no longer carries `frame-ancestors`, which
  browsers ignore in meta-delivered policies and Chrome reported as a console
  error when the report was viewed over HTTP. All other directives are
  unchanged; anti-framing was never enforceable that way.
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
- The official release device pass for this candidate ran at revision
  [`54e56a2`](https://github.com/pickforge/pickforge/commit/54e56a25c373d05ffbe9e65f619c8b133de71858)
  (tree `b52060ba4c10e9e64a9daf8bf00f84df2cb89869`) in an isolated
  Linux environment with a private HOME, XDG, adb, AVD and cache layout, over a real long-lived MCP transport,
  not CLI simulation or a host desktop session. A tool-enabled executor drove
  a desktop counter from 0 to 1 to 2, made an intended Dart theme and label
  edit, hot reloaded the running app with a genuine lowercase-r reload, and
  showed the counter's 2 preserved before it reached 3. Viewer search and
  clear, every device and scenario filter with its result counts, capture
  inspection, arrow-key navigation, Actual size, Open original and Close, and
  the same report over loopback HTTP and over `file://` were exercised, along
  with recorded browser metadata and session indexes. An Android emulator
  counter was driven from 0 to 1 to 2 through MCP. The recorded screenshots
  passed an independent visual review with an explicit `PASS` on 37 initial
  and 18 focused frames, and the 743 execution evidence files were
  checksum-verified and archived.
- A nonpublishing release workflow run
  ([34641866591](https://github.com/pickforge/pickforge/actions/runs/34641866591))
  for this candidate succeeded with publishing explicitly skipped. The npm
  tarball, Linux binary and macOS binary it built have sha256 `f60ef7367ad66efd80e29285377f6cf5b7f562bac384194018480272a427f707`,
  `8c415ce38b657f9d59f905dd3a7486c694d9d0027fbaa7c9bed5ab6dc79d1589` and
  `7c8091c45d50f70a9f327fe62c320a927aab2cd20b52d75ba702ef513ab6b1bb`; the
  artifact sidecars and the executed Linux and macOS candidate smokes match
  those hashes, and both Rust binaries are byte-identical to the previous
  candidate build. The CSP console error over HTTP is gone; a disposable
  static server's favicon 404s over loopback remain.

## Known limits

- The device pass used a virtual Linux desktop, Chrome 153.0.8010.36 on
  Linux, and an Android emulator. No physical Android device and no macOS or
  Windows GUI was exercised. This is observed journey coverage, not universal
  correctness. The Android pass reused an authorized synthetic fallback APK
  because Java/Gradle 25.0.3 prevented building a fresh fixture; no system
  Java or Android SDK setting was changed.
- The visual review judged saved frames. Static frames show visual states,
  not click or key events, and do not prove console cleanliness, DOM counts,
  network receipts or host isolation.
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
- The release pass ran under a predeclared host audit with a separate
  baseline per phase. The full recheck covered 72216 entries and they were
  unchanged. The later focused supplement had its own baseline of the same
  72216 entries, which were unchanged, plus one added session-cue bookkeeping
  file whose writer could not be identified. Source assessment identifies it
  as agent reminder state, not settings or policy. This is not a claim that
  the entire home was unchanged; the original audit result and its
  predeclared exclusions stand.
- The pass's terminal run hit a harness stdout-line cap after its evidence
  was saved, so that run's exit status is failed; the saved files were
  independently verified and are what the visual review judged.
- The lab remains Linux-only. Symbolicated stack traces for fatal-error
  telemetry (#140) remain unverified; their verification is pending for the
  next release.
- At qualification time nothing was published for 0.5.0: no tag, npm
  package or GitHub release existed and the published version was 0.4.0.
  Publication stays an owner gate: issue #165 holds the explicit publication
  authorization decision.
