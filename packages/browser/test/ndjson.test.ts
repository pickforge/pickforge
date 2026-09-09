import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  assertJsonRpcMessage,
  createDeferred,
  createJsonRpcWriteQueue,
  JsonRpcNdjsonBuffer,
  pumpJsonRpcNdjson,
  type JsonRpcMessage,
} from "../src/index.js";

function collectingWritable(
  chunks: Buffer[],
  write?: (chunk: Buffer) => Promise<void>,
): Writable {
  return new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      chunks.push(bytes);
      if (write === undefined) {
        callback();
        return;
      }
      void write(bytes).then(() => callback(), callback);
    },
  });
}

describe("createDeferred", () => {
  it("works when the runtime has no Promise.withResolvers", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Promise,
      "withResolvers",
    );
    let deferredPromise: Promise<string> | undefined;
    Reflect.deleteProperty(Promise, "withResolvers");
    try {
      const deferred = createDeferred<string>();
      deferred.resolve("ready");
      deferredPromise = deferred.promise;
    } finally {
      if (descriptor !== undefined) {
        Object.defineProperty(Promise, "withResolvers", descriptor);
      }
    }
    if (deferredPromise === undefined) {
      throw new Error("deferred was not created");
    }
    await expect(deferredPromise).resolves.toBe("ready");
  });
});

describe("JsonRpcNdjsonBuffer", () => {
  it("buffers fragmented, coalesced, CRLF, and split multibyte records", () => {
    const decoder = new JsonRpcNdjsonBuffer();
    const first = '{ "jsonrpc": "2.0", "id": "café", "method": "tools/list" }\r\n';
    const second = '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}\n';
    const bytes = Buffer.from(first + second);
    const split = Buffer.from("é").subarray(0, 1);
    const splitAt = bytes.indexOf(Buffer.from("é"));
    const records = [
      ...decoder.push(bytes.subarray(0, splitAt)),
      ...decoder.push(Buffer.concat([split, bytes.subarray(splitAt + 1, splitAt + 1)])),
      ...decoder.push(bytes.subarray(splitAt + 1)),
    ];

    expect(records).toHaveLength(2);
    expect(records[0]?.message.id).toBe("café");
    expect(records[0]?.raw.equals(Buffer.from(first))).toBe(true);
    expect(records[1]?.message.method).toBe("notifications/cancelled");
    expect(records[1]?.raw.equals(Buffer.from(second))).toBe(true);
    expect(() => decoder.end()).not.toThrow();
  });

  it("fails closed on malformed, invalid, empty, and incomplete records", () => {
    expect(() => new JsonRpcNdjsonBuffer().push("not-json\n")).toThrow(
      "malformed JSON-RPC record",
    );
    expect(() => new JsonRpcNdjsonBuffer().push('{"jsonrpc":"1.0"}\n')).toThrow(
      "expected a JSON-RPC 2.0 object",
    );
    expect(() => new JsonRpcNdjsonBuffer().push("\n")).toThrow(
      "empty JSON-RPC record",
    );
    const incomplete = new JsonRpcNdjsonBuffer();
    incomplete.push('{"jsonrpc":"2.0","method":"tools/list"}');
    expect(() => incomplete.end()).toThrow("incomplete JSON-RPC record");
  });

  it("rejects a fragmented record before pending memory exceeds its cap", () => {
    const decoder = new JsonRpcNdjsonBuffer(12);
    decoder.push("abcd");
    decoder.push("efgh");
    decoder.push("ijkl");
    expect(() => decoder.push("m")).toThrow(
      "JSON-RPC record exceeds 12 byte limit",
    );
  });
});

describe("assertJsonRpcMessage", () => {
  it("accepts requests, notifications, and exclusive result or error responses", () => {
    expect(() =>
      assertJsonRpcMessage({ jsonrpc: "2.0", method: "tools/list" }),
    ).not.toThrow();
    expect(() =>
      assertJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "click" },
      }),
    ).not.toThrow();
    expect(() =>
      assertJsonRpcMessage({ jsonrpc: "2.0", id: null, result: { ok: true } }),
    ).not.toThrow();
    expect(() =>
      assertJsonRpcMessage({
        jsonrpc: "2.0",
        id: "a",
        error: { code: -32000, message: "busy" },
      }),
    ).not.toThrow();
  });

  it("rejects mixed request/response shapes and invalid params or error objects", () => {
    expect(() =>
      assertJsonRpcMessage({
        jsonrpc: "2.0",
        method: "tools/call",
        result: { ok: true },
      }),
    ).toThrow("cannot contain result or error");
    expect(() =>
      assertJsonRpcMessage({ jsonrpc: "2.0", method: "tools/call", id: null }),
    ).toThrow("request id must be a string or number");
    expect(() =>
      assertJsonRpcMessage({
        jsonrpc: "2.0",
        method: "tools/call",
        params: "nope",
      }),
    ).toThrow("params must be an object or array");
    expect(() =>
      assertJsonRpcMessage({ jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "x" } }),
    ).toThrow("exactly one of result or error");
    expect(() =>
      assertJsonRpcMessage({ jsonrpc: "2.0", id: 1, error: { code: "x", message: "nope" } }),
    ).toThrow("numeric code and string message");
  });
});

describe("pumpJsonRpcNdjson", () => {
  it("preserves exact bytes, IDs, cancellation, and out-of-order responses", async () => {
    const raw = [
      '{ "jsonrpc":"2.0", "id":1, "method":"tools/call" }\r\n',
      '{"jsonrpc":"2.0","id":"two","method":"tools/call"}\n',
      '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n',
      '{"jsonrpc":"2.0","id":"two","result":{"ok":true}}\n',
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n',
    ].join("");
    const output: Buffer[] = [];
    await pumpJsonRpcNdjson(
      Readable.from([Buffer.from(raw).subarray(0, 31), Buffer.from(raw).subarray(31)]),
      collectingWritable(output),
    );
    expect(Buffer.concat(output).toString()).toBe(raw);
  });

  it("serializes only when a hook transforms a message", async () => {
    const raw = '{ "jsonrpc":"2.0", "id":"x", "method":"tools/list" }\r\n';
    const unchanged: Buffer[] = [];
    await pumpJsonRpcNdjson(
      Readable.from([raw]),
      collectingWritable(unchanged),
      { hook: () => undefined },
    );
    expect(Buffer.concat(unchanged).toString()).toBe(raw);

    const transformed: Buffer[] = [];
    await pumpJsonRpcNdjson(
      Readable.from([raw]),
      collectingWritable(transformed),
      {
        hook: (message): JsonRpcMessage => ({
          ...message,
          params: { injected: true },
        }),
      },
    );
    expect(Buffer.concat(transformed).toString()).toBe(
      '{"jsonrpc":"2.0","id":"x","method":"tools/list","params":{"injected":true}}\n',
    );
  });

  it("waits for destination backpressure before forwarding the next record", async () => {
    const writes: string[] = [];
    const firstWriteStarted = createDeferred<void>();
    const releaseFirstWrite = createDeferred<void>();
    let writeCount = 0;
    const destination = collectingWritable([], async (chunk) => {
      writeCount += 1;
      if (writeCount === 1) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      writes.push(chunk.toString());
    });
    const pumping = pumpJsonRpcNdjson(
      Readable.from([
        '{"jsonrpc":"2.0","id":1,"method":"one"}\n' +
          '{"jsonrpc":"2.0","id":2,"method":"two"}\n',
      ]),
      destination,
    );
    await firstWriteStarted.promise;
    expect(writeCount).toBe(1);
    expect(writes).toEqual([]);
    releaseFirstWrite.resolve();
    await pumping;
    expect(writeCount).toBe(2);
    expect(writes).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"one"}\n',
      '{"jsonrpc":"2.0","id":2,"method":"two"}\n',
    ]);
  });

  it("diverts an intercepted record to interceptDestination instead of forwarding or hooking", async () => {
    const raw =
      '{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n' +
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n';
    const forwarded: Buffer[] = [];
    const intercepted: Buffer[] = [];
    let hookCalls = 0;
    await pumpJsonRpcNdjson(Readable.from([raw]), collectingWritable(forwarded), {
      hook: () => {
        hookCalls += 1;
        return undefined;
      },
      intercept: (message) =>
        message.method === "tools/call"
          ? { jsonrpc: "2.0", id: message.id as string | number, error: { code: -32050, message: "busy" } }
          : undefined,
      interceptDestination: collectingWritable(intercepted),
    });
    expect(Buffer.concat(intercepted).toString()).toBe(
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32050,"message":"busy"}}\n',
    );
    expect(Buffer.concat(forwarded).toString()).toBe(
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
    );
    // The hook only ever sees the record that fell through interception.
    expect(hookCalls).toBe(1);
  });

  it("requires interceptDestination whenever intercept is set", async () => {
    await expect(
      pumpJsonRpcNdjson(Readable.from(['{"jsonrpc":"2.0","id":1,"method":"x"}\n']), collectingWritable([]), {
        intercept: () => undefined,
      }),
    ).rejects.toThrow(/interceptDestination/);
  });

  it("createJsonRpcWriteQueue never overlaps two writers on the same destination", async () => {
    const events: string[] = [];
    let inFlight = false;
    const destination = collectingWritable([], async (chunk) => {
      if (inFlight) {
        throw new Error(`overlapping write detected: ${chunk.toString()}`);
      }
      inFlight = true;
      events.push(`start:${chunk.toString().trim()}`);
      // A slow write for the first record — a concurrent second writer must
      // wait for this to fully finish before its own write begins.
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`end:${chunk.toString().trim()}`);
      inFlight = false;
    });
    const queue = createJsonRpcWriteQueue();
    const first = queue(() => new Promise<void>((resolve) => {
      destination.write(Buffer.from("first\n"), () => resolve());
    }));
    // Issued immediately after, while `first` is still in flight.
    const second = queue(() => new Promise<void>((resolve) => {
      destination.write(Buffer.from("second\n"), () => resolve());
    }));
    await Promise.all([first, second]);
    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("interleaving a busy rejection with an in-flight child response never produces a torn frame", async () => {
    // Mirrors the DevTools relay's wiring: two independent pumps writing to
    // the same client-facing stream through one shared write queue — the
    // intercept path (busy rejection) and the normal forward path (child
    // response), racing for real.
    const output: Buffer[] = [];
    const slowFirstWrite = collectingWritable(output, async () => {
      // Only the *first* physical write to land is slowed, so the second
      // writer's attempt genuinely overlaps in wall-clock time with the
      // first's in-flight write — the scenario the queue must serialize.
      if (output.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });
    const queue = createJsonRpcWriteQueue();

    const childResponsePump = pumpJsonRpcNdjson(
      Readable.from(['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n']),
      slowFirstWrite,
      { writeSerializer: queue },
    );
    const busyRejectionPump = pumpJsonRpcNdjson(
      Readable.from(['{"jsonrpc":"2.0","id":2,"method":"tools/call"}\n']),
      new Writable({ write: (_c, _e, cb) => cb() }), // never forwarded (intercepted)
      {
        intercept: (message) => ({
          jsonrpc: "2.0",
          id: message.id as number,
          error: { code: -32050, message: "busy" },
        }),
        interceptDestination: slowFirstWrite,
        interceptWriteSerializer: queue,
      },
    );

    await Promise.all([childResponsePump, busyRejectionPump]);

    // Both writes landed as two complete, well-formed, individually parsed
    // lines — never merged, torn, or interleaved mid-frame.
    expect(output).toHaveLength(2);
    const lines = output.map((chunk) => JSON.parse(chunk.toString()) as JsonRpcMessage);
    const byId = new Map(lines.map((line) => [line.id, line]));
    expect(byId.get(1)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(byId.get(2)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32050, message: "busy" },
    });
  });
});
