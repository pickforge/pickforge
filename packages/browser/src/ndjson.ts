import type { Readable, Writable } from "node:stream";
import { createDeferred } from "./deferred.js";

/** Maximum bytes retained for one JSON-RPC record, including its delimiter. */
export const DEFAULT_MAX_JSON_RPC_RECORD_BYTES = 16 * 1024 * 1024;

export class JsonRpcProtocolError extends Error {
  override name = "JsonRpcProtocolError";
}

export type JsonRpcId = string | number | null;

export type JsonRpcMessage = Record<string, unknown> & {
  jsonrpc: "2.0";
};

export interface JsonRpcRecord {
  message: JsonRpcMessage;
  /** The complete record, including its LF or CRLF delimiter. */
  raw: Buffer;
}

export type JsonRpcHook = (
  message: JsonRpcMessage,
) => JsonRpcMessage | void | Promise<JsonRpcMessage | void>;

/**
 * Per-record interception, checked before `hook`/forwarding. Returning a
 * message short-circuits: that message is written to `interceptDestination`
 * instead, and the original record is never forwarded to `destination`.
 * Returning `undefined` falls through to the normal `hook`+forward path.
 * Used by the DevTools relay's fail-closed human-takeover gate (
 * pickforge/pickforge#21) to answer a blocked `tools/call` with a synthetic
 * busy error on the *response* stream, without ever reaching the upstream
 * child process.
 */
export type JsonRpcIntercept = (
  message: JsonRpcMessage,
) => JsonRpcMessage | undefined | Promise<JsonRpcMessage | undefined>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export function assertJsonRpcMessage(value: unknown): asserts value is JsonRpcMessage {
  if (!isObject(value) || value.jsonrpc !== "2.0") {
    throw new Error('expected a JSON-RPC 2.0 object with jsonrpc: "2.0"');
  }
  if ("method" in value) {
    if (typeof value.method !== "string" || value.method.length === 0) {
      throw new Error("JSON-RPC request method must be a non-empty string");
    }
    if ("result" in value || "error" in value) {
      throw new Error("JSON-RPC request cannot contain result or error");
    }
    if (
      "id" in value &&
      value.id !== undefined &&
      (!isJsonRpcId(value.id) || value.id === null)
    ) {
      throw new Error("JSON-RPC request id must be a string or number");
    }
    if (
      "params" in value &&
      value.params !== undefined &&
      !isObject(value.params) &&
      !Array.isArray(value.params)
    ) {
      throw new Error("JSON-RPC params must be an object or array");
    }
    return;
  }
  if (!("id" in value) || !isJsonRpcId(value.id)) {
    throw new Error("JSON-RPC response id must be a string, number, or null");
  }
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) {
    throw new Error("JSON-RPC response must contain exactly one of result or error");
  }
  if (
    hasError &&
    (!isObject(value.error) ||
      typeof value.error.code !== "number" ||
      !Number.isFinite(value.error.code) ||
      typeof value.error.message !== "string")
  ) {
    throw new Error("JSON-RPC error must contain numeric code and string message");
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("JSON-RPC record is not valid UTF-8");
  }
}

function parseJsonRpcRecord(raw: Buffer): JsonRpcRecord {
  const lf = raw.length - 1;
  const contentEnd = lf > 0 && raw[lf - 1] === 0x0d ? lf - 1 : lf;
  const content = raw.subarray(0, contentEnd);
  if (content.length === 0) {
    throw new Error("empty JSON-RPC record");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(content));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("JSON-RPC record")) {
      throw error;
    }
    throw new Error(
      `malformed JSON-RPC record: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertJsonRpcMessage(parsed);
  return { message: parsed, raw };
}

export class JsonRpcNdjsonBuffer {
  private buffered = Buffer.alloc(0);

  constructor(
    private readonly maxRecordBytes = DEFAULT_MAX_JSON_RPC_RECORD_BYTES,
  ) {
    if (!Number.isInteger(maxRecordBytes) || maxRecordBytes < 1) {
      throw new Error("maxRecordBytes must be a positive integer");
    }
  }

  push(chunk: Buffer | Uint8Array | string): JsonRpcRecord[] {
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const records: JsonRpcRecord[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const lf = bytes.indexOf(0x0a, offset);
      const segmentEnd = lf === -1 ? bytes.length : lf + 1;
      const segment = bytes.subarray(offset, segmentEnd);
      if (this.buffered.length + segment.length > this.maxRecordBytes) {
        this.buffered = Buffer.alloc(0);
        throw new JsonRpcProtocolError(
          `JSON-RPC record exceeds ${this.maxRecordBytes} byte limit`,
        );
      }
      if (lf === -1) {
        this.buffered =
          this.buffered.length === 0
            ? Buffer.from(segment)
            : Buffer.concat([this.buffered, segment]);
        break;
      }
      const raw =
        this.buffered.length === 0
          ? Buffer.from(segment)
          : Buffer.concat([this.buffered, segment]);
      this.buffered = Buffer.alloc(0);
      try {
        records.push(parseJsonRpcRecord(raw));
      } catch (error) {
        if (error instanceof JsonRpcProtocolError) {
          throw error;
        }
        throw new JsonRpcProtocolError(
          error instanceof Error ? error.message : String(error),
        );
      }
      offset = segmentEnd;
    }
    return records;
  }

  end(): void {
    if (this.buffered.length !== 0) {
      throw new JsonRpcProtocolError(
        "incomplete JSON-RPC record at end of stream",
      );
    }
  }
}

export function serializeJsonRpcMessage(message: JsonRpcMessage): Buffer {
  assertJsonRpcMessage(message);
  return Buffer.from(`${JSON.stringify(message)}\n`);
}

/**
 * Runs `write` in turn, never overlapping with another write issued through
 * the same serializer. Used to fully order writes to a stream that more than
 * one independent pump can target — e.g. the DevTools relay's fail-closed
 * intercept answering directly on the client-facing output stream while the
 * child-response pump also writes to it (pickforge/pickforge#21 P1-D) — so two
 * concurrent producers can never have overlapping in-flight writes to the
 * same destination, made explicit in the code rather than left as an
 * incidental property of whichever `Writable` happens to be passed in.
 */
export type JsonRpcWriteSerializer = (write: () => Promise<void>) => Promise<void>;

/** Create a fresh, independent write-ordering queue for `JsonRpcWriteSerializer`. */
export function createJsonRpcWriteQueue(): JsonRpcWriteSerializer {
  let queue: Promise<void> = Promise.resolve();
  return (write) => {
    const result = queue.then(write);
    // A failed write must not permanently wedge the queue for later writers;
    // only THIS call's returned promise carries the rejection.
    queue = result.catch(() => {});
    return result;
  };
}

export async function writeWithBackpressure(
  destination: Writable,
  bytes: Buffer,
): Promise<void> {
  if (destination.destroyed || destination.writableEnded) {
    throw new Error("destination is not writable");
  }
  const completion = createDeferred<void>();
  let writeReturned = false;
  let writeFinished = false;
  let drained = false;
  const finishWhenReady = (): void => {
    if (writeReturned && writeFinished && drained) {
      completion.resolve();
    }
  };
  const onDrain = (): void => {
    drained = true;
    finishWhenReady();
  };
  const onError = (error: Error): void => completion.reject(error);
  const onClose = (): void =>
    completion.reject(new Error("destination closed before write completed"));
  destination.once("error", onError);
  destination.once("close", onClose);
  try {
    const accepted = destination.write(bytes, (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        completion.reject(error);
        return;
      }
      writeFinished = true;
      finishWhenReady();
    });
    drained = accepted;
    writeReturned = true;
    if (!accepted) {
      destination.once("drain", onDrain);
    }
    finishWhenReady();
    await completion.promise;
  } finally {
    destination.off("drain", onDrain);
    destination.off("error", onError);
    destination.off("close", onClose);
  }
}

async function applyHook(
  record: JsonRpcRecord,
  hook: JsonRpcHook | undefined,
): Promise<Buffer> {
  if (hook === undefined) {
    return record.raw;
  }
  const before = JSON.stringify(record.message);
  const returned = await hook(record.message);
  const message = returned ?? record.message;
  assertJsonRpcMessage(message);
  return JSON.stringify(message) === before
    ? record.raw
    : serializeJsonRpcMessage(message);
}

function abortError(): Error {
  const error = new Error("JSON-RPC relay aborted");
  error.name = "AbortError";
  return error;
}

async function nextWithAbort<T>(
  next: Promise<IteratorResult<T>>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
  if (signal === undefined) {
    return next;
  }
  if (signal.aborted) {
    throw abortError();
  }
  const aborted = createDeferred<never>();
  const onAbort = (): void => aborted.reject(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([next, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface PumpJsonRpcNdjsonOptions {
  hook?: JsonRpcHook;
  /** Checked before `hook`; see `JsonRpcIntercept`. Requires `interceptDestination`. */
  intercept?: JsonRpcIntercept;
  /** Where an `intercept` response is written instead of `destination`. */
  interceptDestination?: Writable;
  /**
   * Serializes writes to `destination` against any other pump sharing the
   * same stream via its own serializer from the same `createJsonRpcWriteQueue()`
   * instance. Defaults to running the write immediately (no cross-pump
   * ordering) — pass a shared queue when `destination` is also written by
   * another pump/writer.
   */
  writeSerializer?: JsonRpcWriteSerializer;
  /** Same as `writeSerializer`, but for writes to `interceptDestination`. */
  interceptWriteSerializer?: JsonRpcWriteSerializer;
  signal?: AbortSignal;
  endDestination?: boolean;
  maxRecordBytes?: number;
}

const runWriteImmediately: JsonRpcWriteSerializer = (write) => write();

// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export async function pumpJsonRpcNdjson(
  source: Readable,
  destination: Writable,
  opts: PumpJsonRpcNdjsonOptions = {},
): Promise<void> {
  if (opts.intercept !== undefined && opts.interceptDestination === undefined) {
    throw new Error("pumpJsonRpcNdjson: intercept requires interceptDestination");
  }
  const writeSerializer = opts.writeSerializer ?? runWriteImmediately;
  const interceptWriteSerializer = opts.interceptWriteSerializer ?? runWriteImmediately;
  const decoder = new JsonRpcNdjsonBuffer(opts.maxRecordBytes);
  const iterator = source.iterator({ destroyOnReturn: false })[Symbol.asyncIterator]();
  try {
    while (true) {
      const item = await nextWithAbort(iterator.next(), opts.signal);
      if (item.done) {
        break;
      }
      const chunk =
        typeof item.value === "string" ? Buffer.from(item.value) : Buffer.from(item.value);
      for (const record of decoder.push(chunk)) {
        const intercepted =
          opts.intercept === undefined ? undefined : await opts.intercept(record.message);
        if (intercepted !== undefined) {
          const interceptBytes = serializeJsonRpcMessage(intercepted);
          await interceptWriteSerializer(() =>
            writeWithBackpressure(opts.interceptDestination!, interceptBytes),
          );
          continue;
        }
        const forwardBytes = await applyHook(record, opts.hook);
        await writeSerializer(() => writeWithBackpressure(destination, forwardBytes));
      }
    }
    decoder.end();
    if (opts.endDestination === true && !destination.destroyed) {
      destination.end();
    }
  } finally {
    const returned = iterator.return?.();
    if (opts.signal?.aborted === true) {
      void returned?.catch(() => {});
    } else {
      await returned;
    }
  }
}
