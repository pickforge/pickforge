import { afterEach, beforeEach, expect, it } from "vitest";
import { acquireHumanLease, releaseHumanLease } from "@pickforge/lab-core";
import { desktopWindows, focusWindow, listWindows, selectDesktopWindow } from "../src/index.js";
import { windowFixture } from "./windows-fixture.js";

let fixture: Awaited<ReturnType<typeof windowFixture>>;
beforeEach(async () => { fixture = await windowFixture(); });
afterEach(() => fixture.cleanup());

it("adds inventory detail without changing lightweight callers", async () => {
  expect(await listWindows(":42", fixture.env)).toEqual([{ id: "11", name: "One" }, { id: "22", name: "Two" }]);
  expect(fixture.calls()).toHaveLength(3);
  expect(await desktopWindows(":42", fixture.env)).toEqual([
    { id: "11", name: "One", class: "Zenity", geometry: { x: -4, y: 12, width: 300, height: 200 }, focused: true },
    { id: "22", name: "Two", class: "Zenity", geometry: { x: -4, y: 12, width: 300, height: 200 }, focused: false },
  ]);
  expect(fixture.calls()).toContainEqual(["xprop", "-id", "11", "WM_CLASS"]);
  expect(fixture.calls().some(([command]) => command === "getwindowclassname")).toBe(false);
});

it("decodes the resource class rather than instance, including xprop escapes", async () => {
  fixture.state({ classOutput: String.raw`WM_CLASS(STRING) = "other, \"instance\"", "Class, \"quoted\"\\path\tline\n\303\251"` });
  expect((await desktopWindows(":42", fixture.env))[0]!.class).toBe('Class, "quoted"\\path\tline\né');
});

it.each([
  "WM_CLASS:  not found.",
  'WM_CLASS(STRING) = "instance"',
  'WM_CLASS(CARDINAL) = 1, 2',
  String.raw`WM_CLASS(STRING) = "instance", "bad\q"`,
])("rejects missing or malformed class output: %s", async (classOutput) => {
  fixture.state({ classOutput });
  await expect(desktopWindows(":42", fixture.env)).rejects.toThrow("Invalid or missing xprop WM_CLASS");
});

it("fails inventory on an xprop error or deadline without leaking class data", async () => {
  fixture.state({ classError: "window disappeared" });
  await expect(desktopWindows(":42", fixture.env)).rejects.toThrow(/xprop/);
  fixture.state({ classError: undefined, hang: "xprop" });
  await expect(desktopWindows(":42", fixture.env)).rejects.toThrow(/timed out/i);
});

it("uses literal exact names, rejects ambiguity and malformed selectors without mutation", async () => {
  fixture.state({ names: ["--name .*; $(touch nope)", "Two"] });
  expect(await selectDesktopWindow(":42", { name: "--name .*; $(touch nope)" }, fixture.env)).toMatchObject({ id: "11" });
  for (const selector of [{}, { id: "11", name: "One" }, { id: "--sync" }, { name: "" }, { name: ".*" }, { id: "33" }]) {
    await expect(selectDesktopWindow(":42", selector, fixture.env)).rejects.toThrow();
  }
  fixture.state({ names: ["Same", "Same"] });
  await expect(selectDesktopWindow(":42", { name: "Same" }, fixture.env)).rejects.toThrow("Ambiguous");
  expect(fixture.calls().some(([command]) => command === "windowfocus")).toBe(false);
});

it("focuses under a permit and refuses a human lease or changed identity", async () => {
  const opts = { display: ":42", sessionId: fixture.session.id, env: fixture.env, window: { id: "22", name: "Two" } };
  const lease = await acquireHumanLease(fixture.session.id, fixture.env);
  await expect(focusWindow(opts)).rejects.toThrow("human control is active");
  expect(fixture.calls()).toEqual([]);
  await releaseHumanLease(fixture.session.id, lease.leaseId, fixture.env);
  await expect(focusWindow({ ...opts, window: { id: "22", name: "Changed" } })).rejects.toThrow("identity changed");
  expect(await focusWindow(opts)).toEqual({ id: "22", name: "Two", focused: true });
  expect(fixture.calls()).toContainEqual(["windowfocus", "22"]);
});

it("bounds both confirmation and a hung activation subprocess", async () => {
  const opts = { display: ":42", sessionId: fixture.session.id, env: fixture.env, window: { id: "22", name: "Two" }, timeoutMs: 150 };
  fixture.state({ ignore: true });
  await expect(focusWindow(opts)).rejects.toThrow(/timed out/i);
  fixture.state({ hang: "windowfocus" });
  await expect(focusWindow(opts)).rejects.toThrow(/timed out/i);
  // A timed out action released the permit, so a human can take over.
  const lease = await acquireHumanLease(fixture.session.id, fixture.env);
  await releaseHumanLease(fixture.session.id, lease.leaseId, fixture.env);
  await expect(focusWindow({ ...opts, timeoutMs: 0 })).rejects.toThrow("Focus timeout");
});

it("redacts inventory and successful focus responses but selects the raw exact name", async () => {
  const secret = `ghp_${"a".repeat(36)}`;
  fixture.state({ names: [secret, "Two"], classOutput: `WM_CLASS(STRING) = "instance", "${secret}"` });
  expect(JSON.stringify(await desktopWindows(":42", fixture.env))).not.toContain(secret);
  const window = await selectDesktopWindow(":42", { name: secret }, fixture.env);
  expect(JSON.stringify(await focusWindow({ display: ":42", sessionId: fixture.session.id, env: fixture.env, window }))).not.toContain(secret);
});
