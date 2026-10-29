import { setTimeout as delay } from "node:timers/promises";
import {
  acquireAgentPermit,
  checkHumanLeaseBusy,
  getSession,
  isSessionInputClosed,
  releaseAgentPermit,
  type AgentPermit,
  type EnvLike,
} from "@pickforge/lab-core";
import { createDeferred } from "./deferred.js";
import {
  SESSION_CHECK_FAILED_ERROR_CODE,
  SESSION_ENDED_ERROR_CODE,
  TAKEOVER_BUSY_ERROR_CODE,
  jsonRpcRequestId,
  relayErrorResponse,
  type RelayErrorCode,
} from "./devtools-errors.js";
import type { JsonRpcIntercept, JsonRpcMessage } from "./ndjson.js";

/** How often the gate rechecks the session while a forwarded call is unanswered. */
export const DEVTOOLS_PERMIT_WATCH_MS = 100;

type RequestId = string | number;

interface ForwardedCall {
  permit: AgentPermit | undefined;
}

/**
 * Agent permits for DevTools relay calls (pickforge/pickforge#454). Each
 * forwarded `tools/call` holds a permit until the child answers it, so
 * session teardown waits for relay calls before it stops Chrome.
 *
 * DevTools calls can outlast the 5 s drains of takeover and the reaper, so
 * the gate watches the session while a call is unanswered. When teardown
 * closes input, `inputClosed` resolves and the relay stops its child. When a
 * human lease appears, the gate releases its permits at once so takeover can
 * drain. That call can still finish during human control, as before.
 *
 * A call the client cancels gets no response, but the child may still run it,
 * so it keeps its permit until the relay ends, input closes or a lease appears.
 */
export interface DevtoolsPermitGate {
  /** Run last, after every other intercept: a pass forwards the call. */
  intercept: JsonRpcIntercept;
  /** Release the permit of the call that a child response answers. */
  release(message: JsonRpcMessage): Promise<void>;
  /** Resolves when session input closes while a forwarded call is unanswered. */
  readonly inputClosed: Promise<void>;
  /** Session-ended errors for every unanswered call. Call after the child's output settled. */
  takeUnanswered(): JsonRpcMessage[];
  /** Release every held permit and stop watching. Idempotent; resolves once every release finished. */
  close(): Promise<void>;
}

async function sessionHasEnded(sessionId: string, env: EnvLike): Promise<boolean> {
  if (await isSessionInputClosed(sessionId, env)) return true;
  return (await getSession(sessionId, env))?.status !== "running";
}

class PermitGate implements DevtoolsPermitGate {
  private readonly calls = new Map<RequestId, ForwardedCall[]>();
  private readonly closedInput = createDeferred<void>();
  readonly inputClosed = this.closedInput.promise;
  private ended = false;
  private inputWasClosed = false;
  private closed = false;
  private watching = false;
  /** Every release of held permits started so far. */
  private releases: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sessionId: string,
    private readonly env: EnvLike,
    private readonly watchMs: number,
  ) {}

  readonly intercept: JsonRpcIntercept = async (message) => {
    if (message.method !== "tools/call") return undefined;
    const id = jsonRpcRequestId(message);
    if (id === undefined) return undefined;
    const refusal = await this.admit(id);
    return refusal === undefined ? undefined : relayErrorResponse(id, refusal);
  };

  async release(message: JsonRpcMessage): Promise<void> {
    if ("method" in message) return;
    const id = jsonRpcRequestId(message);
    const queue = id === undefined ? undefined : this.calls.get(id);
    if (id === undefined || queue === undefined) return;
    // A reused id answers its calls in order, one permit per response.
    const call = queue.shift();
    if (queue.length === 0) this.calls.delete(id);
    const permit = call?.permit;
    if (call !== undefined) call.permit = undefined;
    if (permit !== undefined) await releaseAgentPermit(permit).catch(() => {});
  }

  takeUnanswered(): JsonRpcMessage[] {
    const unanswered: JsonRpcMessage[] = [];
    for (const [id, queue] of this.calls) {
      unanswered.push(...queue.map(() => relayErrorResponse(id, SESSION_ENDED_ERROR_CODE)));
    }
    this.calls.clear();
    return unanswered;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.releaseHeld();
    // An earlier close or a lease may still be releasing; wait for them too.
    await this.releases;
  }

  private async admit(id: RequestId): Promise<RelayErrorCode | undefined> {
    if (this.ended || this.closed) return SESSION_ENDED_ERROR_CODE;
    let permit: AgentPermit;
    try {
      permit = await acquireAgentPermit(this.sessionId, this.env);
    } catch {
      return this.refusalAfterPermitFailure();
    }
    const refusal = (await this.leaseRefusal()) ?? (this.closed ? SESSION_ENDED_ERROR_CODE : undefined);
    if (refusal !== undefined) {
      await releaseAgentPermit(permit).catch(() => {});
      return refusal;
    }
    const queue = this.calls.get(id) ?? [];
    queue.push({ permit });
    this.calls.set(id, queue);
    this.startWatching();
    return undefined;
  }

  private async leaseRefusal(): Promise<RelayErrorCode | undefined> {
    try {
      const lease = await checkHumanLeaseBusy(this.sessionId, this.env);
      return lease === undefined ? undefined : TAKEOVER_BUSY_ERROR_CODE;
    } catch {
      return SESSION_CHECK_FAILED_ERROR_CODE;
    }
  }

  private async refusalAfterPermitFailure(): Promise<RelayErrorCode> {
    try {
      if (await sessionHasEnded(this.sessionId, this.env)) {
        this.ended = true;
        return SESSION_ENDED_ERROR_CODE;
      }
    } catch {
      // A read error refuses only this call; it does not prove the end.
    }
    return SESSION_CHECK_FAILED_ERROR_CODE;
  }

  private startWatching(): void {
    if (this.watching) return;
    this.watching = true;
    void this.watch();
  }

  private async watch(): Promise<void> {
    // Watch while any call is unanswered, even after takeover released its
    // permit, so teardown still stops the child of a call that outlived it.
    while (!this.closed && !this.inputWasClosed && this.calls.size > 0) {
      await delay(this.watchMs, undefined, { ref: false });
      await this.checkSession().catch(() => {});
    }
    this.watching = false;
  }

  private async checkSession(): Promise<void> {
    if (this.closed) return;
    if (await isSessionInputClosed(this.sessionId, this.env)) {
      this.ended = true;
      this.inputWasClosed = true;
      this.closedInput.resolve();
      return;
    }
    if (!this.holdsPermits()) return;
    if ((await checkHumanLeaseBusy(this.sessionId, this.env)) !== undefined) {
      await this.releaseHeld();
    }
  }

  private holdsPermits(): boolean {
    for (const queue of this.calls.values()) {
      if (queue.some((call) => call.permit !== undefined)) return true;
    }
    return false;
  }

  private async releaseHeld(): Promise<void> {
    const held: AgentPermit[] = [];
    for (const queue of this.calls.values()) {
      for (const call of queue) {
        if (call.permit !== undefined) held.push(call.permit);
        call.permit = undefined;
      }
    }
    const done = Promise.all(held.map((permit) => releaseAgentPermit(permit).catch(() => {})));
    this.releases = Promise.all([this.releases, done]);
    await done;
  }
}

export function createDevtoolsPermitGate(
  sessionId: string,
  env: EnvLike = process.env,
  watchMs = DEVTOOLS_PERMIT_WATCH_MS,
): DevtoolsPermitGate {
  return new PermitGate(sessionId, env, watchMs);
}
