/** Native viewer stdio and private host socket protocol. */
export const VIEWER_MESSAGE_MAX_BYTES = 64 * 1024;
export type NativeViewerMode = "thumbnail" | "expanded";
export type NativeViewerCommand =
  | { cmd: "setMode"; mode: NativeViewerMode; width?: number; height?: number }
  | { cmd: "status"; code: "connecting" | "sessionEnded" | "stopping" }
  | { cmd: "sessionEnded" }
  | { cmd: "shutdown" }
  | { cmd: "attention"; message: string }
  | { cmd: "clearAttention" }
  | { cmd: "control"; state: "granted"; leaseId: string; grantMs: number }
  | { cmd: "control"; state: "revoked"; leaseId: string; reason: ControlRevokeReason };
export type ControlRevokeReason = "returned" | "lease-lost" | "session-ended" | "stopping" | "unavailable";
export type NativeViewerEvent =
  | { event: "ready"; version: string; pid: number; backend: "wayland" | "x11"; scale: number }
  | { event: "mode"; mode: NativeViewerMode | "fullscreen" }
  | { event: "expandRequested" | "collapseRequested" | "closed" }
  | { event: "sessionEnded"; reason: "x11-eof" | "xvfb-gone" }
  | { event: "takeRequested" }
  | { event: "returnRequested"; reason: "button" | "closed" }
  | { event: "controlAck"; leaseId: string; state: "granted" | "revoked" }
  | { event: "error"; code: string; message: string };

/** Attention requests never authorize control.
 * No operation may grant control or carry keyboard or pointer input.
 */
export interface ViewerHostOperations {
  status: Record<never, never>;
  expand: Record<never, never>;
  collapse: Record<never, never>;
  shutdown: Record<never, never>;
  requestTakeover: { message: string; timeoutMs: number };
  cancelRequest: { requestId: string };
  subscribe: { requestId?: string };
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
  | { ok: true; host: NativeViewerHostIdentity; mode: NativeViewerMode | "fullscreen"; sessionEnded: boolean; requestId?: string; requestState?: ViewerControlEvent }
  | { ok: false; error: "unknown-operation" | "invalid-request" | "operation-failed" };

export type ViewerRequestOutcome = "returned" | "timeout" | "cancelled" | "viewer_closed";
export type ViewerControlEvent =
  | { event: "controlTaken"; requestId?: string }
  | { event: "controlReturned"; reason: ControlRevokeReason; requestId?: string; outcome: "returned" }
  | { event: "viewerClosed"; requestId?: string; outcome: "viewer_closed" }
  | { event: "requestEnded"; requestId: string; outcome: "timeout" | "cancelled" };

export function validTakeoverMessage(message: unknown): message is string {
  return typeof message === "string" && Array.from(message).length <= 500 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(message);
}
export function validTakeoverTimeout(timeoutMs: unknown): timeoutMs is number {
  return Number.isSafeInteger(timeoutMs) && (timeoutMs as number) >= 0 && (timeoutMs as number) <= 3_600_000;
}
