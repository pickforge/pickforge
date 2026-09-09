/** Shared by the device_pass prompt and agent installs. */
export const DEVICE_PASS_WORKFLOW = `Test the changed user journey in a rendered Pickforge session.
Create a fresh session per scenario with session_create; evidence recording starts with the session unless config evidence.enabled is false, and the run belongs to that session. Take the runId from the first screenshot result or artifact_list.
If the MCP server restarts, the session gets a new run; record the outcome on the run that holds both the interactions and the screenshots.
Keep evidence under the Pickforge state root, outside the repository, never in the project repository; verify the resolved storage before starting.
Record the revision, target, viewport, device scale, touch support, and run kind: desktop, mobile emulation, emulator, or physical hardware.
Mobile emulation is not a physical device test. Unknown facts stay unknown; record missing metadata in limitations.
Never attach personal browser profiles or credentials. Redaction applies, but do not type real secrets; use test data.
Drive the scoped journey through visible controls with the lab input tools, such as desktop_click, desktop_type, android_tap, or the browser DevTools input tools.
Save screenshots of meaningful intermediate and final states with the lab screenshot tools; each returned absolute path also has a run-relative form, screenshots/<actionId>.png, the same form artifact_report shows.
Open and inspect each screenshot you cite: read the image, not just its filename, metadata, or tool success result.
Check clipped text, overflow, blank space, covered controls, focus, and validation visibility.
A successful assertion does not replace visual inspection. Ordinary action recording alone does not establish acceptance.
Pass is refused without a successful interaction and an inspected screenshot.
After inspection, call evidence_outcome with runId, scenario, status (pass, fail, partial, or blocked), revision, steps, inspectedScreenshots, and limitations.
Give inspectedScreenshots only run-relative screenshots/<actionId>.png paths from that run, the returned absolute path with the run directory stripped, and only for images you actually inspected; record unknown revision as unknown.
A pass is complete only when the scoped journeys succeeded on the stated viewports, their saved images were inspected, and the evidence links work.
Record failures, incomplete scope, or missing evidence honestly as fail, partial, or blocked; never infer acceptance from recording alone.
Finish the session with session_destroy and use pickforge-lab artifacts report <runId> for the HTML report; verify its evidence links.
A device pass does not itself approve a merge.
`;

/** Short MCP server instructions; the device_pass prompt carries the full workflow. */
export const DEVICE_PASS_SUMMARY = `Pickforge lab: isolated desktop, browser, and Android sessions with recorded evidence.
For a device pass, follow the device_pass prompt or the shared device-pass.md written by pickforge-lab agents install.
Pass is refused without a successful interaction and an inspected screenshot recorded with evidence_outcome; recording alone does not establish acceptance.
Keep evidence under the Pickforge state root, and never attach personal browser profiles or type real secrets.
`;
