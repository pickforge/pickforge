---
name: pickforge-flutter
description: >-
  Inspect, fix, hot reload, and verify Flutter runtime issues with the official
  Dart and Flutter MCP server.
---

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
5. Repeat the same runtime scenario and capture before/after evidence. Hand off
   the source mapping, change, checks, and observed result.

If an MCP tool, resource, runtime, or hot-reload capability is unavailable, name
that exact capability and run `pickforge doctor`; never fabricate evidence.
Official Dart and Flutter skills are complementary to this workflow, but are not
installed by it.
