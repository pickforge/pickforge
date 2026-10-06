import fs from "node:fs";
import net from "node:net";

// Below the kernel's local port range (32768-60999 by default), so no outgoing
// connection is handed one of these ports while a fake server waits to bind.
const PORT_MIN = 20_000;
const PORT_MAX = 32_000;
const DISPLAY_MIN = 10_000;
const DISPLAY_MAX = 50_000;
const PICK_ATTEMPTS = 100;
const handedOutPorts = new Set<number>();
// One abstract Unix socket per picked port, shared by every test process on
// the host, so concurrent suites see each other's reservations until the fake
// or real VNC server binds the port. The kernel frees a socket
// when its owner exits, so a crashed run leaves nothing stale behind.
const reservations = new Map<number, net.Server>();
const RESERVATION_PREFIX = "\0pickforge-test-port-";

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min));
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function tryReserve(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", () => resolve(false));
    server.listen({ path: `${RESERVATION_PREFIX}${port}` }, () => {
      server.unref();
      reservations.set(port, server);
      resolve(true);
    });
  });
}

function releasePort(port: number): void {
  reservations.get(port)?.close();
  reservations.delete(port);
}

/**
 * Releases every port this process reserved. Call it in teardown, after the
 * servers that used the ports have stopped. Process exit also releases them.
 */
export function releaseLoopbackPorts(): void {
  for (const port of reservations.keys()) releasePort(port);
}

/**
 * A loopback port that is free now and reserved for this process until
 * releaseLoopbackPorts. Fixed ports collide when two suites run at once
 * (#252), so pick at random, and reserve across processes because a free
 * port stays unbound until the VNC server starts.
 */
export async function freeLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt += 1) {
    const port = randomBetween(PORT_MIN, PORT_MAX);
    if (handedOutPorts.has(port)) continue;
    handedOutPorts.add(port);
    if (!(await tryReserve(port))) continue;
    if (await canListen(port)) return port;
    releasePort(port);
  }
  throw new Error("No free loopback port found for the test");
}

function displayIsUnused(display: number): boolean {
  return (
    !fs.existsSync(`/tmp/.X${display}-lock`) &&
    !fs.existsSync(`/tmp/.X11-unix/X${display}`)
  );
}

/**
 * An explicit display that no lock or socket claims now, nor do the next
 * `span - 1` numbers. Fixed numbers collide when two suites run at once and
 * startXvfb then reports a lost race (#252).
 */
export function unusedTestDisplay(span = 1): string {
  for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt += 1) {
    const display = randomBetween(DISPLAY_MIN, DISPLAY_MAX - span);
    let unused = true;
    for (let offset = 0; offset < span && unused; offset += 1) {
      unused = displayIsUnused(display + offset);
    }
    if (unused) return `:${display}`;
  }
  throw new Error("No unused X display found for the test");
}
