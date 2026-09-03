import fs from "node:fs";
import { writeFileAtomic } from "@pickforge/lab-core";
import { backupFile } from "./backup.js";
import {
  LEGACY_BROWSER_MCP_SERVER_NAME,
  LEGACY_MCP_SERVER_NAME,
  renderTomlSnippet,
} from "./snippet.js";
import type { ChangeResult, McpServerEntry } from "./types.js";

export const TOML_MARKER_BEGIN = "# >>> pickforge-lab >>>";
export const TOML_MARKER_END = "# <<< pickforge-lab <<<";
export const LEGACY_TOML_MARKER_BEGIN = "# >>> picklab >>>";
export const LEGACY_TOML_MARKER_END = "# <<< picklab <<<";

const SECTION_PATTERN =
  /^[ \t]*\[mcp_servers\.(?:picklab|picklab-browser|pickforge-lab|pickforge-lab-browser|"picklab"|"picklab-browser"|"pickforge-lab"|"pickforge-lab-browser")(?:\.[^\]\r\n]*)?\][ \t]*\r?$/m;

interface Markers {
  begin: string;
  end: string;
  label: string;
}

const CURRENT_MARKERS: Markers = {
  begin: TOML_MARKER_BEGIN,
  end: TOML_MARKER_END,
  label: "pickforge-lab",
};
const LEGACY_MARKERS: Markers = {
  begin: LEGACY_TOML_MARKER_BEGIN,
  end: LEGACY_TOML_MARKER_END,
  label: "legacy picklab",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface MarkerLine {
  start: number;
  end: number;
}

function findMarkerLine(content: string, marker: string): MarkerLine | undefined {
  const pattern = new RegExp(`^${escapeRegExp(marker)}[ \\t]*\\r?$`, "m");
  const match = pattern.exec(content);
  if (match === null) {
    return undefined;
  }
  return { start: match.index, end: match.index + match[0].length };
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

function markerBlock(entry?: McpServerEntry): string {
  return `${TOML_MARKER_BEGIN}\n${renderTomlSnippet(entry)}${TOML_MARKER_END}\n`;
}

interface MarkerSplit {
  before: string;
  block: string | undefined;
  after: string;
}

function splitMarkers(
  content: string,
  filePath: string,
  markers: Markers,
): MarkerSplit {
  const begin = findMarkerLine(content, markers.begin);
  const end = findMarkerLine(content, markers.end);
  if (begin === undefined && end === undefined) {
    return { before: content, block: undefined, after: "" };
  }
  if (begin === undefined || end === undefined || end.start < begin.start) {
    throw new Error(
      `Refusing to edit ${filePath}: unbalanced ${markers.label} markers ` +
        `("${markers.begin}" / "${markers.end}"). Fix the file and retry.`,
    );
  }
  let blockEnd = end.end;
  if (content[blockEnd] === "\n") {
    blockEnd += 1;
  }
  return {
    before: content.slice(0, begin.start),
    block: content.slice(begin.start, blockEnd),
    after: content.slice(blockEnd),
  };
}

function assertNoForeignSection(split: MarkerSplit, filePath: string): void {
  if (!SECTION_PATTERN.test(split.before) && !SECTION_PATTERN.test(split.after)) {
    return;
  }
  throw new Error(
    `Refusing to edit ${filePath}: a Pickforge Lab MCP section exists ` +
      `outside the managed markers. Remove it (or move it between ` +
      `"${TOML_MARKER_BEGIN}" and "${TOML_MARKER_END}") and retry.`,
  );
}

interface PreparedContent {
  content: string;
  legacyInsertAt?: number;
  legacyBlockPresent: boolean;
  migratedLegacyEntries: string[];
}

function legacyNamesInBlock(block: string): string[] {
  const names: string[] = [];
  if (/^\[mcp_servers\.(?:picklab|"picklab")\]$/m.test(block)) {
    names.push(LEGACY_MCP_SERVER_NAME);
  }
  if (/^\[mcp_servers\.(?:picklab-browser|"picklab-browser")\]$/m.test(block)) {
    names.push(LEGACY_BROWSER_MCP_SERVER_NAME);
  }
  return names;
}

function prepareLegacyBlock(content: string, filePath: string): PreparedContent {
  const legacy = splitMarkers(content, filePath, LEGACY_MARKERS);
  if (legacy.block === undefined) {
    return { content, legacyBlockPresent: false, migratedLegacyEntries: [] };
  }
  return {
    content: `${legacy.before}${legacy.after}`,
    legacyInsertAt: legacy.before.length,
    legacyBlockPresent: true,
    migratedLegacyEntries: legacyNamesInBlock(legacy.block),
  };
}

function appendMarkerBlock(content: string, desired: string): string {
  const separator = content === "" ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${desired}`;
}

function upsertPreparedContent(
  prepared: PreparedContent,
  desired: string,
  filePath: string,
): string {
  const split = splitMarkers(prepared.content, filePath, CURRENT_MARKERS);
  assertNoForeignSection(split, filePath);
  if (split.block !== undefined) {
    return `${split.before}${desired}${split.after}`;
  }
  if (prepared.legacyInsertAt !== undefined) {
    const index = prepared.legacyInsertAt;
    return `${prepared.content.slice(0, index)}${desired}${prepared.content.slice(index)}`;
  }
  return appendMarkerBlock(prepared.content, desired);
}

export async function upsertTomlMarkerBlock(
  filePath: string,
  entry?: McpServerEntry,
): Promise<ChangeResult> {
  const existing = await readTextIfExists(filePath);
  const content = existing ?? "";
  const prepared = prepareLegacyBlock(content, filePath);
  const desired = markerBlock(entry);
  const next = upsertPreparedContent(prepared, desired, filePath);
  if (next === content) {
    return { configPath: filePath, changed: false };
  }
  const backupPath =
    existing === undefined ? undefined : await backupFile(filePath);
  await writeFileAtomic(filePath, next);
  return {
    configPath: filePath,
    changed: true,
    backupPath,
    migratedLegacyEntries: prepared.migratedLegacyEntries,
  };
}

function withoutMarkerBlock(
  content: string,
  filePath: string,
  markers: Markers,
): { content: string; changed: boolean } {
  const split = splitMarkers(content, filePath, markers);
  if (split.block === undefined) {
    return { content, changed: false };
  }
  return { content: `${split.before}${split.after}`, changed: true };
}

export async function removeTomlMarkerBlock(
  filePath: string,
): Promise<ChangeResult> {
  const existing = await readTextIfExists(filePath);
  if (existing === undefined) {
    return { configPath: filePath, changed: false };
  }
  const current = withoutMarkerBlock(existing, filePath, CURRENT_MARKERS);
  const legacy = withoutMarkerBlock(current.content, filePath, LEGACY_MARKERS);
  if (!current.changed && !legacy.changed) {
    return { configPath: filePath, changed: false };
  }
  const backupPath = await backupFile(filePath);
  await writeFileAtomic(filePath, legacy.content);
  return { configPath: filePath, changed: true, backupPath };
}

export interface TomlInspection {
  exists: boolean;
  markersPresent: boolean;
  markersHaveSection: boolean;
  legacyMarkersPresent: boolean;
  foreignSection: boolean;
}

function missingInspection(): TomlInspection {
  return {
    exists: false,
    markersPresent: false,
    markersHaveSection: false,
    legacyMarkersPresent: false,
    foreignSection: false,
  };
}

function unbalancedInspection(): TomlInspection {
  return {
    exists: true,
    markersPresent: true,
    markersHaveSection: false,
    legacyMarkersPresent: false,
    foreignSection: false,
  };
}

export async function inspectTomlFile(
  filePath: string,
): Promise<TomlInspection> {
  const existing = await readTextIfExists(filePath);
  if (existing === undefined) {
    return missingInspection();
  }
  try {
    const prepared = prepareLegacyBlock(existing, filePath);
    const split = splitMarkers(prepared.content, filePath, CURRENT_MARKERS);
    return {
      exists: true,
      markersPresent: split.block !== undefined,
      markersHaveSection: split.block === markerBlock(),
      legacyMarkersPresent: prepared.legacyBlockPresent,
      foreignSection:
        SECTION_PATTERN.test(split.before) || SECTION_PATTERN.test(split.after),
    };
  } catch {
    return unbalancedInspection();
  }
}

export async function tomlFileHasMcpServer(
  filePath: string,
  expected: McpServerEntry | undefined = undefined,
): Promise<boolean> {
  if (expected !== undefined) {
    const existing = await readTextIfExists(filePath);
    if (existing === undefined) {
      return false;
    }
    try {
      const split = splitMarkers(existing, filePath, CURRENT_MARKERS);
      return split.block?.includes(renderTomlSnippet(expected)) === true;
    } catch {
      return false;
    }
  }
  const inspection = await inspectTomlFile(filePath);
  return inspection.markersHaveSection || inspection.foreignSection;
}
