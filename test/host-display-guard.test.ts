import { describe, expect, it } from "vitest";
import {
  describeSocketChange,
  displaySocketPath,
  socketChangeError,
  type SocketState,
} from "./host-display-guard.js";

describe("host display guard", () => {
  it("maps local DISPLAY values to their path socket", () => {
    expect(displaySocketPath(":0")).toBe("/tmp/.X11-unix/X0");
    expect(displaySocketPath(":12.1")).toBe("/tmp/.X11-unix/X12");
  });

  it("ignores unset, empty, and non-local DISPLAY values", () => {
    for (const display of [undefined, "", "localhost:0", ":", ":x", "0", ":1.", "wayland-1"]) {
      expect({ display, path: displaySocketPath(display) }).toEqual({
        display,
        path: undefined,
      });
    }
  });

  it("reports created, removed, and replaced sockets", () => {
    const absent: SocketState = { kind: "absent" };
    const original: SocketState = { kind: "present", dev: 1, ino: 100 };
    expect(describeSocketChange(absent, absent)).toBeUndefined();
    expect(describeSocketChange(original, { ...original })).toBeUndefined();
    expect(describeSocketChange(absent, original)).toBe("created");
    expect(describeSocketChange(original, absent)).toBe("removed");
    expect(describeSocketChange(original, { kind: "present", dev: 1, ino: 101 })).toBe("replaced");
    expect(describeSocketChange(original, { kind: "present", dev: 2, ino: 100 })).toBe("replaced");
  });

  it("names the display, the path, and the issue in the error", () => {
    const message = socketChangeError(":0", "/tmp/.X11-unix/X0", "replaced").message;
    expect(message).toContain("host display socket for DISPLAY=:0 changed");
    expect(message).toContain("/tmp/.X11-unix/X0");
    expect(message).toContain("#234");
  });
});
