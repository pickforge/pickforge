import { describe, expect, it } from "vitest";
import {
  createIsolatedDesktopEnvironment,
  desktopEnvironmentRecipe,
} from "../src/environment.js";

describe("createIsolatedDesktopEnvironment", () => {
  it("removes every Wayland variable and sets the X11 contract", () => {
    const source = {
      PATH: "/custom/bin",
      KEEP_ME: "unchanged",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
      WAYLAND_SOCKET: "42",
      WAYLAND_DEBUG: "client",
      GDK_BACKEND: "wayland",
      QT_QPA_PLATFORM: "wayland",
      SDL_VIDEODRIVER: "wayland",
      WINIT_UNIX_BACKEND: "wayland",
      XDG_SESSION_TYPE: "wayland",
    };

    const result = createIsolatedDesktopEnvironment(":90", source);

    expect(result).toMatchObject({
      PATH: "/custom/bin",
      KEEP_ME: "unchanged",
      DISPLAY: ":90",
      GDK_BACKEND: "x11",
      QT_QPA_PLATFORM: "xcb",
      SDL_VIDEODRIVER: "x11",
      WINIT_UNIX_BACKEND: "x11",
      XDG_SESSION_TYPE: "x11",
    });
    expect(Object.keys(result).filter((name) => name.startsWith("WAYLAND_"))).toEqual([]);
    expect(source).toMatchObject({
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
      WAYLAND_SOCKET: "42",
      WAYLAND_DEBUG: "client",
      GDK_BACKEND: "wayland",
    });
  });

  it("does not mutate process.env when it is the default source", () => {
    const before = { ...process.env };
    const result = createIsolatedDesktopEnvironment(":91");

    expect(process.env).toEqual(before);
    expect(result).not.toBe(process.env);
    expect(result.DISPLAY).toBe(":91");
  });
});

describe("desktopEnvironmentRecipe", () => {
  it("prints only the safe environment delta", () => {
    const recipe = desktopEnvironmentRecipe(":92", {
      SECRET_TOKEN: "do-not-print",
      WAYLAND_DISPLAY: "wayland-0",
      WAYLAND_DEBUG: "1",
    });

    expect(recipe.unset).toEqual([
      "WAYLAND_DEBUG",
      "WAYLAND_DISPLAY",
      "WAYLAND_SOCKET",
    ]);
    expect(recipe.exports).toEqual({
      DISPLAY: ":92",
      GDK_BACKEND: "x11",
      QT_QPA_PLATFORM: "xcb",
      SDL_VIDEODRIVER: "x11",
      WINIT_UNIX_BACKEND: "x11",
      XDG_SESSION_TYPE: "x11",
    });
    expect(recipe.lines.join("\n")).not.toContain("do-not-print");
  });
});
