/**
 * Minimal line scanner that tracks enough TOML lexical state to tell whether
 * a line begins at the top level of the document, i.e. outside any multiline
 * string and outside any value still open from a previous line (arrays or
 * inline tables spanning lines). Only lines that begin at the top level can
 * be table headers. This is deliberately not a TOML parser: it never
 * interprets keys or values, it only skips over string contents, comments and
 * bracket nesting.
 */

type Quote = '"' | "'";

export interface TomlScanState {
  /** Quote character of the multiline string left open by previous lines. */
  multiline?: Quote;
  /** Open `[` / `{` value delimiters carried over from previous lines. */
  depth: number;
}

export function initialTomlScanState(): TomlScanState {
  return { depth: 0 };
}

export function atTomlTopLevel(state: TomlScanState): boolean {
  return state.multiline === undefined && state.depth === 0;
}

function isQuote(char: string | undefined): char is Quote {
  return char === '"' || char === "'";
}

function quoteRun(line: string, index: number, quote: Quote): number {
  let count = 0;
  while (line[index + count] === quote) {
    count += 1;
  }
  return count;
}

/**
 * Scans the inside of a multiline string from `start`. Returns the index just
 * past the closing delimiter, or `undefined` when the string continues on the
 * next line. Basic strings honour backslash escapes; literal strings do not.
 * A run of three or more quotes closes the string with its last three quotes,
 * the preceding one or two belong to the content, per the TOML spec.
 */
function scanMultiline(
  line: string,
  start: number,
  quote: Quote,
): number | undefined {
  let index = start;
  while (index < line.length) {
    const char = line[index];
    if (quote === '"' && char === "\\") {
      index += 2;
    } else if (char === quote) {
      const run = quoteRun(line, index, quote);
      if (run >= 3) {
        return index + run;
      }
      index += run;
    } else {
      index += 1;
    }
  }
  return undefined;
}

/**
 * Scans a single-line string from its opening quote at `start`. Returns the
 * index just past the closing quote, or the line length when unterminated.
 */
function scanSingleLine(line: string, start: number, quote: Quote): number {
  let index = start + 1;
  while (index < line.length) {
    const char = line[index];
    if (quote === '"' && char === "\\") {
      index += 2;
    } else if (char === quote) {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return line.length;
}

/**
 * Scans a string opened by the quote at `index`. Returns the index to resume
 * from, or `undefined` when a multiline string stays open past the line end.
 */
function scanString(line: string, index: number, quote: Quote): number | undefined {
  if (line.startsWith(quote.repeat(3), index)) {
    return scanMultiline(line, index + 3, quote);
  }
  return scanSingleLine(line, index, quote);
}

function bracketDelta(char: string | undefined): number {
  if (char === "[" || char === "{") {
    return 1;
  }
  if (char === "]" || char === "}") {
    return -1;
  }
  return 0;
}

/**
 * Scans one line (without its terminating newline) and returns the lexical
 * state at the start of the next line.
 */
export function scanTomlLine(line: string, state: TomlScanState): TomlScanState {
  let depth = state.depth;
  let index = 0;
  if (state.multiline !== undefined) {
    const resume = scanMultiline(line, 0, state.multiline);
    if (resume === undefined) {
      return state;
    }
    index = resume;
  }
  while (index < line.length) {
    const char = line[index];
    if (char === "#") {
      break;
    }
    if (isQuote(char)) {
      const resume = scanString(line, index, char);
      if (resume === undefined) {
        return { depth, multiline: char };
      }
      index = resume;
      continue;
    }
    depth = Math.max(0, depth + bracketDelta(char));
    index += 1;
  }
  return { depth };
}
