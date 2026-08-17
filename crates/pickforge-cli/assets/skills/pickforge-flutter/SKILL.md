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
5. Repeat the same runtime scenario and capture before/after evidence. Review
   every screenshot first: Pickforge cannot redact secret or private pixels.
6. Supply the complete bounded envelope and absolute image paths in one call:

   ```sh
   pickforge evidence record --project-dir "$PWD" --input - <<'JSON'
   {"schemaVersion":1,"scenario":"Counter increments after hot reload","outcome":"passed","before":{"summary":"Counter stayed at zero.","observations":[],"artifacts":[]},"after":{"summary":"Counter changed to one.","observations":[{"label":"Counter","value":"1"}],"artifacts":[]},"sourceChanges":["lib/main.dart"],"checks":[{"name":"flutter test","status":"passed","summary":"Focused tests passed."}],"limitations":[]}
   JSON
   ```

   Pickforge only validates and records this envelope; it never invokes MCP,
   Flutter, Dart, Git, network tools, or screenshot capture.

If an MCP tool, resource, runtime, or hot-reload capability is unavailable, name
that exact capability and run `pickforge doctor`; never fabricate evidence.
Official Dart and Flutter skills are complementary to this workflow, but are not
installed by it.
