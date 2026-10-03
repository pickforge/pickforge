import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ViewerAssetDirs {
  /** Holds `index.html`, `viewer.js` and `viewer.css`. */
  pageDir: string;
  /** Root of the pinned noVNC package: `core/`, `vendor/` and license texts. */
  novncDir: string;
}

/**
 * Locate the viewer page and the pinned noVNC files. The published CLI ships
 * both under `dist/viewer/`, copied at build time next to the bundled entry. A
 * source checkout (tests) reads the page from `src/viewer/page/` and noVNC
 * from the installed dev dependency.
 */
export function resolveViewerAssets(moduleUrl: string = import.meta.url): ViewerAssetDirs {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const bundled = path.join(here, "viewer");
  if (fs.existsSync(path.join(bundled, "page", "index.html"))) {
    return {
      pageDir: path.join(bundled, "page"),
      novncDir: path.join(bundled, "novnc"),
    };
  }
  const require = createRequire(moduleUrl);
  // The package exports `./core/rfb.js`; its root is two levels up.
  const rfbEntry = require.resolve("@novnc/novnc");
  return {
    pageDir: path.join(here, "page"),
    novncDir: path.dirname(path.dirname(rfbEntry)),
  };
}
