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
     "schemaVersion": 3,
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

   Pickforge accepts schema versions 1 through 3 and always records a v3
   document. Each state can include up to eight screenshot artifacts, with 16
   total across `before`, `steps`, and `after`, in this shape:
   `{"kind":"screenshot","label":"Clicked frame","source":"/absolute/path.png"}`.
   Pickforge only validates and records this envelope; it never invokes MCP,
   Flutter, Dart, Git, network tools, or screenshot capture.

If an MCP tool, resource, runtime, or hot-reload capability is unavailable, name
that exact capability and run `pickforge doctor`; never fabricate evidence.
Official Dart and Flutter skills are complementary to this workflow, but are not
installed by it.
