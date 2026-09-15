import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { acquireHumanLease, listRuns, readActions, releaseHumanLease } from "@pickforge/lab-core";
import { windowFixture } from "../../desktop-linux/test/windows-fixture.js";
import { connectLab, parseToolJson, type ConnectedLab } from "./helpers.js";

let fixture: Awaited<ReturnType<typeof windowFixture>>;
let lab: ConnectedLab;
beforeEach(async () => {
  fixture = await windowFixture();
  lab = await connectLab({ projectDir: fixture.root, env: fixture.env });
});
afterEach(async () => { await lab.close(); fixture.cleanup(); });

async function call(name: string, args: Record<string, unknown> = {}) {
  return parseToolJson(await lab.client.callTool({ name, arguments: { session: fixture.session.id, ...args } }));
}
async function actions() {
  const runs = await listRuns(fixture.root, fixture.env);
  return readActions(path.join(fixture.root, ".picklab/runs", runs[0]!.runId));
}

it("exposes detailed inventory and records exact-name focus identity", async () => {
  expect((await call("desktop_windows")).windows).toEqual(expect.arrayContaining([expect.objectContaining({ id: "11", class: "Zenity", focused: true, geometry: { x: -4, y: 12, width: 300, height: 200 } })]));
  expect(await call("desktop_focus", { name: "Two" })).toMatchObject({ ok: true, window: { id: "22", focused: true } });
  expect(await actions()).toContainEqual(expect.objectContaining({ tool: "desktop_focus", status: "ok", target: { role: "window", name: "Two", selector: "22" } }));
});

it("records timeout and human-control failures without permitting mutation during takeover", async () => {
  const lease = await acquireHumanLease(fixture.session.id, fixture.env);
  expect((await call("desktop_focus", { id: "22" })).errors[0]).toContain("human control is active");
  expect(fixture.calls().some(([command]) => command === "windowfocus")).toBe(false);
  await releaseHumanLease(fixture.session.id, lease.leaseId, fixture.env);
  fixture.state({ ignore: true });
  expect(await call("desktop_focus", { id: "22", timeoutMs: 150 })).toMatchObject({ ok: false });
  expect(await actions()).toContainEqual(expect.objectContaining({ tool: "desktop_focus", status: "timeout", error: expect.stringMatching(/timed out/i) }));
  fixture.state({ names: ["Same", "Same"] });
  expect((await call("desktop_focus", { name: "Same" })).errors[0]).toContain("Ambiguous");
  expect((await call("desktop_focus", { id: "11", name: "Same" })).errors[0]).toContain("exactly one");
  expect(await actions()).toContainEqual(expect.objectContaining({ tool: "desktop_focus", status: "error", error: expect.stringContaining("Ambiguous") }));
});
