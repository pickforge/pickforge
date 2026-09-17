import net from "node:net";
import { performance } from "node:perf_hooks";

const MAX_PACKET = 256 * 1024;
const MAX_TRAFFIC = 1024 * 1024;
const MAX_PACKETS = 4096;
export const X11_SETUP_MS = 3000;
export const X11_GRAB_MS = 250;

export function typingFailure(): Error {
  return new Error("Desktop text preparation failed; no text was sent");
}

export function remaining(deadline: number): number {
  const left = Math.floor(deadline - performance.now());
  if (left <= 0) throw typingFailure();
  return left;
}

export function request(opcode: number, bytes = 4, detail = 0): Buffer {
  const data = Buffer.alloc(bytes);
  data[0] = opcode;
  data[1] = detail;
  data.writeUInt16LE(bytes / 4, 2);
  return data;
}

interface Pending {
  sequence: number;
  resolve: (reply: Buffer) => void;
  reject: (error: Error) => void;
}

/** Only little-endian core replies, MappingNotify, and empty-auth setup.
 * One outstanding reply keeps sequence ownership explicit. All loops consume
 * bytes, and both cumulative work and retained storage have fixed ceilings.
 */
export class X11Wire {
  private readonly socket: net.Socket;
  private timer: ReturnType<typeof setTimeout>;
  private buffer = Buffer.alloc(0);
  private pending?: Pending;
  private sequence = 0;
  private setup = true;
  private traffic = 0;
  private packets = 0;
  private failed = false;
  private deadline: number;
  private readonly overallDeadline: number;
  readonly preparationDeadline: number;
  private readonly loss = new AbortController();
  private healthTimer?: ReturnType<typeof setInterval>;
  private passive = false;
  private grabState: "none" | "grabbed" | "released" | "synced" = "none";
  private ungrabSync?: number;

  get signal(): AbortSignal { return this.loss.signal; }

  constructor(socketPath: string, deadline: number, private readonly alive: () => boolean, preparationDeadline = performance.now() + X11_SETUP_MS) {
    this.overallDeadline = deadline;
    this.deadline = Math.min(deadline, preparationDeadline);
    this.preparationDeadline = this.deadline;
    const timeout = remaining(this.deadline);
    if (!alive()) throw typingFailure();
    this.socket = net.createConnection({ path: socketPath });
    this.timer = setTimeout(() => this.fail(), timeout);
    this.socket.on("data", (chunk: Buffer) => this.receive(chunk));
    this.socket.on("error", () => this.fail());
    this.socket.on("end", () => this.fail());
    this.socket.on("close", () => this.fail());
  }

  check(): void {
    try {
      remaining(this.deadline);
      if (this.failed || !this.alive()) throw typingFailure();
    } catch {
      this.fail();
      throw typingFailure();
    }
  }

  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.timer);
    clearInterval(this.healthTimer);
    this.socket.destroy();
    this.buffer = Buffer.alloc(0);
    this.loss.abort();
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(typingFailure());
  }

  close(): void {
    this.fail();
  }

  retain(): this {
    this.check();
    if (this.passive || this.pending || this.grabState !== "synced") {
      this.fail();
      throw typingFailure();
    }
    this.passive = true;
    this.deadline = this.overallDeadline;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(), remaining(this.deadline));
    this.healthTimer = setInterval(() => {
      try { this.check(); } catch { this.fail(); }
    }, 50);
    return this;
  }

  boundGrab(totalDeadline: number): void {
    this.active();
    this.deadline = Math.min(this.deadline, this.overallDeadline, totalDeadline, performance.now() + X11_GRAB_MS);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(), remaining(this.deadline));
  }

  private packetLength(): number | undefined {
    const header = this.setup ? 8 : 32;
    if (this.buffer.length < header) return undefined;
    if (this.setup) return 8 + this.buffer.readUInt16LE(6) * 4;
    const kind = this.buffer[0];
    if (kind === 1) return 32 + this.buffer.readUInt32LE(4) * 4;
    if (kind === 34) return 32;
    throw typingFailure();
  }

  private receive(chunk: Buffer): void {
    try {
      this.check();
      this.traffic += chunk.length;
      if (this.traffic > MAX_TRAFFIC || this.buffer.length + chunk.length > MAX_PACKET) {
        throw typingFailure();
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    } catch {
      this.fail();
    }
  }

  private drain(): void {
    for (;;) {
      this.check();
      const size = this.packetLength();
      if (size === undefined) return;
      if (size > MAX_PACKET) throw typingFailure();
      if (this.buffer.length < size) return;
      if (++this.packets > MAX_PACKETS) throw typingFailure();
      const packet = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      if (!this.setup && packet[0] === 34) continue;
      this.deliver(packet);
    }
  }

  private deliver(packet: Buffer): void {
    const pending = this.pending;
    if (!pending) throw typingFailure();
    if (!this.setup && packet.readUInt16LE(2) !== pending.sequence) throw typingFailure();
    this.setup = false;
    this.pending = undefined;
    if (pending.sequence === this.ungrabSync && packet.length === 32) this.grabState = "synced";
    pending.resolve(packet);
  }

  async hello(): Promise<{ min: number; max: number }> {
    const hello = Buffer.alloc(12);
    hello[0] = 0x6c; // The wire byte order, regardless of image/bitmap order.
    hello.writeUInt16LE(11, 2);
    const reply = await this.exchange(hello, 0);
    if (reply.length < 40 || reply[0] !== 1 || reply.readUInt16LE(2) !== 11 || reply.readUInt16LE(4) !== 0) {
      throw typingFailure();
    }
    const min = reply[34]!;
    const max = reply[35]!;
    if (min < 8 || max < min || reply[28] === 0) throw typingFailure();
    if (reply.readUInt16LE(26) < 7 || reply[30]! > 1 || reply[31]! > 1) throw typingFailure();
    this.validateSetupLayout(reply);
    return { min, max };
  }

  private validateSetupLayout(reply: Buffer): void {
    let offset = 40 + ((reply.readUInt16LE(24) + 3) & ~3) + reply[29]! * 8;
    for (let screen = 0; screen < reply[28]!; screen++) {
      this.check();
      if (offset + 40 > reply.length) throw typingFailure();
      const depths = reply[offset + 39]!;
      offset += 40;
      for (let depth = 0; depth < depths; depth++) {
        this.check();
        if (offset + 8 > reply.length) throw typingFailure();
        const visuals = reply.readUInt16LE(offset + 2);
        offset += 8 + visuals * 24;
        if (offset > reply.length) throw typingFailure();
      }
    }
    if (offset !== reply.length) throw typingFailure();
  }

  private active(): void {
    this.check();
    if (this.passive) { this.fail(); throw typingFailure(); }
  }

  send(data: Buffer): number {
    this.active();
    if (data[0] === 36) this.grabState = "grabbed";
    if (data[0] === 37 && this.grabState === "grabbed") this.grabState = "released";
    this.sequence = (this.sequence + 1) & 0xffff;
    this.socket.write(data);
    return this.sequence;
  }

  reply(data: Buffer): Promise<Buffer> {
    return this.exchange(data, (this.sequence + 1) & 0xffff);
  }

  private exchange(data: Buffer, sequence: number): Promise<Buffer> {
    this.active();
    if (this.pending) throw typingFailure();
    if (data[0] === 43 && this.grabState === "released") this.ungrabSync = sequence;
    return new Promise((resolve, reject) => {
      this.pending = { sequence, resolve, reject };
      this.sequence = sequence;
      this.socket.write(data);
    });
  }
}
