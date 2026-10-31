import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProcessIdentity } from "@pickforge/lab-core";
import {
  StackMembership, readStack, stackDir, stackLayout, STACK_PEEK, type StackContext, type StackMember,
} from "../src/viewer/stack.js";
import type { BrowserViewerLaunchRecord } from "@pickforge/lab-desktop-linux";
import {
  THUMBNAIL_MARGIN, buildMoveDispatch, buildMoveLua, moveHyprlandViewerWindow, viewerClassPattern,
} from "../src/viewer/hyprland.js";
import { createViewerFakes, monitor } from "./viewer-fakes.js";

const AREA = { x: 0, y: 0, width: 1920, height: 1080 };
const W = 384;
const H = 216;
const X = AREA.width - W - THUMBNAIL_MARGIN;
const TOP0 = AREA.height - H - THUMBNAIL_MARGIN;

function id(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function card(n: number, overrides: Partial<StackMember> = {}): StackMember {
  return {
    launchId: id(n), sessionId: "desk-abc123", hostPid: 1, hostStartTicks: 1, monitor: 0, mode: "thumbnail",
    // A higher n is stacked later, so it sits nearer the front.
    stackedAt: new Date(Date.UTC(2026, 9, 31, 12, 0, n)).toISOString(), hover: false, width: W, height: H, ...overrides,
  };
}

function ys(members: StackMember[], ids: number[] = members.map((_, index) => index + 1)): Array<number | undefined> {
  return ids.map((n) => stackLayout(members, id(n), AREA)?.y);
}

describe("stackLayout", () => {
  it("puts a lone card in the thumbnail corner", () => {
    expect(stackLayout([card(1)], id(1), AREA)).toEqual({ x: X, y: TOP0, width: W, height: H });
  });

  it("offsets collapsed back cards by the title strip, newest in front", () => {
    const members = [card(1), card(2), card(3)];
    expect(ys(members, [3, 2, 1])).toEqual([TOP0, TOP0 - STACK_PEEK, TOP0 - 2 * STACK_PEEK]);
    expect(STACK_PEEK).toBe(32);
    expect(new Set(members.map((member) => stackLayout(members, member.launchId, AREA)?.x))).toEqual(new Set([X]));
  });

  it("fans out fully above the front card when any card has hover, without moving the front card", () => {
    const members = [card(1), card(2, { hover: true }), card(3)];
    expect(ys(members, [3, 2, 1])).toEqual([TOP0, TOP0 - H, TOP0 - 2 * H]);
  });

  it("fans cards of different heights by each card's own height", () => {
    const members = [card(1, { height: 100 }), card(2, { height: 300, hover: true }), card(3)];
    expect(ys(members, [3, 2, 1])).toEqual([TOP0, TOP0 - 300, TOP0 - 300 - 100]);
  });

  it("keeps every collapsed strip on a card when the stack fans, so the pointer stays on the stack", () => {
    for (const heights of [[H, H, H, H], [100, 300, 160, 240], [240, 60, 400, 120]]) {
      const collapsed = heights.map((height, k) => card(10 - k, { height }));
      const fanned = collapsed.map((member, k) => ({ ...member, hover: k === 0 }));
      const rows = (members: StackMember[]): Array<[number, number]> =>
        members.map((member) => { const y = stackLayout(members, member.launchId, AREA)!.y; return [y, y + member.height]; });
      const cards = rows(fanned);
      for (const [top] of rows(collapsed)) {
        for (let y = top; y < top + STACK_PEEK; y++) {
          expect(cards.some(([from, to]) => y >= from && y < to)).toBe(true);
        }
      }
    }
  });

  it("never lets a taller back card end below the front card", () => {
    const members = [card(1, { height: 288 }), card(2, { height: 160 }), card(3, { height: 216 })];
    const front = TOP0;
    const bottom = front + 216;
    const tops = ys(members, [3, 2, 1]) as number[];
    expect(tops[0]).toBe(front);
    expect(tops[1]).toBe(front - STACK_PEEK);
    expect(tops[2]).toBe(bottom - 288);
    expect(tops[2]! + 288).toBeLessThanOrEqual(bottom);
    // Each strip still sits above the card in front.
    expect(tops[2]).toBeLessThanOrEqual(tops[1]! - STACK_PEEK);
  });

  it("spaces the fan uniformly when it would pass the top margin", () => {
    const members = [1, 2, 3, 4, 5].map((n) => card(n, { hover: n === 5 }));
    const spacing = Math.floor((TOP0 - THUMBNAIL_MARGIN) / 4);
    expect(spacing).toBe(204);
    expect(ys(members, [5, 4, 3, 2, 1])).toEqual([0, 1, 2, 3, 4].map((k) => TOP0 - k * spacing));
  });

  it("keeps at least the title strip between fanned cards in a short area", () => {
    const area = { x: 100, y: 50, width: 800, height: 400 };
    const members = Array.from({ length: 10 }, (_, index) => card(index + 1, { hover: true }));
    const top0 = area.y + area.height - H - THUMBNAIL_MARGIN;
    expect(stackLayout(members, id(10), area)).toEqual({ x: area.x + area.width - W - THUMBNAIL_MARGIN, y: top0, width: W, height: H });
    expect(stackLayout(members, id(1), area)?.y).toBe(top0 - 9 * STACK_PEEK);
  });

  it("breaks a stackedAt tie by launch id ascending", () => {
    const stackedAt = "2026-10-31T12:00:00.000Z";
    const members = [card(9, { stackedAt }), card(3, { stackedAt }), card(5, { stackedAt })];
    expect(ys(members, [3, 5, 9])).toEqual([TOP0, TOP0 - STACK_PEEK, TOP0 - 2 * STACK_PEEK]);
  });

  it("excludes away cards and cards on another monitor, and their hover", () => {
    const members = [card(1), card(2, { mode: "away", hover: true }), card(3, { monitor: 1, hover: true }), card(4, { monitor: 1 })];
    expect(stackLayout(members, id(1), AREA)?.y).toBe(TOP0);
    expect(stackLayout(members, id(2), AREA)).toBeUndefined();
    expect(stackLayout(members, id(3), AREA)?.y).toBe(TOP0 - H);
    expect(stackLayout(members, id(7), AREA)).toBeUndefined();
  });

  it("follows the area origin", () => {
    const area = { x: 1920, y: 30, width: 1280, height: 1000 };
    expect(stackLayout([card(1), card(2)], id(1), area)).toEqual({
      x: 1920 + 1280 - W - THUMBNAIL_MARGIN, y: 30 + 1000 - H - THUMBNAIL_MARGIN - STACK_PEEK, width: W, height: H,
    });
  });
});

describe("StackMembership", () => {
  let root: string;
  let ctx: StackContext;
  let live: { pid: number; startTicks: number };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-stack-"));
    ctx = { xdgRuntimeDir: root, instance: "test_stack" };
    live = readProcessIdentity(process.pid)!;
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function member(n: number, overrides: Partial<StackMember> = {}): StackMember {
    return card(n, { hostPid: live.pid, hostStartTicks: live.startTicks, ...overrides });
  }
  function file(n: number): string {
    return path.join(stackDir(ctx), `${id(n)}.json`);
  }
  function plant(name: string, content: unknown, mode = 0o600): void {
    fs.mkdirSync(stackDir(ctx), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stackDir(ctx), name), typeof content === "string" ? content : JSON.stringify(content), { mode });
  }

  it("creates private directories and a private member file with allowlisted keys", async () => {
    const stack = new StackMembership(ctx);
    await stack.join({ ...member(1), title: "secret", leaseId: "x" } as StackMember);
    for (const directory of ["pickforge", "pickforge/viewer-stack", "pickforge/viewer-stack/test_stack"]) {
      expect(fs.statSync(path.join(root, directory)).mode & 0o777).toBe(0o700);
    }
    expect(fs.statSync(file(1)).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(fs.readFileSync(file(1), "utf8")))).toEqual([
      "launchId", "sessionId", "hostPid", "hostStartTicks", "monitor", "mode", "stackedAt", "hover", "width", "height",
    ]);
    expect(await readStack(ctx)).toEqual([member(1)]);
  });

  it("replaces the file atomically on update, leaves no temp file, and unlinks on leave", async () => {
    const stack = new StackMembership(ctx);
    await stack.join(member(1));
    const before = fs.statSync(file(1)).ino;
    await stack.update({ hover: true, mode: "away" });
    expect(fs.statSync(file(1)).ino).not.toBe(before);
    expect(fs.readdirSync(stackDir(ctx))).toEqual([`${id(1)}.json`]);
    expect(await stack.read()).toEqual([member(1, { hover: true, mode: "away" })]);
    await stack.leave();
    expect(fs.existsSync(file(1))).toBe(false);
    await stack.update({ hover: false });
    expect(fs.existsSync(file(1))).toBe(false);
  });

  it("prunes members whose host identity is gone and skips invalid files", async () => {
    await new StackMembership(ctx).join(member(1));
    plant(`${id(2)}.json`, member(2, { hostStartTicks: live.startTicks + 1 }));
    plant(`${id(3)}.json`, { ...member(3), title: "extra" });
    plant(`${id(4)}.json`, "{not json");
    plant(`${id(5)}.json`, member(6));
    plant("not-a-launch.json", member(7));
    plant(`.tmp-${"a".repeat(32)}`, member(8));
    plant(`${id(9)}.json`, member(9), 0o644);
    plant(`${id(10)}.json`, member(10, { mode: "expanded" as StackMember["mode"] }));
    fs.symlinkSync(file(1), path.join(stackDir(ctx), `${id(11)}.json`));
    expect(await readStack(ctx)).toEqual([member(1)]);
    expect(fs.existsSync(file(2))).toBe(false);
    // Invalid files are skipped, not removed; only a dead host's file is pruned.
    expect(fs.existsSync(file(3))).toBe(true);
  });

  it("refuses a stack directory that is not private", async () => {
    fs.mkdirSync(path.join(root, "pickforge"), { mode: 0o755 });
    fs.chmodSync(path.join(root, "pickforge"), 0o755);
    await expect(new StackMembership(ctx).join(member(1))).rejects.toThrow("Unsafe viewer stack directory");
    fs.rmSync(path.join(root, "pickforge"), { recursive: true });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pf-stack-link-"));
    try {
      fs.symlinkSync(elsewhere, path.join(root, "pickforge"));
      await expect(new StackMembership(ctx).join(member(1))).rejects.toThrow();
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    } finally { fs.rmSync(elsewhere, { recursive: true, force: true }); }
  });

  it("notifies a watcher when another host writes", async () => {
    const own = new StackMembership(ctx);
    await own.join(member(1));
    let changes = 0;
    const stop = own.watch(() => { changes++; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const before = changes;
      await new StackMembership(ctx).join(member(2));
      await expect.poll(() => changes, { timeout: 2_000 }).toBeGreaterThan(before);
      expect((await own.read()).map((entry) => entry.launchId).sort()).toEqual([id(1), id(2)]);
    } finally { stop(); }
  });
});

describe("moveHyprlandViewerWindow", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-stack-move-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("moves only the verified own window, without a resize", async () => {
    const fakes = createViewerFakes(root);
    const hyprctl = fakes.installHyprctl();
    fakes.setState({ monitors: [monitor({ id: 1, x: 1920, reserved: [0, 30, 0, 0] })] });
    const launchId = id(42);
    const cls = `pickforge-viewer-${launchId}`;
    const client = (overrides: Record<string, unknown>): Record<string, unknown> =>
      ({ address: "0xabc123", class: cls, pid: 4242, floating: true, monitor: 1, ...overrides });
    const launch = (provider?: "hyprlang"): BrowserViewerLaunchRecord => ({
      launchId, sessionId: "desk-abc123", createdAt: "", browser: { kind: "chromium", binary: "/bin/true" }, profileDir: root, pid: 4242,
      thumbnail: { width: W, height: H }, expanded: { width: 1280, height: 800 },
      hyprland: { hyprctl, instance: "abc_123", xdgRuntimeDir: root, provider, ruleName: "r", classPattern: viewerClassPattern(launchId) },
    });
    const writes = (): string[][] => fakes.calls().map((call) => (call.args as string[]).slice(2)).filter((args) => args[0] !== "-j");
    fs.writeFileSync(fakes.clientsFile, JSON.stringify([client({ address: "0x1", class: "other" }), client({ address: "0x2", pid: 1 }), client({})]));
    const seen: unknown[] = [];
    expect(await moveHyprlandViewerWindow(launch(), (area, on) => { seen.push(area, on); return { x: 1, y: 2 }; })).toBe(true);
    expect(seen).toEqual([{ x: 1920, y: 30, width: 1920, height: 1050 }, 1]);
    expect(await moveHyprlandViewerWindow(launch("hyprlang"), () => ({ x: 3, y: 4 }))).toBe(true);
    expect(await moveHyprlandViewerWindow(launch(), () => undefined)).toBe(false);
    expect(writes()).toEqual([["eval", buildMoveLua("0xabc123", { x: 1, y: 2 })], ["dispatch", ...buildMoveDispatch("0xabc123", { x: 3, y: 4 })]]);
    fs.writeFileSync(fakes.clientsFile, JSON.stringify([client({ floating: false })]));
    expect(await moveHyprlandViewerWindow(launch(), () => ({ x: 1, y: 2 }))).toBe(false);
    expect(await moveHyprlandViewerWindow({ ...launch(), hyprland: undefined }, () => ({ x: 1, y: 2 }))).toBe(false);
    expect(writes()).toHaveLength(2);
    expect(() => buildMoveLua("bad", { x: 1, y: 2 })).toThrow("address");
  });
});
