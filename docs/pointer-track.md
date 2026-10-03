The pointer track uses schema `pickforge.pointer-track` and version `1`.
`runId` identifies the evidence run.
`coordinateSpace` is `xvfb-root`, the verified owned Xvfb root window.
Coordinates use capture pixels before any video scaling.
Pixel `(x, y)` has its centre at `(x + 0.5, y + 0.5)`.
The track stores pixel indices, so consumers add 0.5 when drawing at pixel centres.

`clock.source` is `wall-clock-action-records`.
`clock.approximate` is always `true`.
`clock.origin` is the earliest included action start time in UTC, or null for an empty track.
Events are ordered by action start time, with report order used for ties.
Timing can reflect clock changes, scheduling delays and concurrent actions.
This track describes recorded actions, not continuous pointer motion or a screen recording.

Each event has a one-based `sequence`, `milliseconds` from the origin, `actionId`, `kind`, `point` and `inputState`.
`kind` is `move`, `click`, `double-click`, `drag` or `scroll`.
`point` contains `x` and `y` pixel indices.
`inputState` is `attempted` or `completed`.
An attempted action may have produced no visible change.
`durationMs` appears when a finite, non-negative action duration is known.
`dragStart` contains `x` and `y` when a valid drag start is known.
`wheelSteps` contains known signed integer `x` and `y` wheel steps.
Positive wheel steps scroll right or down; negative steps scroll left or up.

Only verified root points with attempted or completed input are included.
Older records without coordinate space or input state are excluded.
Records with invalid start times are excluded.
Keyboard actions, text, keys, typed lengths, target names and glyph labels are excluded.
The track can include actions without screenshots.

Readers must check the schema and version before using the track.
Compatible optional fields may be added within version 1.
Changes to existing meanings, required fields or coordinate conventions require a new version.
