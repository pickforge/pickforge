// Security guarantee: tests and scripts never start an X server that can
// take over the host display socket (see #234).
//
// Xvfb with -displayfd and no explicit display probes from display 0 and can
// unlink the host /tmp/.X11-unix/X0. xvfb-run -d (--auto-display) uses that
// same unsafe form. An explicit display such as ":1234" is safe, and so is
// xvfb-run -a.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packagesDir, repoRoot } from "./util.js";

interface DisplayFinding {
  line: number;
  rule: "displayfd-without-display" | "xvfb-run-auto-display";
  text: string;
}

const XVFB_RUN_VALUE_OPTION_CHARS = new Set(["e", "f", "n", "p", "s", "w"]);
const XVFB_RUN_ARG_LONG_OPTIONS = new Set([
  "--error-file",
  "--auth-file",
  "--server-num",
  "--xauth-protocol",
  "--server-args",
  "--wait",
]);
const TOKEN_RE = /"[^"]*"|'[^']*'|`[^`]*`|[^\s,[\]()"'`]+/g;
const QUOTE_CHARS = new Set(['"', "'", "`"]);
const COMMAND_END_CHARS = new Set([";", "|", "&", "\n"]);
const X_SERVER_RE = /\b(?:Xvfb|Xephyr|Xwayland|Xorg)\b/g;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function lineText(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

/** True when text[i] ends a shell command: ";", "|", "&" or a newline, not escaped. */
function isCommandEnd(text: string, i: number): boolean {
  return COMMAND_END_CHARS.has(text[i]) && text[i - 1] !== "\\";
}

/** Index of the first command end at or after `from`, or the text length. */
function shellCommandEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (isCommandEnd(text, i)) return i;
  }
  return text.length;
}

/** Index just after the last command end before `index`, or 0. */
function shellCommandStart(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (isCommandEnd(text, i)) return i + 1;
  }
  return 0;
}

/** Index of the "[" that encloses `index`, or -1 when there is none. */
function enclosingArrayStart(text: string, index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (text[i] === "]") depth += 1;
    if (text[i] !== "[") continue;
    if (depth === 0) return i;
    depth -= 1;
  }
  return -1;
}

/** Index of the "]" that closes the "[" at `open`, or the text length. */
function arrayEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === "[") depth += 1;
    if (text[i] !== "]") continue;
    if (depth === 0) return i;
    depth -= 1;
  }
  return text.length;
}

/** The items of the array that opens at `open`, without the brackets. */
function arrayItems(text: string, open: number): string {
  return text.slice(open + 1, arrayEnd(text, open));
}

/** Splits a command into unquoted tokens. Backslash-newline counts as space. */
function tokenize(command: string): string[] {
  const joined = command.replace(/\\\r?\n/g, " ");
  return (joined.match(TOKEN_RE) ?? []).map((token) =>
    QUOTE_CHARS.has(token[0]) ? token.slice(1, -1) : token,
  );
}

/** True for an exact display argument: ":<digits>" or a template ":${...}". */
function isDisplayToken(token: string): boolean {
  return /^:\d+$/.test(token) || token.startsWith(":${");
}

/** Index of the start of the last X server name in text[start, end), or -1. */
function lastXServerName(text: string, start: number, end: number): number {
  let last = -1;
  for (const match of text.slice(start, end).matchAll(X_SERVER_RE)) {
    last = start + match.index;
  }
  return last;
}

/**
 * The command or argument list that holds the "-displayfd" at `index`.
 * A quoted option inside an array gives the array items. Otherwise it is a
 * shell command from the nearest X server name (or the command start) to the
 * command end.
 */
function displayfdCommand(text: string, index: number): string {
  if (QUOTE_CHARS.has(text[index - 1])) {
    const open = enclosingArrayStart(text, index);
    if (open !== -1) return arrayItems(text, open);
  }
  const commandStart = shellCommandStart(text, index);
  const server = lastXServerName(text, commandStart, index);
  const start = server === -1 ? commandStart : server;
  return text.slice(start, shellCommandEnd(text, index));
}

/** Index of the first character at or after `from` that is not space or ",". */
function skipSeparators(text: string, from: number): number {
  let i = from;
  while (i < text.length && /[\s,]/.test(text[i])) i += 1;
  return i;
}

/**
 * The arguments that follow an "xvfb-run" match that ends at `end`.
 * `quoted` is true when the name was a quoted string. Arguments are the next
 * array, the rest of the enclosing array, or the rest of the shell command.
 */
function xvfbRunArgs(text: string, end: number, quoted: boolean): string {
  const next = skipSeparators(text, end);
  if (text[next] === "[") return arrayItems(text, next);
  if (quoted && text[end] === ",") {
    const open = enclosingArrayStart(text, end);
    if (open !== -1) return text.slice(end, arrayEnd(text, open));
  }
  return text.slice(end, shellCommandEnd(text, end));
}

type XvfbRunToken = "auto-display" | "command" | "takes-value" | "option";

/**
 * Classifies a cluster of short options such as "-ad" or "-dn1234". A "d"
 * before any value-taking option means auto-display. A value-taking option
 * ends the cluster; its value is the rest, or the next token when empty.
 */
function classifyShortCluster(token: string): XvfbRunToken {
  for (let i = 1; i < token.length; i += 1) {
    if (token[i] === "d") return "auto-display";
    if (XVFB_RUN_VALUE_OPTION_CHARS.has(token[i])) {
      return i === token.length - 1 ? "takes-value" : "option";
    }
  }
  return "option";
}

/** Classifies one xvfb-run token that appears before the command. */
function classifyXvfbRunToken(token: string): XvfbRunToken {
  if (token === "--auto-display") return "auto-display";
  if (XVFB_RUN_ARG_LONG_OPTIONS.has(token)) return "takes-value";
  if (token === "--" || !token.startsWith("-")) return "command";
  if (token.startsWith("--")) return "option";
  return classifyShortCluster(token);
}

/** True when xvfb-run options before the command include -d or --auto-display. */
function xvfbRunUsesAutoDisplay(args: string): boolean {
  const tokens = tokenize(args);
  for (let i = 0; i < tokens.length; i += 1) {
    const kind = classifyXvfbRunToken(tokens[i]);
    if (kind === "auto-display") return true;
    if (kind === "command") return false;
    if (kind === "takes-value") i += 1;
  }
  return false;
}

function finding(text: string, index: number, rule: DisplayFinding["rule"]): DisplayFinding {
  return { line: lineAt(text, index), rule, text: lineText(text, index) };
}

/** Rule (a): every "-displayfd" command must also pass an exact display. */
function findDisplayfdWithoutDisplay(text: string): DisplayFinding[] {
  const findings: DisplayFinding[] = [];
  for (const match of text.matchAll(/-displayfd\b/g)) {
    if (!tokenize(displayfdCommand(text, match.index)).some(isDisplayToken)) {
      findings.push(finding(text, match.index, "displayfd-without-display"));
    }
  }
  return findings;
}

/** Rule (b): xvfb-run must not get -d or --auto-display before its command. */
function findXvfbRunAutoDisplay(text: string): DisplayFinding[] {
  const findings: DisplayFinding[] = [];
  for (const match of text.matchAll(/\bxvfb-run\b(["'`]?)/g)) {
    const end = match.index + match[0].length;
    if (xvfbRunUsesAutoDisplay(xvfbRunArgs(text, end, match[1] !== ""))) {
      findings.push(finding(text, match.index, "xvfb-run-auto-display"));
    }
  }
  return findings;
}

/** Finds unsafe X server starts in one file's text. */
function findUnsafeDisplayUses(text: string): DisplayFinding[] {
  return [...findDisplayfdWithoutDisplay(text), ...findXvfbRunAutoDisplay(text)];
}

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "target", ".git"]);
const SELF = fileURLToPath(import.meta.url);

function listScannableFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listScannableFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function scanRoots(): string[] {
  const roots = [
    path.join(repoRoot, "test"),
    path.join(repoRoot, "scripts"),
    path.join(repoRoot, ".github"),
  ];
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    roots.push(path.join(packagesDir, entry.name, "src"));
    roots.push(path.join(packagesDir, entry.name, "test"));
  }
  return roots;
}

function readTextFile(file: string): string | undefined {
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 8192).includes(0)) return undefined;
  return buffer.toString("utf8");
}

describe("static: no X server start can take the host display", () => {
  it("finds no unsafe -displayfd or xvfb-run use in repo sources", () => {
    const files = scanRoots()
      .flatMap(listScannableFiles)
      .filter((file) => file !== SELF && !/\.min\.js$|\.map$/.test(file));
    let scanned = 0;
    const findings: string[] = [];
    for (const file of files) {
      const text = readTextFile(file);
      if (text === undefined) continue;
      scanned += 1;
      for (const finding of findUnsafeDisplayUses(text)) {
        findings.push(
          `${path.relative(repoRoot, file)}:${finding.line} ${finding.rule}: ${finding.text}`,
        );
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(findings).toEqual([]);
  });
});

describe("findUnsafeDisplayUses", () => {
  it.each([
    ['const args = ["-displayfd", "3", "-nolisten", "tcp"];', "displayfd-without-display"],
    ['spawn("Xvfb", ["-displayfd", "3", "-nolisten", "tcp"]);', "displayfd-without-display"],
    ["Xvfb -displayfd 3 -screen 0 1280x720x24 &", "displayfd-without-display"],
    ["xvfb-run -d cmd", "xvfb-run-auto-display"],
    ["xvfb-run --auto-display cmd", "xvfb-run-auto-display"],
    ['execFile("xvfb-run", ["-s", "-screen 0 1x1x24", "-d", "cmd"]);', "xvfb-run-auto-display"],
    ["xvfb-run -ad cmd", "xvfb-run-auto-display"],
    ["xvfb-run -dn1234 echo hello", "xvfb-run-auto-display"],
    ['execFile("xvfb-run", [\n  "-d",\n  "bun", "run", "test",\n]);', "xvfb-run-auto-display"],
    ['spawnSync("env", ["xvfb-run",\n  "-d", "cmd"]);', "xvfb-run-auto-display"],
    ["xvfb-run \\\n  -d \\\n  bun run test", "xvfb-run-auto-display"],
    ["Xvfb -auth /tmp/auth:1234 -displayfd 3", "displayfd-without-display"],
    ["Xephyr -displayfd 3 &", "displayfd-without-display"],
    ["echo :1234; Xwayland -displayfd 3", "displayfd-without-display"],
  ])("flags %s", (sample, rule) => {
    const findings = findUnsafeDisplayUses(`// first line\n${sample}\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 2, rule });
  });

  it.each([
    'const args = [`:${randomInt(1_000, 30_000)}`, "-displayfd", "3"];',
    "Xvfb :99 -displayfd 1",
    'spawn("Xvfb", [":1234", "-displayfd", "3"]);',
    "xvfb-run -a cmd",
    "xvfb-run -a docker run -d image",
    "xvfb-run -n 99 cmd -d",
    "xvfb-run -n1234 cmd -d",
    "xvfb-run -a cmd; other -d",
    "xvfb-run \\\n  -a \\\n  bun run test -d",
    'execFile("xvfb-run", [\n  "-a",\n  "docker", "run", "-d",\n]);',
    "Xvfb -displayfd 3 :1234",
    "Xvfb :0 -displayfd 3",
    "Xvfb \\\n  :1234 \\\n  -displayfd 3",
    "const args = [\n  `:${randomInt(1_000, 30_000)}`,\n  \"-displayfd\",\n  \"3\",\n];",
  ])("allows %s", (sample) => {
    expect(findUnsafeDisplayUses(sample)).toEqual([]);
  });

  it("ignores a display from an earlier line or statement", () => {
    const shell = "x11vnc -connect localhost:5900\nsleep 1\nXvfb -displayfd 3\n";
    expect(findUnsafeDisplayUses(shell)).toMatchObject([
      { line: 3, rule: "displayfd-without-display" },
    ]);
    const code = 'const display = [":1234"];\nconst args = ["-displayfd", "3"];\n';
    expect(findUnsafeDisplayUses(code)).toMatchObject([
      { line: 2, rule: "displayfd-without-display" },
    ]);
  });
});
