/**
 * Shared contract between the viewer bridge (loopback HTTP and WebSocket
 * server), the passive viewer page and the launcher (pickforge/pickforge#207).
 * The page mirrors these values in `page/viewer.js`; keep both in sync.
 */

/** The bridge binds and is reached only on this address, never `localhost`. */
export const VIEWER_HOST = "127.0.0.1";

export type ViewerWindowMode = "thumbnail" | "expanded";

/** Bundled page assets (`page/`): `index.html` is served for `viewerPagePath`. */
export const VIEWER_ASSET_PREFIX = "/viewer-assets/";

/** Pinned noVNC files, served from `core/` and `vendor/` only. */
export const NOVNC_ASSET_PREFIX = "/novnc/";

/** WebSocket upgrade path. The page passes the token as `?token=`. */
export const VIEWER_WEBSOCKET_PATH = "/websockify";

/**
 * The page for one launch. The launch id is part of the path because Chromium
 * derives the Wayland app id from the URL host and path (not the port, the
 * fragment or `--class`), so a unique path is what makes the window identity
 * unique per launch.
 */
export function viewerPagePath(launchId: string): string {
  return `/viewer/${launchId}`;
}

/**
 * `POST` with `Authorization: Bearer <token>` and a JSON body
 * `{"mode":"thumbnail"|"expanded"}`. Responds `200` with
 * `{"applied": boolean, "size": {"width": number, "height": number}}`:
 * `applied` is true when a compositor adapter resized the window, otherwise
 * the page falls back to `window.resizeTo(size.width, size.height)`.
 */
export function viewerWindowApiPath(launchId: string): string {
  return `/api/launches/${launchId}/window`;
}

/** WebSocket close codes the bridge sends after a successful upgrade. */
export const VIEWER_CLOSE_CODES = {
  /** No usable read-only VNC server right now. The page retries with backoff. */
  vncUnavailable: 4001,
  /** VNC is writable (human control or `--vnc-control`). Passive view pauses and retries slowly. */
  vncWritable: 4002,
  /** The session is gone or not running. The page stops retrying. */
  sessionEnded: 4003,
  /** The bridge is stopping (idle or teardown). The page stops retrying. */
  shuttingDown: 4004,
} as const;

/** The launch URL. The token travels in the fragment, so it is never sent in a page request. */
export function buildViewerUrl(port: number, launchId: string, token: string): string {
  return `http://${VIEWER_HOST}:${port}${viewerPagePath(launchId)}#token=${token}`;
}
