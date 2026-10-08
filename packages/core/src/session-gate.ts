import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type EnvLike } from "./paths.js";
import { sessionDataDir } from "./session.js";

const GATE_WAIT_MS = 5_000;
const GATE_POLL_MS = 10;

function tryGate(socketPath: string): Promise<net.Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(undefined);
      else reject(new Error(`Cannot acquire session input gate: ${error.code ?? error.message}`, { cause: error }));
    });
    server.listen({ path: socketPath }, () => resolve(server));
  });
}

/** Linux releases this abstract socket when its holder exits, including SIGKILL. */
export async function withSessionGate<T>(
  id: string,
  env: EnvLike,
  action: (root: string) => Promise<T>,
  timeoutMs = GATE_WAIT_MS,
): Promise<T> {
  const rootPath = path.resolve(path.dirname(sessionDataDir(id, env)));
  const root = fs.existsSync(rootPath) ? await fs.promises.realpath(rootPath) : rootPath;
  const key = crypto.createHash("sha256").update(JSON.stringify([root, id, process.getuid?.()])).digest("hex");
  const deadline = Date.now() + timeoutMs;
  let server: net.Server | undefined;
  while ((server = await tryGate(`\0pickforge-input-${key}`)) === undefined) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for session input gate for ${id}`);
    await delay(GATE_POLL_MS);
  }
  try {
    return await action(rootPath);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
