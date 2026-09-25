# Pickforge <version>

<One paragraph on what this release is for.>

## Changes

- The MCP prompt `preview-flutter-component` walks an agent through rendering
  one Flutter widget without the full app, auth, routing or backend. Give it
  the widget and, optionally, states and viewports. It uses the Flutter Widget
  Previewer when the SDK has one, a temporary widget-test harness for exact
  sizes, overflow and semantics checks, and a temporary web entrypoint only as
  a fallback. Captures default to 390, 768 and 1440 logical pixels. Visual
  lanes run in a Pickforge session, generated files are removed afterwards,
  and production routing, app startup and golden baselines are left alone.
  (#43)

## Validation

- <What was actually run, and where its evidence lives. Nothing aspirational.>

## Known limits

- <What this release does not do, and what is not proven yet.>
