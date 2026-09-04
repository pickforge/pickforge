import { describe, expect, it } from "vitest";
import { buildXvfbArgs, parseDisplayNumber } from "../src/display.js";
import { buildVncArgs, buildVncEnv } from "../src/vnc.js";
import { buildScreenshotCommand } from "../src/screenshot.js";
import {
  buildClickArgs,
  buildDoubleClickArgs,
  buildDragArgs,
  buildKeyArgs,
  buildMoveArgs,
  buildScrollArgs,
  buildTypeArgs,
} from "../src/input.js";

const INJECTION_STRINGS = ["; rm -rf /", "$(reboot)", "`reboot`", "a && b | c"];

describe("buildXvfbArgs", () => {
  it("builds args with defaults", () => {
    expect(buildXvfbArgs({ display: ":90" })).toEqual([
      ":90",
      "-screen",
      "0",
      "1280x800x24",
      "-nolisten",
      "tcp",
    ]);
  });

  it("builds args with custom geometry", () => {
    expect(
      buildXvfbArgs({ display: ":123", width: 1920, height: 1080, depth: 16 }),
    ).toEqual([":123", "-screen", "0", "1920x1080x16", "-nolisten", "tcp"]);
  });

  it("rejects invalid displays", () => {
    expect(() => buildXvfbArgs({ display: "90" })).toThrow(/display/i);
    expect(() => buildXvfbArgs({ display: ":90; rm -rf /" })).toThrow(
      /display/i,
    );
  });

  it("rejects non-positive geometry", () => {
    expect(() => buildXvfbArgs({ display: ":90", width: 0 })).toThrow(/width/i);
    expect(() => buildXvfbArgs({ display: ":90", height: -1 })).toThrow(
      /height/i,
    );
    expect(() => buildXvfbArgs({ display: ":90", depth: 1.5 })).toThrow(
      /depth/i,
    );
  });
});

describe("parseDisplayNumber", () => {
  it("parses :N displays", () => {
    expect(parseDisplayNumber(":0")).toBe(0);
    expect(parseDisplayNumber(":92")).toBe(92);
  });

  it("rejects malformed displays", () => {
    for (const bad of ["", ":", "92", ":92.0", ":92 ", "localhost:1", ...INJECTION_STRINGS]) {
      expect(() => parseDisplayNumber(bad)).toThrow(/display/i);
    }
  });
});

describe("buildVncArgs", () => {
  it("builds x11vnc args bound to loopback, view-only, by default", () => {
    const args = buildVncArgs({ display: ":92", port: 5992 });
    expect(args).toEqual([
      "-display",
      ":92",
      "-rfbport",
      "5992",
      "-localhost",
      "-forever",
      "-shared",
      "-nopw",
      "-viewonly",
      "-quiet",
    ]);
    expect(args).toContain("-localhost");
    expect(args).toContain("-viewonly");
  });

  it("omits view-only mode for an explicit writable control session", () => {
    const args = buildVncArgs({
      display: ":92",
      port: 5992,
      viewOnly: false,
    });
    expect(args).toContain("-localhost");
    expect(args).not.toContain("-viewonly");
  });

  it("rejects invalid ports", () => {
    expect(() => buildVncArgs({ display: ":92", port: 0 })).toThrow(/port/i);
    expect(() => buildVncArgs({ display: ":92", port: 65536 })).toThrow(
      /port/i,
    );
    expect(() => buildVncArgs({ display: ":92", port: 1.5 })).toThrow(/port/i);
  });
});

describe("buildVncEnv", () => {
  it("isolates x11vnc from the host Wayland session", () => {
    const env = buildVncEnv(":92", {
      PATH: "/test/bin",
      WAYLAND_DISPLAY: "wayland-1",
      WAYLAND_SOCKET: "42",
      XDG_SESSION_TYPE: "wayland",
    });

    expect(env.DISPLAY).toBe(":92");
    expect(env).not.toHaveProperty("WAYLAND_DISPLAY");
    expect(env).not.toHaveProperty("WAYLAND_SOCKET");
    expect(env.XDG_SESSION_TYPE).toBe("x11");
    expect(env.PATH).toBe("/test/bin");
  });
});

describe("buildScreenshotCommand", () => {
  it("builds the maim command, which targets the display via the DISPLAY env", () => {
    expect(buildScreenshotCommand("maim", ":92", "/tmp/out.png")).toEqual([
      {
        cmd: "maim",
        args: ["/tmp/out.png"],
        requiresDisplayEnv: true,
      },
    ]);
  });

  it("builds the import command", () => {
    expect(buildScreenshotCommand("import", ":92", "/tmp/out.png")).toEqual([
      {
        cmd: "import",
        args: ["-silent", "-display", ":92", "-window", "root", "/tmp/out.png"],
      },
    ]);
  });

  it("builds the xwd pipeline as discrete steps", () => {
    expect(buildScreenshotCommand("xwd", ":92", "/tmp/out.png")).toEqual([
      {
        cmd: "xwd",
        args: ["-root", "-silent", "-display", ":92", "-out", "/tmp/out.png.xwd"],
      },
      {
        cmd: "convert",
        args: ["xwd:/tmp/out.png.xwd", "png:/tmp/out.png"],
      },
    ]);
  });

  it("accepts an explicit xwd dump path for unique temp files", () => {
    expect(
      buildScreenshotCommand(
        "xwd",
        ":92",
        "/tmp/out.png",
        "/tmp/out.png.123-abcd.xwd",
      ),
    ).toEqual([
      {
        cmd: "xwd",
        args: [
          "-root",
          "-silent",
          "-display",
          ":92",
          "-out",
          "/tmp/out.png.123-abcd.xwd",
        ],
      },
      {
        cmd: "convert",
        args: ["xwd:/tmp/out.png.123-abcd.xwd", "png:/tmp/out.png"],
      },
    ]);
  });

  it("builds the scrot command, which targets the display via the DISPLAY env", () => {
    expect(buildScreenshotCommand("scrot", ":92", "/tmp/out.png")).toEqual([
      {
        cmd: "scrot",
        args: ["--overwrite", "/tmp/out.png"],
        requiresDisplayEnv: true,
      },
    ]);
  });
});

describe("buildClickArgs", () => {
  it("builds a left click by default", () => {
    expect(buildClickArgs({ x: 10, y: 20 })).toEqual([
      "mousemove",
      "--sync",
      "10",
      "20",
      "click",
      "1",
    ]);
  });

  it("supports other buttons", () => {
    expect(buildClickArgs({ x: 0, y: 0, button: 3 })).toEqual([
      "mousemove",
      "--sync",
      "0",
      "0",
      "click",
      "3",
    ]);
  });

  it("rejects non-integer coordinates and bad buttons", () => {
    expect(() => buildClickArgs({ x: 1.5, y: 0 })).toThrow(/x/i);
    expect(() => buildClickArgs({ x: 0, y: Number.NaN })).toThrow(/y/i);
    expect(() => buildClickArgs({ x: -1, y: 0 })).toThrow(/x/i);
    expect(() => buildClickArgs({ x: 0, y: 0, button: 0 })).toThrow(/button/i);
    expect(() => buildClickArgs({ x: 0, y: 0, button: 10 })).toThrow(
      /button/i,
    );
  });
});

describe("buildMoveArgs", () => {
  it("builds a synced mousemove", () => {
    expect(buildMoveArgs({ x: 15, y: 25 })).toEqual([
      "mousemove",
      "--sync",
      "15",
      "25",
    ]);
    expect(buildMoveArgs({ x: 0, y: 0 })).toEqual([
      "mousemove",
      "--sync",
      "0",
      "0",
    ]);
  });

  it("rejects invalid coordinates", () => {
    expect(() => buildMoveArgs({ x: -1, y: 0 })).toThrow(/x/i);
    expect(() => buildMoveArgs({ x: 0, y: 1.5 })).toThrow(/y/i);
    expect(() => buildMoveArgs({ x: Number.NaN, y: 0 })).toThrow(/x/i);
  });
});

describe("buildScrollArgs", () => {
  it("scrolls down with button 5, one step per delta", () => {
    expect(buildScrollArgs({ deltaX: 0, deltaY: 1 })).toEqual(["click", "5"]);
    expect(buildScrollArgs({ deltaX: 0, deltaY: 3 })).toEqual([
      "click",
      "--repeat",
      "3",
      "--delay",
      "25",
      "5",
    ]);
  });

  it("scrolls up with button 4", () => {
    expect(buildScrollArgs({ deltaX: 0, deltaY: -1 })).toEqual(["click", "4"]);
    expect(buildScrollArgs({ deltaX: 0, deltaY: -2 })).toEqual([
      "click",
      "--repeat",
      "2",
      "--delay",
      "25",
      "4",
    ]);
  });

  it("scrolls right with button 7 and left with button 6", () => {
    expect(buildScrollArgs({ deltaX: 1, deltaY: 0 })).toEqual(["click", "7"]);
    expect(buildScrollArgs({ deltaX: -1, deltaY: 0 })).toEqual(["click", "6"]);
  });

  it("orders horizontal before vertical when both are set", () => {
    expect(buildScrollArgs({ deltaX: 2, deltaY: -3 })).toEqual([
      "click",
      "--repeat",
      "2",
      "--delay",
      "25",
      "7",
      "click",
      "--repeat",
      "3",
      "--delay",
      "25",
      "4",
    ]);
  });

  it("moves to the position first when x and y are given", () => {
    expect(buildScrollArgs({ deltaX: 0, deltaY: 1, x: 40, y: 50 })).toEqual([
      "mousemove",
      "--sync",
      "40",
      "50",
      "click",
      "5",
    ]);
  });

  it("rejects zero deltas, half positions, and out-of-range steps", () => {
    expect(() => buildScrollArgs({ deltaX: 0, deltaY: 0 })).toThrow(
      /non-zero/i,
    );
    expect(() => buildScrollArgs({ deltaX: 0, deltaY: 1, x: 10 })).toThrow(
      /both x and y/i,
    );
    expect(() => buildScrollArgs({ deltaX: 0, deltaY: 1, y: 10 })).toThrow(
      /both x and y/i,
    );
    expect(() => buildScrollArgs({ deltaX: 0, deltaY: 1.5 })).toThrow(
      /deltaY/i,
    );
    expect(() => buildScrollArgs({ deltaX: 0.5, deltaY: 0 })).toThrow(
      /deltaX/i,
    );
    expect(() => buildScrollArgs({ deltaX: 0, deltaY: 101 })).toThrow(
      /deltaY/i,
    );
    expect(() => buildScrollArgs({ deltaX: -101, deltaY: 0 })).toThrow(
      /deltaX/i,
    );
    expect(() =>
      buildScrollArgs({ deltaX: 0, deltaY: 1, x: -1, y: 0 }),
    ).toThrow(/x/i);
  });
});

describe("buildDragArgs", () => {
  it("builds press, timed move, and release with defaults", () => {
    expect(
      buildDragArgs({ fromX: 10, fromY: 20, toX: 110, toY: 120 }),
    ).toEqual([
      "mousemove",
      "--sync",
      "10",
      "20",
      "mousedown",
      "1",
      "sleep",
      "0.15",
      "mousemove",
      "--sync",
      "110",
      "120",
      "sleep",
      "0.15",
      "mouseup",
      "1",
    ]);
  });

  it("threads button and duration through", () => {
    expect(
      buildDragArgs({
        fromX: 0,
        fromY: 0,
        toX: 5,
        toY: 5,
        button: 3,
        durationMs: 1000,
      }),
    ).toEqual([
      "mousemove",
      "--sync",
      "0",
      "0",
      "mousedown",
      "3",
      "sleep",
      "0.5",
      "mousemove",
      "--sync",
      "5",
      "5",
      "sleep",
      "0.5",
      "mouseup",
      "3",
    ]);
  });

  it("supports an instant drag with durationMs 0", () => {
    expect(
      buildDragArgs({ fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 0 }),
    ).toEqual([
      "mousemove",
      "--sync",
      "1",
      "2",
      "mousedown",
      "1",
      "sleep",
      "0",
      "mousemove",
      "--sync",
      "3",
      "4",
      "sleep",
      "0",
      "mouseup",
      "1",
    ]);
  });

  it("rejects invalid coordinates, buttons, and durations", () => {
    expect(() =>
      buildDragArgs({ fromX: -1, fromY: 0, toX: 1, toY: 1 }),
    ).toThrow(/fromX/i);
    expect(() =>
      buildDragArgs({ fromX: 0, fromY: 1.5, toX: 1, toY: 1 }),
    ).toThrow(/fromY/i);
    expect(() =>
      buildDragArgs({ fromX: 0, fromY: 0, toX: -2, toY: 1 }),
    ).toThrow(/toX/i);
    expect(() =>
      buildDragArgs({ fromX: 0, fromY: 0, toX: 1, toY: Number.NaN }),
    ).toThrow(/toY/i);
    expect(() =>
      buildDragArgs({ fromX: 0, fromY: 0, toX: 1, toY: 1, button: 0 }),
    ).toThrow(/button/i);
    expect(() =>
      buildDragArgs({ fromX: 0, fromY: 0, toX: 1, toY: 1, button: 10 }),
    ).toThrow(/button/i);
    expect(() =>
      buildDragArgs({ fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: -1 }),
    ).toThrow(/durationMs/i);
    expect(() =>
      buildDragArgs({ fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: 10_001 }),
    ).toThrow(/durationMs/i);
    expect(() =>
      buildDragArgs({ fromX: 0, fromY: 0, toX: 1, toY: 1, durationMs: 50.5 }),
    ).toThrow(/durationMs/i);
  });
});

describe("buildDoubleClickArgs", () => {
  it("builds a repeated click with the default interval", () => {
    expect(buildDoubleClickArgs({ x: 30, y: 40 })).toEqual([
      "mousemove",
      "--sync",
      "30",
      "40",
      "click",
      "--repeat",
      "2",
      "--delay",
      "100",
      "1",
    ]);
  });

  it("threads button and interval through", () => {
    expect(
      buildDoubleClickArgs({ x: 0, y: 0, button: 2, intervalMs: 250 }),
    ).toEqual([
      "mousemove",
      "--sync",
      "0",
      "0",
      "click",
      "--repeat",
      "2",
      "--delay",
      "250",
      "2",
    ]);
  });

  it("rejects invalid coordinates, buttons, and intervals", () => {
    expect(() => buildDoubleClickArgs({ x: -1, y: 0 })).toThrow(/x/i);
    expect(() => buildDoubleClickArgs({ x: 0, y: 2.5 })).toThrow(/y/i);
    expect(() => buildDoubleClickArgs({ x: 0, y: 0, button: 0 })).toThrow(
      /button/i,
    );
    expect(() => buildDoubleClickArgs({ x: 0, y: 0, button: 10 })).toThrow(
      /button/i,
    );
    expect(() =>
      buildDoubleClickArgs({ x: 0, y: 0, intervalMs: -1 }),
    ).toThrow(/intervalMs/i);
    expect(() =>
      buildDoubleClickArgs({ x: 0, y: 0, intervalMs: 2_001 }),
    ).toThrow(/intervalMs/i);
    expect(() =>
      buildDoubleClickArgs({ x: 0, y: 0, intervalMs: 10.5 }),
    ).toThrow(/intervalMs/i);
  });
});

describe("buildTypeArgs", () => {
  it("passes text as a single argv element after --", () => {
    expect(buildTypeArgs("hello world")).toEqual([
      "type",
      "--delay",
      "50",
      "--",
      "hello world",
    ]);
  });

  it("keeps shell metacharacters as literal text", () => {
    for (const text of INJECTION_STRINGS) {
      const args = buildTypeArgs(text);
      expect(args).toEqual(["type", "--delay", "50", "--", text]);
      expect(args[args.length - 1]).toBe(text);
    }
  });

  it("rejects empty text", () => {
    expect(() => buildTypeArgs("")).toThrow(/text/i);
  });
});

describe("buildKeyArgs", () => {
  it("builds key combos after --", () => {
    expect(buildKeyArgs("ctrl+shift+t")).toEqual(["key", "--", "ctrl+shift+t"]);
    expect(buildKeyArgs("Return")).toEqual(["key", "--", "Return"]);
  });

  it("keeps shell metacharacters as literal argv", () => {
    for (const key of INJECTION_STRINGS) {
      expect(buildKeyArgs(key)).toEqual(["key", "--", key]);
    }
  });

  it("rejects empty keys", () => {
    expect(() => buildKeyArgs("")).toThrow(/key/i);
  });
});
