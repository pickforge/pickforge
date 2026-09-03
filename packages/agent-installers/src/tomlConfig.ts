import fs from "node:fs";
import { writeFileAtomic } from "@pickforge/lab-core";
import { backupFile } from "./backup.js";
import { renderTomlSnippet } from "./snippet.js";
import type { ChangeResult, McpServerEntry } from "./types.js";

export const TOML_MARKER_BEGIN = "# >>> picklab >>>";
export const TOML_MARKER_END = "# <<< picklab <<<";

const SECTION_PATTERN =
  /^[ \t]*\[mcp_servers\.(?:picklab|picklab-browser|"picklab"|"picklab-browser")(?:\.[^\]\r\n]*)?\][ \t]*\r?$/m;

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

function splitMarkers(content: string, filePath: string): MarkerSplit {
  const begin = findMarkerLine(content, TOML_MARKER_BEGIN);
  const end = findMarkerLine(content, TOML_MARKER_END);
  if (begin === undefined && end === undefined) {
    return { before: content, block: undefined, after: "" };
  }
  if (begin === undefined || end === undefined || end.start < begin.start) {
    throw new Error(
      `Refusing to edit ${filePath}: unbalanced picklab markers ` +
        `("${TOML_MARKER_BEGIN}" / "${TOML_MARKER_END}"). Fix the file and retry.`,
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
  if (SECTION_PATTERN.test(split.before) || SECTION_PATTERN.test(split.after)) {
    throw new Error(
      `Refusing to edit ${filePath}: an [mcp_servers.picklab] section exists ` +
        `outside the picklab markers. Remove it (or move it between ` +
        `"${TOML_MARKER_BEGIN}" and "${TOML_MARKER_END}") and retry.`,
    );
  }
}

export async function upsertTomlMarkerBlock(
  filePath: string,
  entry?: McpServerEntry,
): Promise<ChangeResult> {
  const existing = await readTextIfExists(filePath);
  const content = existing ?? "";
  const split = splitMarkers(content, filePath);
  assertNoForeignSection(split, filePath);
  const desired = markerBlock(entry);
  if (split.block === desired) {
    return { configPath: filePath, changed: false };
  }
  let next: string;
  if (split.block === undefined) {
    const separator =
      content === "" ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    next = `${content}${separator}${desired}`;
  } else {
    next = `${split.before}${desired}${split.after}`;
  }
  const backupPath =
    existing === undefined ? undefined : await backupFile(filePath);
  await writeFileAtomic(filePath, next);
  return { configPath: filePath, changed: true, backupPath };
}

export async function removeTomlMarkerBlock(
  filePath: string,
): Promise<ChangeResult> {
  const existing = await readTextIfExists(filePath);
  if (existing === undefined) {
    return { configPath: filePath, changed: false };
  }
  const split = splitMarkers(existing, filePath);
  if (split.block === undefined) {
    return { configPath: filePath, changed: false };
  }
  const backupPath = await backupFile(filePath);
  await writeFileAtomic(filePath, `${split.before}${split.after}`);
  return { configPath: filePath, changed: true, backupPath };
}

export interface TomlInspection {
  exists: boolean;
  markersPresent: boolean;
  markersHaveSection: boolean;
  foreignSection: boolean;
}

export async function inspectTomlFile(
  filePath: string,
): Promise<TomlInspection> {
  const existing = await readTextIfExists(filePath);
  if (existing === undefined) {
    return {
      exists: false,
      markersPresent: false,
      markersHaveSection: false,
      foreignSection: false,
    };
  }
  let split: MarkerSplit;
  try {
    split = splitMarkers(existing, filePath);
  } catch {
    return {
      exists: true,
      markersPresent: true,
      markersHaveSection: false,
      foreignSection: false,
    };
  }
  return {
    exists: true,
    markersPresent: split.block !== undefined,
    markersHaveSection:
      split.block !== undefined && split.block === markerBlock(),
    foreignSection:
      SECTION_PATTERN.test(split.before) || SECTION_PATTERN.test(split.after),
  };
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
    let split: MarkerSplit;
    try {
      split = splitMarkers(existing, filePath);
    } catch {
      return false;
    }
    return split.block?.includes(renderTomlSnippet(expected)) === true;
  }
  const inspection = await inspectTomlFile(filePath);
  return inspection.markersHaveSection || inspection.foreignSection;
}
