import net from "node:net";
import { afterAll, beforeAll } from "vitest";

/**
 * The android tests use fixed, host-global console ports. The reservation
 * registry lives in each run's own temp home, so it cannot see another run,
 * and its TCP probe briefly binds every port it checks. Two concurrent runs of
 * one test file therefore take each other's ports (#280, #293).
 *
 * Each file holds one abstract Unix socket, shared by every process on the
 * host, so a second run of that file waits until the first is done. Files use
 * disjoint port windows and different lock names, so they still run in
 * parallel. The kernel frees the socket when its owner exits, so a crashed run
 * leaves nothing behind.
 */
const PORT_LOCK_WAIT_MS = 120_000;

function tryLock(name: string): Promise<net.Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", (error: NodeJS.ErrnoException) => {
      // Only a held lock means "wait"; any other failure is a real error.
      if (error.code === "EADDRINUSE") resolve(undefined);
      else reject(new Error(`cannot take the ${name} test port lock: ${error.code ?? error.message}`));
    });
    server.listen({ path: `\0pickforge-test-android-${name}-ports` }, () => resolve(server));
  });
}

/** Hold the named host-wide port lock from beforeAll until afterAll. */
export function holdTestPortLock(name: string): void {
  let lock: net.Server | undefined;
  beforeAll(async () => {
    const deadline = Date.now() + PORT_LOCK_WAIT_MS;
    while ((lock = await tryLock(name)) === undefined) {
      if (Date.now() > deadline) {
        throw new Error(`another run held the ${name} test ports for too long`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, PORT_LOCK_WAIT_MS + 5_000);
  afterAll(async () => {
    const held = lock;
    if (held !== undefined) await new Promise((resolve) => held.close(resolve));
  });
}
