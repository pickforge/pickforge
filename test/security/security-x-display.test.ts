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

const EXPLICIT_DISPLAY_RE = /:(?:\d+\b|\$\{)/;
const XVFB_RUN_ARG_OPTIONS = new Set(["-e", "-f", "-n", "-p", "-s", "-w"]);
const XVFB_RUN_ARG_LONG_OPTIONS = new Set([
  "--error-file",
  "--auth-file",
  "--server-num",
  "--xauth-protocol",
  "--server-args",
  "--wait",
]);
const TOKEN_RE = /"[^"]*"|'[^']*'|`[^`]*`|[^\s,[\]()"'`]+/g;

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

type XvfbRunToken = "auto-display" | "command" | "takes-value" | "option";

/** Classifies one xvfb-run token that appears before the command. */
function classifyXvfbRunToken(token: string): XvfbRunToken {
  if (token === "--auto-display") return "auto-display";
  if (/^-[adhl]+$/.test(token) && token.includes("d")) return "auto-display";
  if (XVFB_RUN_ARG_OPTIONS.has(token) || XVFB_RUN_ARG_LONG_OPTIONS.has(token)) {
    return "takes-value";
  }
  if (token === "--" || !token.startsWith("-")) return "command";
  return "option";
}

/** True when xvfb-run options before the command include -d or --auto-display. */
function xvfbRunUsesAutoDisplay(rest: string): boolean {
  const tokens = (rest.match(TOKEN_RE) ?? []).map((token) =>
    /^["'`]/.test(token) ? token.slice(1, -1) : token,
  );
  for (let i = 0; i < tokens.length; i += 1) {
    const kind = classifyXvfbRunToken(tokens[i]);
    if (kind === "auto-display") return true;
    if (kind === "command") return false;
    if (kind === "takes-value") i += 1;
  }
  return false;
}

/**
 * Finds unsafe X server starts in one file's text.
 *
 * Rule (a): for each "-displayfd", take the text from the closest preceding
 * "[" or "Xvfb" (or the line start when neither exists). That text must hold
 * an explicit display: ":<digits>" or a template ":${...}".
 * Rule (b): xvfb-run must not get -d or --auto-display before its command.
 */
function findUnsafeDisplayUses(text: string): DisplayFinding[] {
  const findings: DisplayFinding[] = [];
  for (const match of text.matchAll(/-displayfd\b/g)) {
    const index = match.index;
    const anchor = Math.max(
      text.lastIndexOf("[", index),
      text.lastIndexOf("Xvfb", index),
    );
    const start = anchor === -1 ? text.lastIndexOf("\n", index - 1) + 1 : anchor;
    const window = text.slice(start, index);
    if (!EXPLICIT_DISPLAY_RE.test(window)) {
      findings.push({
        line: lineAt(text, index),
        rule: "displayfd-without-display",
        text: lineText(text, index),
      });
    }
  }
  for (const match of text.matchAll(/\bxvfb-run\b["'`]?([^\n]*)/g)) {
    if (xvfbRunUsesAutoDisplay(match[1])) {
      findings.push({
        line: lineAt(text, match.index),
        rule: "xvfb-run-auto-display",
        text: lineText(text, match.index),
      });
    }
  }
  return findings;
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
  ])("allows %s", (sample) => {
    expect(findUnsafeDisplayUses(sample)).toEqual([]);
  });
});
