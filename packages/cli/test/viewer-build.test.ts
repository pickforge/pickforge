import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { resolveViewerAssets } from "../src/viewer/assets.js";
import { ensureCliBuilt } from "./build-once.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const viewer = path.join(dist, "viewer");

beforeAll(ensureCliBuilt, 300_000);

it("ships the viewer page and the pinned noVNC runtime with its notices", () => {
  for (const name of ["index.html", "viewer.js", "viewer.css"]) {
    const built = fs.readFileSync(path.join(viewer, "page", name), "utf8");
    const source = fs.readFileSync(new URL(`../src/viewer/page/${name}`, import.meta.url), "utf8");
    expect(built).toBe(source);
  }
  expect(fs.existsSync(path.join(viewer, "novnc", "core", "rfb.js"))).toBe(true);
  expect(fs.existsSync(path.join(viewer, "novnc", "vendor", "pako"))).toBe(true);
  for (const notice of [
    "AUTHORS",
    "LICENSE.txt",
    "docs/LICENSE.MPL-2.0",
    "docs/LICENSE.BSD-2-Clause",
    "docs/LICENSE.BSD-3-Clause",
    "docs/LICENSE.OFL-1.1",
  ]) {
    expect(fs.statSync(path.join(viewer, "novnc", notice)).size).toBeGreaterThan(0);
  }
  // Only the runtime and its notices: no app, tests or docs beyond licenses.
  expect(fs.readdirSync(path.join(viewer, "novnc")).sort()).toEqual([
    "AUTHORS",
    "LICENSE.txt",
    "core",
    "docs",
    "vendor",
  ]);
  expect(fs.readdirSync(path.join(viewer, "novnc", "docs")).every((name) => name.startsWith("LICENSE."))).toBe(true);
});

it("resolves the bundled assets from the built entry", () => {
  const entry = pathToFileURL(path.join(dist, "pickforge-lab.js")).href;
  expect(resolveViewerAssets(entry)).toEqual({
    pageDir: path.join(viewer, "page"),
    novncDir: path.join(viewer, "novnc"),
  });
});
