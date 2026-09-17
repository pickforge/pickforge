import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getSession, processIdentityMatches, type EnvLike } from "@pickforge/lab-core";
import { remaining, typingFailure, X11_SETUP_MS } from "./x11-wire.js";

function boundedRead(file: string, limit: number, deadline: number): string {
  remaining(deadline);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw typingFailure();
    const data = Buffer.alloc(limit + 1);
    let size = 0;
    // seq_file reads can be short before EOF. Every non-EOF read consumes at
    // least one byte, so limit + 1 calls suffice even for one-byte chunks.
    for (let reads = 0; reads <= limit; reads++) {
      remaining(deadline);
      const count = fs.readSync(fd, data, size, data.length - size, null);
      remaining(deadline);
      if (count === 0) return data.subarray(0, size).toString("utf8");
      size += count;
      if (size > limit) throw typingFailure();
    }
    throw typingFailure();
  } finally {
    fs.closeSync(fd);
  }
}

function listenerInode(line: string, socketPath: string): string[] {
  if (!line.includes(socketPath)) return [];
  const row = /^[ \t]*[\da-fA-F]{1,16}:[ \t]+[\da-fA-F]{1,8}[ \t]+([\da-fA-F]{1,8})[ \t]+([\da-fA-F]{1,8})[ \t]+([\da-fA-F]{1,4})[ \t]+([\da-fA-F]{1,2})[ \t]+([1-9]\d*)[ \t]+(.+)$/.exec(line);
  if (!row) throw typingFailure();
  if (row[6] !== socketPath) return [];
  if (parseInt(row[1]!, 16) !== 0 || parseInt(row[3]!, 16) !== 1) throw typingFailure();
  const flags = parseInt(row[2]!, 16);
  const state = parseInt(row[4]!, 16);
  if (flags === 0x10000 && state === 1) return [row[5]!];
  // An accepted stream can retain the listener pathname. It is not proof
  // of a listener, and must not compete with the unique listening inode.
  if (flags === 0 && state === 3) return [];
  throw typingFailure();
}

function ownsSocket(pid: number, socketPath: string, deadline: number): boolean {
  const table = boundedRead("/proc/net/unix", 1024 * 1024, deadline);
  if (!table.endsWith("\n")) throw typingFailure(); // Do not trust a truncated final record.
  const inodes = table.split("\n").flatMap((line) => {
    remaining(deadline);
    return listenerInode(line, socketPath);
  });
  if (inodes.length !== 1) return false;
  const directory = fs.opendirSync(`/proc/${pid}/fd`);
  try {
    for (let count = 0; count < 4096; count++) {
      remaining(deadline);
      const entry = directory.readSync();
      if (entry === null) return false;
      let target: string;
      try { target = fs.readlinkSync(`/proc/${pid}/fd/${entry.name}`); }
      catch { continue; } // A closing descriptor is not ownership evidence.
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match && inodes[0] === match[1]) return true;
    }
    return false;
  } finally {
    directory.closeSync();
  }
}

function processOwnsTarget(pid: number, display: string, socketPath: string, deadline: number): void {
  const uid = process.getuid?.();
  const socket = fs.lstatSync(socketPath);
  if (uid === undefined || !socket.isSocket() || socket.uid !== uid || fs.statSync(`/proc/${pid}`).uid !== uid) {
    throw typingFailure();
  }
  const argv = boundedRead(`/proc/${pid}/cmdline`, 4096, deadline).split("\0").filter(Boolean);
  if (path.basename(argv[0] ?? "") !== "Xvfb" || argv[1] !== display || argv.includes("-auth")) throw typingFailure();
  const noListen = argv.indexOf("-nolisten");
  if (noListen < 0 || argv[noListen + 1] !== "tcp") throw typingFailure();
  const lock = boundedRead(`/tmp/.X${display.slice(1)}-lock`, 64, deadline).trim();
  if (lock !== String(pid) || !ownsSocket(pid, socketPath, deadline)) throw typingFailure();
}

/** Linux procfs, UID, lock and socket-owner checks, not SO_PEERCRED or a
 * cryptographic peer identity. Never consult XAUTHORITY or home configuration.
 */
export async function validateTypingTarget(sessionId: string, display: string, env: EnvLike, deadline = performance.now() + X11_SETUP_MS): Promise<{ path: string; alive: () => boolean }> {
  try {
    remaining(deadline);
    if (!/^:(0|[1-9]\d{0,5})$/.test(display)) throw typingFailure();
    const record = await getSession(sessionId, env);
    remaining(deadline);
    const desktop = record?.desktop;
    // Desktop capability is the presence of a desktop leg, not its type label.
    if (desktop === undefined || record?.status !== "running" || desktop.display !== display) throw typingFailure();
    const pid = desktop.xvfbPid;
    const startTicks = desktop.xvfbStartTimeTicks;
    if (!Number.isSafeInteger(pid) || pid! <= 0) throw typingFailure();
    if (!Number.isSafeInteger(startTicks) || startTicks! < 0) throw typingFailure();
    const identity = { pid: pid!, startTicks: startTicks! };
    const alive = () => processIdentityMatches(identity);
    if (!alive()) throw typingFailure();
    const socketPath = `/tmp/.X11-unix/X${display.slice(1)}`;
    processOwnsTarget(pid!, display, socketPath, deadline);
    if (!alive()) throw typingFailure();
    remaining(deadline);
    return { path: socketPath, alive };
  } catch {
    throw typingFailure();
  }
}
