/** Watch-only subset of crates/pickforge-viewer/PROTOCOL.md. */
export const VIEWER_MESSAGE_MAX_BYTES = 64 * 1024;
export type NativeViewerMode = "thumbnail" | "expanded";
export type NativeViewerCommand =
  | { cmd: "setMode"; mode: NativeViewerMode; width?: number; height?: number }
  | { cmd: "status"; code: "connecting" | "sessionEnded" | "stopping" }
  | { cmd: "sessionEnded" }
  | { cmd: "shutdown" };
export type NativeViewerEvent =
  | { event: "ready"; version: string; pid: number; backend: "wayland" | "x11"; scale: number }
  | { event: "mode"; mode: NativeViewerMode | "fullscreen" }
  | { event: "expandRequested" | "collapseRequested" | "closed" }
  | { event: "sessionEnded"; reason: "x11-eof" | "xvfb-gone" }
  | { event: "error"; code: string; message: string };

/** Extend this map with request/cancel/subscription operations in #341.
 * No operation may grant control or carry keyboard or pointer input.
 */
export interface ViewerHostOperations {
  status: Record<never, never>;
  expand: Record<never, never>;
  collapse: Record<never, never>;
  shutdown: Record<never, never>;
}
export type ViewerHostRequest = {
  [K in keyof ViewerHostOperations]: { op: K } & ViewerHostOperations[K]
}[keyof ViewerHostOperations];
export interface NativeViewerHostIdentity {
  version: string;
  sessionId: string;
  launchId: string;
  pid: number;
  startTicks: number;
  viewerPid: number;
  viewerStartTicks: number;
  socket: string;
  socketIno: number;
  socketDev: number;
}
export type ViewerHostResponse =
  | { ok: true; host: NativeViewerHostIdentity; mode: NativeViewerMode | "fullscreen"; sessionEnded: boolean }
  | { ok: false; error: "unknown-operation" | "invalid-request" | "operation-failed" };
