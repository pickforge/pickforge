/**
 * Compact text form of a `uiautomator dump` hierarchy for agents.
 *
 * The rules follow callstack/agent-device's Android snapshot: a node stays
 * when it carries text, a content description or a resource id, or when a
 * touch can act on it. Other nodes are dropped and their kept descendants
 * move up to the nearest kept ancestor, so the hierarchy stays readable.
 * Bounds stay in device pixels, so they can go straight to `input tap`.
 */

export const DEFAULT_COMPACT_MAX_CHARS = 20_000;
export const DEFAULT_RAW_MAX_CHARS = 200_000;
export const MIN_UI_TREE_MAX_CHARS = 1_000;
export const MAX_UI_TREE_MAX_CHARS = 1_000_000;
/** Longer text and labels are cut, so one paragraph cannot fill the budget. */
export const MAX_NODE_TEXT_CHARS = 200;

export interface UiNode {
  attrs: Record<string, string>;
  children: UiNode[];
}

export interface UiHierarchy {
  rotation?: number;
  roots: UiNode[];
  nodeCount: number;
}

const TAG_RE = /<(\/?)(hierarchy|node)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (match, entity: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default: {
          const code = entity.startsWith("#x")
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
          return Number.isFinite(code) && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : match;
        }
      }
    },
  );
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(ATTR_RE)) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

/** Parse the flat XML that `uiautomator dump` writes. */
export function parseUiHierarchy(xml: string): UiHierarchy {
  const roots: UiNode[] = [];
  const stack: UiNode[] = [];
  let rotation: number | undefined;
  let nodeCount = 0;
  for (const match of xml.matchAll(TAG_RE)) {
    const [, closing, tag, attrSource, selfClosing] = match;
    if (tag === "hierarchy") {
      if (closing === "") {
        const value = Number.parseInt(parseAttrs(attrSource).rotation ?? "", 10);
        rotation = Number.isInteger(value) ? value : undefined;
      }
      continue;
    }
    if (closing === "/") {
      stack.pop();
      continue;
    }
    const node: UiNode = { attrs: parseAttrs(attrSource), children: [] };
    nodeCount += 1;
    const parent = stack.at(-1);
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
    if (selfClosing === "") {
      stack.push(node);
    }
  }
  return { rotation, roots, nodeCount };
}

function flag(node: UiNode, name: string): boolean {
  return node.attrs[name] === "true";
}

function hasContent(node: UiNode): boolean {
  return (
    (node.attrs.text ?? "") !== "" ||
    (node.attrs["content-desc"] ?? "") !== "" ||
    (node.attrs["resource-id"] ?? "") !== ""
  );
}

function isEditable(node: UiNode): boolean {
  return (node.attrs.class ?? "").endsWith("EditText");
}

function isActionable(node: UiNode): boolean {
  return (
    flag(node, "clickable") ||
    flag(node, "long-clickable") ||
    flag(node, "scrollable") ||
    flag(node, "checkable") ||
    isEditable(node)
  );
}

function keep(node: UiNode): boolean {
  return hasContent(node) || isActionable(node);
}

function quote(value: string): string {
  const cut =
    value.length > MAX_NODE_TEXT_CHARS
      ? `${value.slice(0, MAX_NODE_TEXT_CHARS)}…`
      : value;
  return JSON.stringify(cut);
}

function shortClass(className: string | undefined): string {
  if (className === undefined || className === "") {
    return "node";
  }
  return className.slice(className.lastIndexOf(".") + 1) || className;
}

function shortId(id: string, packageName: string | undefined): string {
  const prefix = `${packageName ?? ""}:id/`;
  return packageName !== undefined && id.startsWith(prefix)
    ? id.slice(prefix.length)
    : id;
}

function labelParts(node: UiNode, parentPackage: string | undefined): string[] {
  const a = node.attrs;
  const parts: string[] = [];
  const text = a.text ?? "";
  const desc = a["content-desc"] ?? "";
  const hint = a.hint ?? "";
  const id = a["resource-id"] ?? "";
  if (text !== "") parts.push(quote(text));
  if (desc !== "" && desc !== text) parts.push(`desc=${quote(desc)}`);
  if (hint !== "" && hint !== text && hint !== desc) parts.push(`hint=${quote(hint)}`);
  if (id !== "") parts.push(`id=${shortId(id, a.package)}`);
  if (a.package !== undefined && a.package !== parentPackage) parts.push(`pkg=${a.package}`);
  return parts;
}

const TRUE_FLAGS = ["clickable", "long-clickable", "scrollable"] as const;
const STATE_FLAGS = ["selected", "focused", "password"] as const;

function stateParts(node: UiNode): string[] {
  const parts: string[] = TRUE_FLAGS.filter((name) => flag(node, name));
  if (isEditable(node)) parts.push("editable");
  if (flag(node, "checkable")) parts.push(flag(node, "checked") ? "checked" : "unchecked");
  parts.push(...STATE_FLAGS.filter((name) => flag(node, name)));
  if (node.attrs.enabled === "false") parts.push("disabled");
  return parts;
}

function formatNode(
  node: UiNode,
  depth: number,
  parentPackage: string | undefined,
): string {
  const bounds = node.attrs.bounds === undefined ? [] : [node.attrs.bounds];
  const parts = [
    shortClass(node.attrs.class),
    ...labelParts(node, parentPackage),
    ...bounds,
    ...stateParts(node),
  ];
  return `${"  ".repeat(depth)}${parts.join(" ")}`;
}

interface CompactLine {
  depth: number;
  node: UiNode;
  parentPackage: string | undefined;
}

function collectLines(hierarchy: UiHierarchy): CompactLine[] {
  const lines: CompactLine[] = [];
  const visit = (
    node: UiNode,
    depth: number,
    parentPackage: string | undefined,
  ): void => {
    const kept = keep(node);
    if (kept) {
      lines.push({ depth, node, parentPackage });
    }
    const childDepth = kept ? depth + 1 : depth;
    const childPackage = kept ? node.attrs.package : parentPackage;
    for (const child of node.children) {
      visit(child, childDepth, childPackage);
    }
  };
  for (const root of hierarchy.roots) {
    visit(root, 0, undefined);
  }
  return lines;
}

export interface CompactUiTreeOptions {
  maxChars?: number;
  /** Applied to each line before it counts against the size limit. */
  redact?: (line: string) => string;
}

export interface CompactUiTree {
  tree: string;
  /** Nodes in `tree`. */
  nodes: number;
  /** Nodes kept by the compact rules, before the size limit. */
  keptNodes: number;
  /** Nodes in the raw dump. */
  totalNodes: number;
  truncated: boolean;
  empty: boolean;
  rotation?: number;
}

export function assertUiTreeMaxChars(maxChars: number): void {
  if (
    !Number.isInteger(maxChars) ||
    maxChars < MIN_UI_TREE_MAX_CHARS ||
    maxChars > MAX_UI_TREE_MAX_CHARS
  ) {
    throw new Error(
      `Invalid maxChars ${maxChars}: expected an integer from ` +
        `${MIN_UI_TREE_MAX_CHARS} to ${MAX_UI_TREE_MAX_CHARS}`,
    );
  }
}

function truncationNotice(shown: number, kept: number, maxChars: number): string {
  return (
    `[truncated: ${shown} of ${kept} nodes shown, maxChars ${maxChars}. ` +
    `Raise maxChars to see the rest.]`
  );
}

export function compactUiTree(
  xml: string,
  opts: CompactUiTreeOptions = {},
): CompactUiTree {
  const maxChars = opts.maxChars ?? DEFAULT_COMPACT_MAX_CHARS;
  assertUiTreeMaxChars(maxChars);
  const redact = opts.redact ?? ((line: string) => line);
  const hierarchy = parseUiHierarchy(xml);
  const lines = collectLines(hierarchy);
  const base = {
    keptNodes: lines.length,
    totalNodes: hierarchy.nodeCount,
    ...(hierarchy.rotation === undefined ? {} : { rotation: hierarchy.rotation }),
  };
  if (lines.length === 0) {
    const tree =
      hierarchy.nodeCount === 0
        ? "[empty: the dump has no nodes]"
        : `[empty: none of the ${hierarchy.nodeCount} nodes has text, a ` +
          "label, a resource id or an action]";
    return { ...base, tree, nodes: 0, truncated: false, empty: true };
  }
  const formatted = lines.map((line) =>
    redact(formatNode(line.node, line.depth, line.parentPackage)),
  );
  const full = formatted.join("\n");
  if (full.length <= maxChars) {
    return { ...base, tree: full, nodes: lines.length, truncated: false, empty: false };
  }
  // Reserve room for the notice so a truncated tree still fits maxChars.
  const budget =
    maxChars - truncationNotice(lines.length, lines.length, maxChars).length - 1;
  const out: string[] = [];
  let used = 0;
  for (const text of formatted) {
    const cost = text.length + (out.length === 0 ? 0 : 1);
    if (used + cost > budget) {
      break;
    }
    out.push(text);
    used += cost;
  }
  const shown = out.length;
  out.push(truncationNotice(shown, lines.length, maxChars));
  return { ...base, tree: out.join("\n"), nodes: shown, truncated: true, empty: false };
}

/** Cut raw XML to `maxChars` and say so; the result is no longer valid XML. */
export function limitRawUiTree(
  xml: string,
  maxChars: number = DEFAULT_RAW_MAX_CHARS,
): { xml: string; truncated: boolean; totalChars: number } {
  assertUiTreeMaxChars(maxChars);
  if (xml.length <= maxChars) {
    return { xml, truncated: false, totalChars: xml.length };
  }
  return { xml: xml.slice(0, maxChars), truncated: true, totalChars: xml.length };
}

/** Parse `wm density`; an override wins over the physical density. */
export function parseWmDensity(output: string): number | null {
  const override = /Override density:\s*(\d+)/.exec(output);
  const physical = /Physical density:\s*(\d+)/.exec(output);
  const value = Number.parseInt((override ?? physical)?.[1] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}
