---
name: pickforge-flutter
description: >-
  Inspect, fix, hot reload, and verify Flutter runtime issues with the official
  Dart and Flutter MCP server.
---

<!-- pickforge-managed: pickforge-flutter -->

# Pickforge Flutter workflow

1. Protect pre-existing work. Inspect the current Git state and relevant source
   before changing anything.
2. Establish the runtime and static-analysis baseline with the official
   Dart/Flutter MCP tools and resources. Map the observed widget/runtime behavior
   back to its source.
3. Make the smallest source-only fix. Do not edit generated code or
   configuration, install packages, create project artifacts, add
   `flutter_driver`, or enable the driver extension. Ask first if any of those
   are necessary.
4. Run scoped analysis and tests for the changed source, then use hot reload.
5. Repeat the same runtime scenario and capture the endpoints plus any
   intermediate states that prove individual actions. Review every screenshot
   first: Pickforge cannot redact secret or private pixels.
6. Supply the complete bounded envelope and absolute image paths in one call.
   `steps` is optional, ordered, and limited to 32 entries. A check can name the
   unique step that proves it:

   ```sh
   pickforge evidence record --project-dir "$PWD" --input - <<'JSON'
   {
     "schemaVersion": 4,
     "scenario": "Counter increments and keeps state after hot reload",
     "outcome": "passed",
     "before": {"summary":"Counter was zero with the old theme.","observations":[{"label":"Counter","value":"0"}],"artifacts":[]},
     "steps": [
       {"label":"Clicks complete","summary":"Counter reached two before reload.","observations":[{"label":"Counter","value":"2"}],"artifacts":[]}
     ],
     "after": {"summary":"The new theme appeared and counter stayed at two.","observations":[{"label":"Counter","value":"2"}],"artifacts":[]},
     "sourceChanges": ["lib/main.dart"],
     "checks": [
       {"name":"desktop click","status":"passed","summary":"Counter advanced to two.","step":"Clicks complete"},
       {"name":"flutter test","status":"passed","summary":"Focused tests passed."}
     ],
     "limitations": []
   }
   JSON
   ```

   Pickforge accepts schema versions 1 through 4 and always records a v4
   document. Each state can include up to eight artifacts, with 16 total across
   `before`, `steps`, and `after`. A screenshot has this shape:
   `{"kind":"screenshot","label":"Clicked frame","source":"/absolute/path.png"}`.
   Pickforge only validates and records this envelope; it never invokes MCP,
   Flutter, Dart, Git, network tools, or screenshot capture.

7. Record what you saw and the state you saw it in. Each state can take a
   `capture` object. Omit a value you did not observe; Pickforge records it as
   `unknown`. Never guess a value:

   ```json
   "capture": {
     "capturedAt": "2026-10-28T16:00:00Z",
     "appBuild": "1.4.0+42",
     "emulatorVersion": "35.2.10",
     "systemImage": "system-images;android-35;google_apis;x86_64",
     "requested": {"foldState": "flat", "darkMode": true},
     "observed": {"displayMode": "inner", "foldState": "flat", "posture": "open",
       "rotation": 90, "density": 420, "fontScale": 1.3, "darkMode": true, "locale": "en-US"}
   }
   ```

   `requested` lists only the settings you changed. Leave out what you do not
   know; it is recorded as `unknown`. Rotation is in degrees and density is
   in dpi.

8. A UI tree, a log excerpt or a report is a text artifact. Write it to a
   file first, then name its kind, origin and capture time:
   `{"kind":"log","origin":"android-logcat","label":"Logcat","source":"/absolute/logcat.txt","capturedAt":"2026-10-28T16:00:01Z"}`.
   Origins are `android-ui-tree`, `devtools-accessibility` and `atspi-tree` for
   kind `tree`, `android-logcat` and `devtools-console` for kind `log`, and
   `lighthouse` for kind `report`. Each file must be UTF-8 and at most 4 MiB.
   Pickforge redacts secrets and stores it as plain text that no viewer runs.
   When a source is not available, record the reason instead of a source:
   `{"kind":"tree","origin":"atspi-tree","label":"Desktop tree","unavailable":"no AT-SPI bus"}`.

If an MCP tool, resource, runtime, or hot-reload capability is unavailable, name
that exact capability and run `pickforge doctor`; never fabricate evidence.
Official Dart and Flutter skills are complementary to this workflow, but are not
installed by it.
