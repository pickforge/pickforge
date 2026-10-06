import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readProcessStartTicks } from "@pickforge/lab-core";

// Below the kernel's local port range (32768-60999 by default), so no outgoing
// connection is handed one of these ports while a fake server waits to bind.
const PORT_MIN = 20_000;
const PORT_MAX = 32_000;
const DISPLAY_MIN = 10_000;
const DISPLAY_MAX = 50_000;
const PICK_ATTEMPTS = 100;
const handedOutPorts = new Set<number>();
const reservedPorts = new Set<number>();
// Shared by every test process of this user, so concurrent suites see each
// other's reservations until the fake or real VNC server binds the port.
const RESERVATION_DIR = path.join(
  os.tmpdir(),
  `pickforge-test-ports-${process.getuid?.() ?? "user"}`,
);
const OWNER = `${process.pid} ${readProcessStartTicks(process.pid) ?? -1}\n`;

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

function reservationPath(port: number): string {
  return path.join(RESERVATION_DIR, `${port}.lock`);
}

function readOwner(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Whether a reservation names a process that no longer runs. */
function ownerIsDead(owner: string): boolean {
  const [pid, ticks] = owner.trim().split(" ").map(Number);
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return true;
  return readProcessStartTicks(pid) !== ticks;
}

/**
 * Removes a dead owner's reservation. The file is first renamed away and then
 * compared, so a racing process never deletes a reservation made meanwhile.
 */
function removeStaleReservation(file: string, staleOwner: string): void {
  const moved = `${file}.${process.pid}.stale`;
  try {
    fs.renameSync(file, moved);
  } catch {
    return;
  }
  if (readOwner(moved) !== staleOwner) {
    try {
      fs.linkSync(moved, file);
    } catch {
      // Someone reserved the port again in the meantime; theirs stands.
    }
  }
  fs.rmSync(moved, { force: true });
}

/** Creates the port's reservation file atomically with its full content. */
function tryReserve(port: number): boolean {
  fs.mkdirSync(RESERVATION_DIR, { recursive: true, mode: 0o700 });
  const file = reservationPath(port);
  const draft = `${file}.${process.pid}.draft`;
  fs.writeFileSync(draft, OWNER);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.linkSync(draft, file);
        reservedPorts.add(port);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const owner = readOwner(file);
      if (owner === undefined || !ownerIsDead(owner)) return false;
      removeStaleReservation(file, owner);
    }
    return false;
  } finally {
    fs.rmSync(draft, { force: true });
  }
}

function releasePort(port: number): void {
  const file = reservationPath(port);
  if (readOwner(file) === OWNER) fs.rmSync(file, { force: true });
  reservedPorts.delete(port);
}

/**
 * Releases every port this process reserved. Call it in teardown, after the
 * servers that used the ports have stopped. Process exit also releases them,
 * and a crashed run's reservations count as stale once its process is gone.
 */
export function releaseLoopbackPorts(): void {
  for (const port of reservedPorts) releasePort(port);
}

process.once("exit", releaseLoopbackPorts);

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
    if (!tryReserve(port)) continue;
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
