import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const packageDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Ship the passive viewer next to the bundled entry (pickforge/pickforge#207):
 * the page as `dist/viewer/page` and the pinned noVNC runtime with its
 * notices as `dist/viewer/novnc`. `resolveViewerAssets()` looks there first.
 * This runs after the build because `clean: true` empties `dist`.
 */
function copyViewerAssets(): void {
  const viewerDir = path.join(packageDir, "dist", "viewer");
  fs.rmSync(viewerDir, { recursive: true, force: true });
  for (const name of ["index.html", "viewer.js", "viewer.css"]) {
    const from = path.join(packageDir, "src", "viewer", "page", name);
    fs.cpSync(from, path.join(viewerDir, "page", name));
  }
  const require = createRequire(path.join(packageDir, "package.json"));
  // The package exports `./core/rfb.js`; its root is two levels up.
  const novncRoot = path.dirname(path.dirname(require.resolve("@novnc/novnc")));
  const novncOut = path.join(viewerDir, "novnc");
  for (const name of ["core", "vendor", "AUTHORS", "LICENSE.txt"]) {
    fs.cpSync(path.join(novncRoot, name), path.join(novncOut, name), { recursive: true });
  }
  const docsDir = path.join(novncRoot, "docs");
  for (const name of fs.readdirSync(docsDir).filter((file) => file.startsWith("LICENSE."))) {
    fs.cpSync(path.join(docsDir, name), path.join(novncOut, "docs", name));
  }
}

export default defineConfig({
  entry: ["src/pickforge-lab.ts", "src/pickforge-mcp.ts"],
  format: ["esm"],
  platform: "node",
  clean: true,
  sourcemap: true,
  noExternal: [/^@pickforge\//],
  onSuccess: async () => copyViewerAssets(),
});
