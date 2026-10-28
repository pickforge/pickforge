import { setTimeout as sleep } from "node:timers/promises";
import {
  startHumanTakeover, endHumanTakeover,
  type HumanTakeoverHandle, type NativeViewerCommand, type ControlRevokeReason,
  type StartHumanTakeoverOptions,
} from "@pickforge/lab-desktop-linux";
import { holdHumanLease, type SpawnWatchdogFn } from "../commands/takeover-hold.js";

/** Only viewer stdio and the explicit CLI startup path call take(). */
export class NativeControl {
  private handle?: HumanTakeoverHandle;
  private held?: ReturnType<typeof holdHumanLease>;
  private starting?: Promise<void>;
  private ending?: Promise<void>;
  private stopping = false;
  private viewerGone = false;
  private ready = false;
  private ack?: { leaseId: string; resolve(): void };

  constructor(private readonly options: {
    sessionId: string;
    env: NodeJS.ProcessEnv;
    send(command: NativeViewerCommand): void;
    kill(): void;
    taken(): void;
    returned(reason: ControlRevokeReason): void;
    takeoverOptions?: StartHumanTakeoverOptions;
    spawnWatchdog?: SpawnWatchdogFn;
  }) {}

  get active(): boolean { return this.handle !== undefined; }

  take(): Promise<void> {
    if (this.stopping || this.active || this.ending !== undefined) return Promise.resolve();
    return this.starting ??= this.acquire().finally(() => { this.starting = undefined; });
  }

  private grant(handle: HumanTakeoverHandle): void {
    if (!this.ready || this.stopping || this.ending !== undefined) return;
    this.options.send({ cmd: "control", state: "granted", leaseId: handle.leaseId, grantMs: handle.heartbeatMs * 2 });
  }

  private async acquire(): Promise<void> {
    try {
      const handle = await startHumanTakeover(this.options.sessionId, {
        ...this.options.takeoverOptions, transport: "viewer", registryEnv: this.options.env, env: this.options.env,
      });
      this.handle = handle;
      this.held = holdHumanLease(handle, {
        registryEnv: this.options.env, spawnWatchdog: this.options.spawnWatchdog,
        onRenew: () => this.grant(handle),
        onLost: () => { void this.end("lease-lost").catch(() => this.options.kill()); },
      });
      if (this.ready) this.beginInput(handle);
    } catch {
      this.options.send({ cmd: "control", state: "revoked", leaseId: "", reason: "unavailable" });
    }
  }

  viewerReady(): void {
    this.ready = true;
    if (this.handle !== undefined) this.beginInput(this.handle);
  }

  private beginInput(handle: HumanTakeoverHandle): void {
    if (this.stopping || this.ending !== undefined) return;
    this.grant(handle);
    this.options.taken();
  }

  viewerExited(): void {
    this.viewerGone = true;
    this.ack?.resolve();
  }

  acknowledge(leaseId: unknown, state: unknown): void {
    if (state === "revoked" && leaseId === this.ack?.leaseId) this.ack?.resolve();
  }

  private async revoke(handle: HumanTakeoverHandle, reason: ControlRevokeReason): Promise<void> {
    if (this.viewerGone) return;
    let acknowledge!: () => void;
    const ack = new Promise<boolean>((resolve) => { acknowledge = () => resolve(true); });
    this.ack = { leaseId: handle.leaseId, resolve: acknowledge };
    this.options.send({ cmd: "control", state: "revoked", leaseId: handle.leaseId, reason });
    const applied = await Promise.race([ack, sleep(1_000).then(() => false)]);
    this.ack = undefined;
    if (!applied) this.options.kill();
  }

  end(reason: ControlRevokeReason, final = false): Promise<void> {
    if (final) this.stopping = true;
    return this.ending ??= this.release(reason).finally(() => { this.ending = undefined; });
  }

  private async release(reason: ControlRevokeReason): Promise<void> {
    await this.starting;
    const handle = this.handle;
    if (handle === undefined) return;
    // Stop grant renewal before revoking input. Keep the watchdog until cleanup finishes.
    this.held?.stopRenewing();
    await this.revoke(handle, reason);
    await endHumanTakeover(handle, {
      registryEnv: this.options.env, env: this.options.env,
      reason: reason === "returned" ? "return" : reason === "lease-lost" ? "timeout" : "cancelled",
    });
    this.handle = undefined;
    this.held?.stop();
    this.options.returned(reason);
  }
}
