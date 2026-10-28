import { randomUUID } from "node:crypto";
import { runCommand } from "@pickforge/lab-core";
import { findOnPath, type NativeViewerCommand, type ViewerControlEvent, type ControlRevokeReason } from "@pickforge/lab-desktop-linux";

interface AttentionRequest {
  state?: ViewerControlEvent;
  timer: NodeJS.Timeout;
  taken: boolean;
  expanded: boolean;
  message: string;
}

/** Attention and subscriptions have no access to lease acquisition or input. */
export class NativeRequests {
  private readonly requests = new Map<string, AttentionRequest>();
  private readonly subscribers = new Set<(event: ViewerControlEvent) => void>();
  private closed = false;
  private closing = false;
  constructor(private readonly options: {
    env: NodeJS.ProcessEnv;
    send(command: NativeViewerCommand): void;
    mode(mode: "expanded" | "thumbnail"): Promise<void>;
    controlling(): boolean;
    currentMode(): "thumbnail" | "expanded" | "fullscreen";
  }) {}

  state(id: string): ViewerControlEvent | undefined { return this.requests.get(id)?.state; }
  has(id: string): boolean { return this.requests.has(id); }

  subscribe(callback: (event: ViewerControlEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private emit(event: ViewerControlEvent): void {
    if (event.requestId !== undefined) this.requests.get(event.requestId)!.state = event;
    for (const callback of this.subscribers) callback(event);
  }

  private prune(): void {
    for (const [id, request] of this.requests) {
      if (this.requests.size < 64) break;
      if (request.state !== undefined && "outcome" in request.state) this.requests.delete(id);
    }
    if (this.requests.size >= 64) throw new Error("Too many viewer requests");
  }

  async request(message: string, timeoutMs: number): Promise<string> {
    if (this.closing || this.closed) throw new Error("Viewer closed");
    this.prune();
    const requestId = randomUUID();
    const timer = setTimeout(() => { void this.cancel(requestId, "timeout").catch(() => {}); }, timeoutMs);
    this.requests.set(requestId, { timer, message, taken: this.options.controlling(), expanded: this.options.currentMode() === "thumbnail" });
    try {
      if (this.options.currentMode() === "thumbnail") await this.options.mode("expanded");
      // Cancellation/session end can arrive during compositor placement.
      const request = this.requests.get(requestId)!;
      if (request.state !== undefined && "outcome" in request.state) return requestId;
      if (request.taken) { this.emit({ event: "controlTaken", requestId }); return requestId; }
      this.options.send({ cmd: "attention", message });
      const binary = findOnPath("notify-send", this.options.env);
      if (binary !== null) {
        // Never persist argv, command output, or notification errors.
        void runCommand(binary, ["--app-name=Pickforge", "--urgency=normal", "Pickforge needs your help", Array.from(message).slice(0, 120).join("").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")],
          { env: this.options.env, cleanEnv: true, timeoutMs: 2_000 }).catch(() => {});
      }
      return requestId;
    } catch (error) { clearTimeout(timer); this.requests.delete(requestId); throw error; }
  }

  async cancel(requestId: string, outcome: "cancelled" | "timeout" = "cancelled"): Promise<void> {
    const request = this.requests.get(requestId);
    if (request === undefined || request.state !== undefined && "outcome" in request.state) return;
    clearTimeout(request.timer);
    this.emit({ event: "requestEnded", requestId, outcome });
    const pending = [...this.requests.values()].filter((entry) => entry.state === undefined);
    if (pending.length > 0) this.options.send({ cmd: "attention", message: pending.at(-1)!.message });
    else this.options.send({ cmd: "clearAttention" });
    if (!request.expanded || request.taken) return;
    if (!this.options.controlling() && pending.length === 0 && !this.closed) await this.options.mode("thumbnail");
  }

  taken(): void {
    this.options.send({ cmd: "clearAttention" });
    this.emit({ event: "controlTaken" });
    for (const [requestId, request] of this.requests) {
      if (request.state !== undefined && "outcome" in request.state) continue;
      request.taken = true;
      request.message = "";
      this.emit({ event: "controlTaken", requestId });
    }
  }

  returned(reason: ControlRevokeReason): void {
    this.emit({ event: "controlReturned", reason, outcome: "returned" });
    for (const [requestId, request] of this.requests) {
      if (!request.taken || request.state !== undefined && "outcome" in request.state) continue;
      clearTimeout(request.timer);
      this.emit({ event: "controlReturned", reason, outcome: "returned", requestId });
    }
    if (![...this.requests.values()].some((request) => request.state === undefined)) this.options.send({ cmd: "clearAttention" });
  }

  beginClose(): void { this.closing = true; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.emit({ event: "viewerClosed", outcome: "viewer_closed" });
    for (const [requestId, request] of this.requests) {
      clearTimeout(request.timer);
      request.message = "";
      if (request.state === undefined || !("outcome" in request.state)) {
        this.emit({ event: "viewerClosed", requestId, outcome: "viewer_closed" });
      }
    }
  }
}
