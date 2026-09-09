import { describe, expect, it } from "vitest";
import {
  atTomlTopLevel,
  initialTomlScanState,
  scanTomlLine,
  type TomlScanState,
} from "../src/tomlScan.js";

/** Whether each line of `source` starts at the top level of the document. */
function topLevelLines(source: string): boolean[] {
  let state: TomlScanState = initialTomlScanState();
  return source.split("\n").map((line) => {
    const top = atTomlTopLevel(state);
    state = scanTomlLine(line, state);
    return top;
  });
}

describe("scanTomlLine", () => {
  it("treats plain headers and key/value lines as top level", () => {
    expect(topLevelLines('[a]\nk = "v"\n[ b."c.d" ] # c\n')).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("keeps lines inside a multiline basic string off the top level", () => {
    const source =
      'A = """\n[profile]\nsay \\"hi\\" # no\n"""\n[next]\n';
    expect(topLevelLines(source)).toEqual([true, false, false, false, true, true]);
  });

  it("keeps lines inside a multiline literal string off the top level", () => {
    const source = "A = '''\n[profile]\n\\ no escapes '\n'''\n[next]\n";
    expect(topLevelLines(source)).toEqual([true, false, false, false, true, true]);
  });

  it("closes a multiline string that ends mid-line and continues scanning", () => {
    const source = 'A = """\n[x]\n""" B = """\n[y]\n"""\n[z]\n';
    expect(topLevelLines(source)).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("allows one or two extra quotes before the closing delimiter", () => {
    expect(topLevelLines('A = """\nq""""\n[z]\n')).toEqual([true, false, true, true]);
    expect(topLevelLines('A = """\nq"""""\n[z]\n')).toEqual([true, false, true, true]);
    expect(topLevelLines('A = """\nq""\n[z]\n')).toEqual([true, false, false, false]);
  });

  it("keeps a line-ending backslash inside a basic multiline string open", () => {
    expect(topLevelLines('A = """\\\n[x]\n"""\n[z]\n')).toEqual([
      true,
      false,
      false,
      true,
      true,
    ]);
  });

  it("does not open a string from quotes inside a comment", () => {
    expect(topLevelLines('k = 1 # """\n[z]\n')).toEqual([true, true, true]);
  });

  it("ignores escaped and literal quotes on single-line strings", () => {
    const source = 'k = "a \\" \\"\\"\\" b"\nj = \'x"""y\'\n[z]\n';
    expect(topLevelLines(source)).toEqual([true, true, true, true]);
  });

  it("tracks multi-line arrays and inline tables as open values", () => {
    const source =
      'args = [\n  "[x]",\n  { a = [\n    1 ] },\n]\n[z]\nt = { a = "]" }\n[y]\n';
    expect(topLevelLines(source)).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it("never lets stray closing brackets push depth negative", () => {
    expect(scanTomlLine("]]}", initialTomlScanState())).toEqual({ depth: 0 });
    expect(topLevelLines("]\n[z]\n")).toEqual([true, true, true]);
  });

  it("handles CRLF line endings", () => {
    expect(topLevelLines('A = """\r\n[x]\r\n"""\r\n[z]\r\n')).toEqual([
      true,
      false,
      false,
      true,
      true,
    ]);
  });
});
