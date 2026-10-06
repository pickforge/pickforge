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

/**
 * A loopback port that is free now and not yet handed out in this file. Fixed
 * ports collide when two suites run at once (#252), so pick at random.
 */
export async function freeLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt += 1) {
    const port = randomBetween(PORT_MIN, PORT_MAX);
    if (handedOutPorts.has(port)) continue;
    handedOutPorts.add(port);
    if (await canListen(port)) return port;
  }
  throw new Error("No free loopback port found for the test");
}

/**
 * An explicit display that no lock or socket claims now. Fixed numbers collide
 * when two suites run at once and startXvfb then reports a lost race (#252).
 */
export function unusedTestDisplay(): string {
  for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt += 1) {
    const display = randomBetween(DISPLAY_MIN, DISPLAY_MAX);
    if (
      !fs.existsSync(`/tmp/.X${display}-lock`) &&
      !fs.existsSync(`/tmp/.X11-unix/X${display}`)
    ) {
      return `:${display}`;
    }
  }
  throw new Error("No unused X display found for the test");
}
