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
const QUOTE_CHARS = new Set(['"', "'", "`"]);
const SHELL_END_CHARS = new Set([";", "|", "&", "\n"]);
const SEPARATOR_CHARS = new Set([",", "(", ")"]);
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

/**
 * "shell" reads one shell command: it ends at ";", "|", "&" or a newline
 * outside quotes. "array" reads JS array items: it ends at the "]" that
 * closes the array, and each quoted string is one token.
 */
type LexMode = "shell" | "array";

interface Token {
  /** The word with quotes removed. */
  value: string;
  /** True when the word holds a quoted part. */
  quoted: boolean;
  start: number;
}

interface Lexed {
  tokens: Token[];
  end: number;
}

/**
 * A small quote-aware lexer. It tracks single, double and backtick quotes
 * and backslash escapes, so terminators and "]" count only outside quotes.
 * Backslash-newline is whitespace. Shell "#" comments that start a token
 * are dropped. JS "//" and block comments that start a token are dropped
 * only in JS context. In shell mode a bare word absorbs adjacent quoted
 * parts, so --name="a b" is one token.
 */
class CommandLexer {
  private i: number;
  private depth = 0;
  private readonly tokens: Token[] = [];

  constructor(
    private readonly text: string,
    from: number,
    private readonly mode: LexMode,
    private readonly jsComments: boolean,
  ) {
    this.i = from;
  }

  run(): Lexed {
    while (this.i < this.text.length && !this.atCommandEnd()) this.step();
    return { tokens: this.tokens, end: this.i };
  }

  private atCommandEnd(): boolean {
    const c = this.text[this.i];
    if (this.mode === "shell") return SHELL_END_CHARS.has(c);
    return c === "]" && this.depth === 0;
  }

  private step(): void {
    if (this.skipContinuation() || this.skipComment() || this.skipNesting()) return;
    const c = this.text[this.i];
    if (/\s/.test(c) || SEPARATOR_CHARS.has(c)) {
      this.i += 1;
      return;
    }
    this.readWord();
  }

  /** Length of a backslash-newline at `at`, or 0. */
  private continuationLength(at: number): number {
    if (this.text[at] !== "\\") return 0;
    if (this.text[at + 1] === "\n") return 2;
    return this.text.startsWith("\r\n", at + 1) ? 3 : 0;
  }

  private skipContinuation(): boolean {
    const length = this.continuationLength(this.i);
    this.i += length;
    return length > 0;
  }

  private skipComment(): boolean {
    const rest = this.text.slice(this.i, this.i + 2);
    if (this.jsComments && rest === "/*") {
      const close = this.text.indexOf("*/", this.i + 2);
      this.i = close === -1 ? this.text.length : close + 2;
      return true;
    }
    const jsLine = this.jsComments && rest === "//";
    if (jsLine || (this.mode === "shell" && rest.startsWith("#"))) {
      const newline = this.text.indexOf("\n", this.i);
      this.i = newline === -1 ? this.text.length : newline;
      return true;
    }
    return false;
  }

  /** Tracks nested arrays in array mode. */
  private skipNesting(): boolean {
    if (this.mode !== "array") return false;
    const c = this.text[this.i];
    if (c === "[") this.depth += 1;
    else if (c === "]") this.depth -= 1;
    else return false;
    this.i += 1;
    return true;
  }

  private atWordEnd(start: number): boolean {
    const c = this.text[this.i];
    if (/\s/.test(c) || SEPARATOR_CHARS.has(c)) return true;
    if (this.mode === "array") {
      return c === "[" || c === "]" || (QUOTE_CHARS.has(c) && this.i > start);
    }
    return SHELL_END_CHARS.has(c) || this.continuationLength(this.i) > 0;
  }

  private readWord(): void {
    const start = this.i;
    let value = "";
    let quoted = false;
    while (this.i < this.text.length && !this.atWordEnd(start)) {
      const c = this.text[this.i];
      if (QUOTE_CHARS.has(c)) {
        value += this.readQuoted(c);
        quoted = true;
        if (this.mode === "array") break;
      } else {
        value += this.readPlainChar(c);
      }
    }
    this.tokens.push({ value, quoted, start });
  }

  /** Reads one unquoted character. A backslash escapes the next one. */
  private readPlainChar(c: string): string {
    const step = c === "\\" ? 2 : 1;
    const value = this.text.slice(this.i + step - 1, this.i + step);
    this.i += step;
    return value;
  }

  /** Reads a quoted part from its opening quote and returns its content. */
  private readQuoted(quote: string): string {
    const escapes = !(this.mode === "shell" && quote === "'");
    let value = "";
    this.i += 1;
    while (this.i < this.text.length && this.text[this.i] !== quote) {
      const step = escapes && this.text[this.i] === "\\" ? 2 : 1;
      value += this.text.slice(this.i + step - 1, this.i + step);
      this.i += step;
    }
    this.i += 1;
    return value;
  }
}

/** Lexes JS array items. JS comments always apply inside an array literal. */
function lexArray(text: string, from: number): Lexed {
  return new CommandLexer(text, from, "array", true).run();
}

/**
 * True when shell text that starts at `start` is JS context: a JS file,
 * and not the start of a JS string. Shell text in a string is not JS.
 */
function isJsContext(text: string, start: number, jsFile: boolean): boolean {
  return jsFile && !QUOTE_CHARS.has(text[start - 1]);
}

/** Lexes one shell command that starts at `from`. */
function lexShell(text: string, from: number, jsFile: boolean, contextStart = from): Lexed {
  const jsComments = isJsContext(text, contextStart, jsFile);
  return new CommandLexer(text, from, "shell", jsComments).run();
}

/** True when the lexed command holds the "-displayfd" at `index`, quoted or not. */
function holdsDisplayfd(lexed: Lexed, index: number): boolean {
  return lexed.tokens.some(
    (token) => token.start === index || (token.quoted && token.start === index - 1),
  );
}

/** Index just after the last unescaped newline before `index`, or 0. */
function logicalLineStart(text: string, index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (text[i] === "\n" && text[i - 1] !== "\\") return i + 1;
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

/** Index of the start of the last X server name before `index`, or -1. */
function lastXServerName(text: string, index: number): number {
  let last = -1;
  for (const match of text.slice(0, index).matchAll(X_SERVER_RE)) last = match.index;
  return last;
}

/** True for an exact display argument: ":<digits>" or a template ":${...}". */
function isDisplayToken(token: string): boolean {
  return /^:\d+$/.test(token) || token.startsWith(":${");
}

/**
 * True when the command passes a display as an argument. A display counts
 * when it is the first argument or follows a token that is not an option,
 * so "-auth :1234" does not count. This also flags "Xvfb -noreset :1234
 * -displayfd 3"; the fix is to put the display first.
 */
function hasDisplayArgument(tokens: Token[]): boolean {
  return tokens.some(
    (token, i) =>
      isDisplayToken(token.value) && (i === 0 || !tokens[i - 1].value.startsWith("-")),
  );
}

/**
 * Tokens of the array that holds the quoted "-displayfd" at `index`, or
 * undefined when it is not inside an unclosed "[".
 */
function displayfdArrayTokens(text: string, index: number): Token[] | undefined {
  if (!QUOTE_CHARS.has(text[index - 1])) return undefined;
  const open = enclosingArrayStart(text, index);
  if (open === -1) return undefined;
  const lexed = lexArray(text, open + 1);
  return holdsDisplayfd(lexed, index) ? lexed.tokens : undefined;
}

/** Lexes command by command from the logical line start to the one that holds `index`. */
function lineCommandTokens(text: string, index: number, jsFile: boolean): Token[] | undefined {
  let from = logicalLineStart(text, index);
  while (from <= index) {
    const lexed = lexShell(text, from, jsFile);
    if (holdsDisplayfd(lexed, index)) return lexed.tokens;
    from = lexed.end + 1;
  }
  return undefined;
}

/**
 * Tokens of the shell command that holds `index`: from its X server name,
 * else the command on the same logical line, else from `index` itself.
 */
function displayfdShellTokens(text: string, index: number, jsFile: boolean): Token[] {
  const server = lastXServerName(text, index);
  if (server !== -1) {
    const lexed = lexShell(text, server, jsFile);
    if (holdsDisplayfd(lexed, index)) return lexed.tokens;
  }
  return lineCommandTokens(text, index, jsFile) ?? lexShell(text, index, jsFile).tokens;
}

/** The command or argument list that holds the "-displayfd" at `index`. */
function displayfdTokens(text: string, index: number, jsFile: boolean): Token[] {
  return displayfdArrayTokens(text, index) ?? displayfdShellTokens(text, index, jsFile);
}

/** Index of the first character at or after `from` that is not space or ",". */
function skipSeparators(text: string, from: number): number {
  let i = from;
  while (i < text.length && /[\s,]/.test(text[i])) i += 1;
  return i;
}

/** True when the quoted name that opens at `quote` follows "[" or ",". */
function isArrayElement(text: string, quote: number): boolean {
  let i = quote - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  return text[i] === "[" || text[i] === ",";
}

/** The xvfb-run arguments that follow the match, and whether they are array items. */
function xvfbRunArgs(
  text: string,
  match: RegExpExecArray,
  jsFile: boolean,
): { tokens: Token[]; array: boolean } {
  const end = match.index + match[0].length;
  const next = skipSeparators(text, end);
  if (text[next] === "[") return { tokens: lexArray(text, next + 1).tokens, array: true };
  if (match[1] !== "" && isArrayElement(text, match.index - 1)) {
    return { tokens: lexArray(text, end).tokens, array: true };
  }
  return { tokens: lexShell(text, end, jsFile, match.index).tokens, array: false };
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

/**
 * Classifies one token in context. An unquoted array item is a spread or a
 * variable, so it counts as options; only a quoted string ends the options.
 */
function classifyXvfbRunArg(token: Token, array: boolean): XvfbRunToken {
  if (array && !token.quoted) return "option";
  return classifyXvfbRunToken(token.value);
}

/** True when xvfb-run options before the command include -d or --auto-display. */
function xvfbRunUsesAutoDisplay(tokens: Token[], array: boolean): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const kind = classifyXvfbRunArg(tokens[i], array);
    if (kind === "auto-display") return true;
    if (kind === "command") return false;
    if (kind === "takes-value") i += 1;
  }
  return false;
}

function finding(text: string, index: number, rule: DisplayFinding["rule"]): DisplayFinding {
  return { line: lineAt(text, index), rule, text: lineText(text, index) };
}

/** Rule (a): every "-displayfd" command must also pass a display argument. */
function findDisplayfdWithoutDisplay(text: string, jsFile: boolean): DisplayFinding[] {
  const findings: DisplayFinding[] = [];
  for (const match of text.matchAll(/-displayfd\b/g)) {
    if (!hasDisplayArgument(displayfdTokens(text, match.index, jsFile))) {
      findings.push(finding(text, match.index, "displayfd-without-display"));
    }
  }
  return findings;
}

/** Rule (b): xvfb-run must not get -d or --auto-display before its command. */
function findXvfbRunAutoDisplay(text: string, jsFile: boolean): DisplayFinding[] {
  const findings: DisplayFinding[] = [];
  for (const match of text.matchAll(/\bxvfb-run\b(["'`]?)/g)) {
    const { tokens, array } = xvfbRunArgs(text, match, jsFile);
    if (xvfbRunUsesAutoDisplay(tokens, array)) {
      findings.push(finding(text, match.index, "xvfb-run-auto-display"));
    }
  }
  return findings;
}

const JS_FILE_RE = /\.(?:[cm]?js|jsx|tsx?)$/;

/**
 * Finds unsafe X server starts in one file's text. `jsFile` enables JS
 * comments in shell text outside strings, as in .ts or .js files.
 */
function findUnsafeDisplayUses(text: string, jsFile: boolean): DisplayFinding[] {
  return [
    ...findDisplayfdWithoutDisplay(text, jsFile),
    ...findXvfbRunAutoDisplay(text, jsFile),
  ];
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
      for (const finding of findUnsafeDisplayUses(text, JS_FILE_RE.test(file))) {
        findings.push(
          `${path.relative(repoRoot, file)}:${finding.line} ${finding.rule}: ${finding.text}`,
        );
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(findings).toEqual([]);
  });
});

/** Samples that start with JS code are scanned as a JS file, others as shell. */
function isJsSample(sample: string): boolean {
  return /^(?:const |[\w.]+\()/.test(sample);
}

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
    ["xvfb-run -e '/tmp/log;a' -d cmd", "xvfb-run-auto-display"],
    ['spawn("xvfb-run", ["-e", "/tmp/log]a", "-d", "cmd"]);', "xvfb-run-auto-display"],
    ['execFile("xvfb-run", [...BASE_FLAGS, "-d", "bun", "run", "test"]);', "xvfb-run-auto-display"],
    ['spawn("env", ["xvfb-run", flags, "-d", "cmd"]);', "xvfb-run-auto-display"],
    ['xvfb-run -s "-dpi 96" -d cmd', "xvfb-run-auto-display"],
    ['xvfb-run --server-args "-dpi 96" -d cmd', "xvfb-run-auto-display"],
    ["Xvfb -displayfd 3 # :1234", "displayfd-without-display"],
    ["Xvfb -displayfd 3", "displayfd-without-display"],
    ["echo :1234; Xvfb -displayfd 3", "displayfd-without-display"],
    ['Xvfb "-displayfd" 3', "displayfd-without-display"],
    ["xvfb-run -e //tmp/errors -d cmd", "xvfb-run-auto-display"],
    ['execSync("xvfb-run -e //tmp/errors -d cmd");', "xvfb-run-auto-display"],
    ['spawn("Xvfb", [/* ":1234", */ "-displayfd", "3"]);', "displayfd-without-display"],
    ['spawn("Xvfb", ["-displayfd", "3", "-auth", ":1234"]);', "displayfd-without-display"],
    // Deliberate: a display after an option counts as its value. Put the display first.
    ["Xvfb -noreset :1234 -displayfd 3", "displayfd-without-display"],
  ])("flags %s", (sample, rule) => {
    const findings = findUnsafeDisplayUses(`// first line\n${sample}\n`, isJsSample(sample));
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
    'Xvfb :1234 -auth "/tmp/auth;file" -displayfd 3',
    'xvfb-run -a --server-args="-dpi 96 -screen 0 1x1x24" bun run test',
    'xvfb-run -s "-dpi 96 -screen 0 1x1x24" bun run test -d',
    'xvfb-run --server-args "-dpi 96 -screen 0 1x1x24" bun run test -d',
    'execFile("xvfb-run", [...BASE_FLAGS, "bun", "run", "test", "-d"]);',
    '"$XVFB_BIN" :1234 -displayfd 3 &',
    "echo Xvfb; wrapper :1234 -displayfd 3",
    'which Xvfb\n"$XVFB_BIN" :1234 -displayfd 3 &',
    'Xvfb :1234 "-displayfd" 3',
  ])("allows %s", (sample) => {
    expect(findUnsafeDisplayUses(sample, isJsSample(sample))).toEqual([]);
  });

  it("ignores a display from an earlier line or statement", () => {
    const shell = "x11vnc -connect localhost:5900\nsleep 1\nXvfb -displayfd 3\n";
    expect(findUnsafeDisplayUses(shell, false)).toMatchObject([
      { line: 3, rule: "displayfd-without-display" },
    ]);
    const code = 'const display = [":1234"];\nconst args = ["-displayfd", "3"];\n';
    expect(findUnsafeDisplayUses(code, true)).toMatchObject([
      { line: 2, rule: "displayfd-without-display" },
    ]);
  });

  it("drops JS comments only in JS context", () => {
    const sample = "Xvfb -displayfd 3 // :1234\n";
    expect(findUnsafeDisplayUses(sample, true)).toMatchObject([
      { line: 1, rule: "displayfd-without-display" },
    ]);
    // In shell, "//" is a path argument, so the display after it counts.
    expect(findUnsafeDisplayUses(sample, false)).toEqual([]);
  });
});
