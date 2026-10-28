import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compactUiTree,
  limitRawUiTree,
  parseUiHierarchy,
  parseWmDensity,
} from "../src/index.js";

// Captured from a real API 37 emulator (picklab-avd, 320x640 at 160 dpi).
const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "ui-tree",
);

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir, `${name}.xml`), "utf8");
}

function lineOf(tree: string, needle: string): string {
  const line = tree.split("\n").find((entry) => entry.includes(needle));
  if (line === undefined) {
    throw new Error(`no line contains ${needle}\n${tree}`);
  }
  return line;
}

function depthOf(line: string): number {
  return (line.length - line.trimStart().length) / 2;
}

function node(attrs: string, children = ""): string {
  return `<node ${attrs}>${children}</node>`;
}

function hierarchy(body: string): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="1">${body}</hierarchy>`;
}

describe("compactUiTree on real fixtures", () => {
  it("keeps Android Settings labels, actions and hierarchy", () => {
    const xml = fixture("settings");
    const result = compactUiTree(xml);
    expect(result.truncated).toBe(false);
    expect(result.empty).toBe(false);
    expect(result.rotation).toBe(0);
    expect(result.tree.length).toBeLessThan(xml.length / 4);
    const search = lineOf(result.tree, '"Search Settings"');
    expect(search).toContain("id=search_bar_title");
    expect(search).toContain("[72,54][221,82]");
    expect(lineOf(result.tree, "id=main_content_scrollable_container")).toContain(
      "scrollable",
    );
    // A clickable row stays as the ancestor of its title and summary.
    const lines = result.tree.split("\n");
    const title = lines.findIndex((line) => line.includes('"Network & internet"'));
    const row = lines
      .slice(0, title)
      .reverse()
      .find((line) => depthOf(line) < depthOf(lines[title]!) - 1);
    expect(row).toMatch(/LinearLayout \[0,207\]\[320,280\] clickable$/);
    expect(lines[title + 1]).toContain('"Mobile, Wi‑Fi, hotspot"');
    for (const label of ["Google", "Connected devices", "Apps", "Notifications", "Sound & vibration"]) {
      expect(result.tree).toContain(`"${label}"`);
    }
  });

  it("keeps Flutter semantics labels and actions", () => {
    const result = compactUiTree(fixture("flutter"));
    expect(result.totalNodes).toBe(30);
    expect(lineOf(result.tree, '"Search orders"')).toMatch(
      /^ {2}Button desc="Search orders" \[272,28\]\[320,76\] clickable$/,
    );
    expect(lineOf(result.tree, 'hint="Customer name"')).toContain("editable");
    expect(lineOf(result.tree, '"Order alerts"')).toMatch(/Switch .* clickable checked$/);
    expect(lineOf(result.tree, '"Add order"')).toContain("[248,568][304,624]");
    const list = lineOf(result.tree, "ScrollView");
    const order = lineOf(result.tree, "Order #103");
    expect(depthOf(order)).toBe(depthOf(list) + 1);
    expect(order).toContain('desc="Order #103\\nPending since day 3"');
  });

  it("keeps Compose labels, test-tag ids and clickable containers", () => {
    const result = compactUiTree(fixture("compose"));
    expect(lineOf(result.tree, "id=invoice_list")).toContain("scrollable");
    const add = lineOf(result.tree, "id=add_invoice");
    expect(add).toContain("clickable");
    expect(lineOf(result.tree, 'desc="Add invoice"')).toMatch(/^ {4}TextView "\+"/);
    const card = lineOf(result.tree, "[8,252][312,324]");
    expect(card).toContain("clickable");
    const cardTitle = lineOf(result.tree, '"Invoice #201"');
    expect(depthOf(cardTitle)).toBe(depthOf(card) + 1);
    expect(lineOf(result.tree, "[252,168][304,216]")).toMatch(/clickable checked$/);
    expect(lineOf(result.tree, '"Client name"')).toBeDefined();
  });
});

describe("compactUiTree rules", () => {
  it("drops unlabeled passive nodes and lifts their children", () => {
    const xml = hierarchy(
      node(
        'class="android.widget.FrameLayout" package="a.b" bounds="[0,0][10,10]"',
        node(
          'class="android.widget.LinearLayout" package="a.b" clickable="true" bounds="[0,0][10,5]"',
          node('class="android.view.View" package="a.b" bounds="[0,0][1,1]"') +
            node('class="android.widget.TextView" text="Hi" package="a.b" bounds="[1,1][2,2]"'),
        ),
      ),
    );
    const result = compactUiTree(xml);
    expect(result.tree).toBe(
      'LinearLayout pkg=a.b [0,0][10,5] clickable\n  TextView "Hi" [1,1][2,2]',
    );
    expect(result).toMatchObject({ nodes: 2, keptNodes: 2, totalNodes: 4, rotation: 1 });
  });

  it("decodes entities and reports state flags", () => {
    const xml = hierarchy(
      node(
        'class="android.widget.CheckBox" text="Fish &amp; chips &#233;" content-desc="&quot;x&quot;" ' +
          'resource-id="a.b:id/box" package="a.b" checkable="true" checked="false" ' +
          'enabled="false" selected="true" focused="true" password="false" bounds="[0,0][1,1]"',
      ),
    );
    expect(compactUiTree(xml).tree).toBe(
      'CheckBox "Fish & chips é" desc="\\"x\\"" id=box pkg=a.b [0,0][1,1] ' +
        "unchecked selected focused disabled",
    );
  });

  it("reports an empty tree as empty without other claims", () => {
    const none = compactUiTree(hierarchy(""));
    expect(none).toMatchObject({ empty: true, nodes: 0, totalNodes: 0, truncated: false });
    expect(none.tree).toBe("[empty: the dump has no nodes]");
    const passive = compactUiTree(
      hierarchy(node('class="android.view.View" bounds="[0,0][1,1]"')),
    );
    expect(passive.empty).toBe(true);
    expect(passive.tree).toContain("none of the 1 nodes");
    expect(`${none.tree}${passive.tree}`).not.toMatch(/secure/i);
  });

  it("truncates at a line boundary within maxChars and says so", () => {
    const xml = fixture("settings");
    const result = compactUiTree(xml, { maxChars: 1_000 });
    expect(result.truncated).toBe(true);
    expect(result.tree.length).toBeLessThanOrEqual(1_000);
    expect(result.nodes).toBeLessThan(result.keptNodes);
    const last = result.tree.split("\n").at(-1);
    expect(last).toBe(
      `[truncated: ${result.nodes} of ${result.keptNodes} nodes shown, ` +
        "maxChars 1000. Raise maxChars to see the rest.]",
    );
    expect(result.tree.split("\n")).toHaveLength(result.nodes + 1);
  });

  it("cuts long text and redacts each line", () => {
    const long = "x".repeat(500);
    const xml = hierarchy(
      node(`class="android.widget.TextView" text="${long}" bounds="[0,0][1,1]"`) +
        node('class="android.widget.TextView" text="token=abc" bounds="[0,0][1,1]"'),
    );
    const result = compactUiTree(xml, {
      redact: (line) => line.replace("abc", "[REDACTED]"),
    });
    expect(result.tree).toContain(`"${"x".repeat(200)}…"`);
    expect(result.tree).toContain('"token=[REDACTED]"');
  });

  it("rejects a maxChars outside its bounds", () => {
    expect(() => compactUiTree(hierarchy(""), { maxChars: 999 })).toThrow(/maxChars/);
    expect(() => compactUiTree(hierarchy(""), { maxChars: 1_000_001 })).toThrow(/maxChars/);
    expect(() => limitRawUiTree("<x/>", 1.5)).toThrow(/maxChars/);
  });
});

describe("raw limit, parser and density", () => {
  it("limits raw XML and reports the full length", () => {
    const xml = "y".repeat(1_500);
    expect(limitRawUiTree(xml, 1_000)).toEqual({
      xml: "y".repeat(1_000),
      truncated: true,
      totalChars: 1_500,
    });
    expect(limitRawUiTree(xml)).toMatchObject({ truncated: false, totalChars: 1_500 });
  });

  it("parses nested and self-closing nodes", () => {
    const parsed = parseUiHierarchy(fixture("flutter"));
    expect(parsed.nodeCount).toBe(30);
    expect(parsed.roots).toHaveLength(1);
    expect(parsed.roots[0]!.attrs.class).toBe("android.widget.FrameLayout");
  });

  it("prefers the override density", () => {
    expect(parseWmDensity("Physical density: 440\n")).toBe(440);
    expect(parseWmDensity("Physical density: 440\nOverride density: 320\n")).toBe(320);
    expect(parseWmDensity("error")).toBeNull();
  });
});
