import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runDesktopDoubleClick,
  runDesktopDrag,
  runDesktopMove,
  runDesktopScroll,
} from "../src/commands/desktop.js";
import { buildProgram } from "../src/program.js";

let tmpDir: string;
let savedPickforgeHome: string | undefined;
let logs: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-lab-desktop-input-"));
  savedPickforgeHome = process.env.PICKFORGE_HOME;
  process.env.PICKFORGE_HOME = path.join(tmpDir, "home");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logs.push(line);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedPickforgeHome === undefined) {
    delete process.env.PICKFORGE_HOME;
  } else {
    process.env.PICKFORGE_HOME = savedPickforgeHome;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = 0;
});

function lastReport(): Record<string, any> {
  return JSON.parse(logs[logs.length - 1]) as Record<string, any>;
}

const opts = { json: true } as const;

describe("runDesktopMove validation", () => {
  it("rejects non-integer coordinates before touching a session", async () => {
    expect(await runDesktopMove("1.5", "2", opts)).toBe(1);
    expect(lastReport().errors[0]).toContain("non-negative integer");
    expect(await runDesktopMove("3", "-4", opts)).toBe(1);
    expect(lastReport().errors[0]).toContain("non-negative integer");
  });
});

describe("runDesktopScroll validation", () => {
  it("rejects non-integer and oversized deltas", async () => {
    expect(await runDesktopScroll("0.5", "1", opts)).toBe(1);
    expect(lastReport().errors[0]).toContain('Invalid deltaX "0.5"');
    expect(await runDesktopScroll("1", "101", opts)).toBe(1);
    expect(lastReport().errors[0]).toContain("at most 100 wheel steps");
    expect(await runDesktopScroll("-101", "1", opts)).toBe(1);
    expect(lastReport().errors[0]).toContain("at most 100 wheel steps");
  });

  it("rejects zero deltas and malformed --at positions", async () => {
    expect(await runDesktopScroll("0", "0", opts)).toBe(1);
    expect(lastReport().errors[0]).toContain("non-zero");
    expect(await runDesktopScroll("0", "1", { ...opts, at: "1;2" })).toBe(1);
    expect(lastReport().errors[0]).toContain('Invalid --at "1;2"');
    expect(await runDesktopScroll("0", "1", { ...opts, at: "-1,2" })).toBe(1);
    expect(lastReport().errors[0]).toContain('Invalid --at "-1,2"');
  });
});

describe("runDesktopDrag validation", () => {
  it("rejects bad coordinates, buttons, and durations", async () => {
    expect(await runDesktopDrag("a", "0", "1", "1", opts)).toBe(1);
    expect(lastReport().errors[0]).toContain('Invalid fromX "a"');
    expect(
      await runDesktopDrag("0", "0", "1", "1", { ...opts, button: "10" }),
    ).toBe(1);
    expect(lastReport().errors[0]).toContain("between 1 and 9");
    expect(
      await runDesktopDrag("0", "0", "1", "1", { ...opts, duration: "10001" }),
    ).toBe(1);
    expect(lastReport().errors[0]).toContain("between 0 and 10000");
    expect(
      await runDesktopDrag("0", "0", "1", "1", { ...opts, duration: "-5" }),
    ).toBe(1);
    expect(lastReport().errors[0]).toContain('Invalid --duration "-5"');
  });
});

describe("runDesktopDoubleClick validation", () => {
  it("rejects bad coordinates, buttons, and intervals", async () => {
    expect(await runDesktopDoubleClick("1", "y", opts)).toBe(1);
    expect(lastReport().errors[0]).toContain('Invalid y "y"');
    expect(
      await runDesktopDoubleClick("1", "1", { ...opts, button: "0" }),
    ).toBe(1);
    expect(lastReport().errors[0]).toContain("between 1 and 9");
    expect(
      await runDesktopDoubleClick("1", "1", { ...opts, interval: "2001" }),
    ).toBe(1);
    expect(lastReport().errors[0]).toContain("between 0 and 2000");
  });
});

describe("program wiring", () => {
  it("routes the new desktop input commands to their handlers", async () => {
    const cases: string[][] = [
      ["desktop", "move", "1", "2", "--json"],
      ["desktop", "scroll", "0", "0", "--json"],
      ["desktop", "drag", "0", "0", "1", "1", "--duration", "1.5", "--json"],
      ["desktop", "double-click", "1", "1", "--interval", "0.5", "--json"],
    ];
    for (const argv of cases) {
      process.exitCode = 0;
      await buildProgram().parseAsync(argv, { from: "user" });
      expect(process.exitCode).toBe(1);
      expect(lastReport().ok).toBe(false);
    }
  });
});
