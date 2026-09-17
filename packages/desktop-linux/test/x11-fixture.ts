import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { vi } from "vitest";

interface Client { socket: net.Socket; buffer: Buffer; setup: boolean; sequence: number }
export type ReplyFault = (opcode: number, reply: Buffer, client: net.Socket) => Buffer | undefined;

/** Scripted protocol peer, not Xvfb. It models grabs, core map updates and
 * explicit XKB groups/types independently of the production parser.
 */
export class FakeXServer {
  readonly rows = new Map<number, number[]>();
  readonly modifiers = new Set([200]);
  readonly changes: number[] = [];
  readonly requests: number[] = [];
  readonly sockets = new Set<net.Socket>();
  readonly wires = new Set<net.Socket>();
  resetOnLastClient = false;
  private readonly initialRows = new Map<number, number[]>();
  readonly deliveredChunks: number[] = [];
  grab?: net.Socket;
  connections = 0;
  inputCalls = 0;
  fault?: ReplyFault;
  fragments = false;
  notify = true;
  collapseGroups = false;
  private readonly server: net.Server;
  private readonly waiting: { client: Client; request: Buffer }[] = [];

  constructor(readonly socketPath: string) {
    for (let cp = 32; cp <= 126; cp++) this.rows.set(cp, [cp]);
    this.rows.set(9, [0xff09]);
    this.rows.set(10, [0xff0a]);
    this.rows.set(13, [0xff0d]);
    this.rows.set(150, [0x07e1]); // Greek_alpha, a legacy keysym.
    this.rows.set(200, [0xffe1]); // Shift_L, a nonempty modifier.
    for (const [code, row] of this.rows) this.initialRows.set(code, [...row]);
    this.server = net.createServer((socket) => this.accept(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: net.Socket): void {
    this.connections++;
    this.sockets.add(socket);
    const client: Client = { socket, buffer: Buffer.alloc(0), setup: true, sequence: 0 };
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (this.grab === socket) this.release();
      if (this.resetOnLastClient && this.sockets.size === 0) {
        this.rows.clear();
        for (const [code, row] of this.initialRows) this.rows.set(code, [...row]);
      }
    });
    socket.on("data", (data: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, data]);
      this.consume(client);
    });
  }

  private consume(client: Client): void {
    while (client.buffer.length >= (client.setup ? 12 : 4)) {
      const length = client.setup ? 12 : client.buffer.readUInt16LE(2) * 4;
      if (length < 4) { client.socket.destroy(); return; }
      if (client.buffer.length < length) return;
      const packet = client.buffer.subarray(0, length);
      client.buffer = client.buffer.subarray(length);
      if (client.setup) {
        client.setup = false;
        if (packet[0] !== 0x6c || packet.readUInt16LE(2) !== 11 || packet.readUInt16LE(6) !== 0 || packet.readUInt16LE(8) !== 0) {
          client.socket.destroy(); return;
        }
        this.respond(client, -1, this.setupReply());
      } else {
        client.sequence++;
        this.dispatch(client, packet);
      }
    }
  }

  private setupReply(): Buffer {
    const reply = Buffer.alloc(80);
    reply[0] = 1;
    reply.writeUInt16LE(11, 2);
    reply.writeUInt16LE(18, 6);
    reply.writeUInt16LE(65535, 26);
    reply[28] = 1;
    reply[34] = 8;
    reply[35] = 255;
    return reply;
  }

  private dispatch(client: Client, packet: Buffer): void {
    if (this.grab && this.grab !== client.socket) {
      this.waiting.push({ client, request: packet });
      return;
    }
    const opcode = packet[0]!;
    this.requests.push(opcode);
    if (opcode === 36) { this.grab = client.socket; return; }
    if (opcode === 37) { this.release(); return; }
    if (opcode === 100) { this.change(packet); return; }
    const reply = this.makeReply(opcode, packet);
    reply.writeUInt16LE(client.sequence, 2);
    this.respond(client, opcode, reply);
  }

  private release(): void {
    this.grab = undefined;
    const count = this.waiting.length;
    for (let i = 0; i < count; i++) {
      const item = this.waiting.shift()!;
      if (!item.client.socket.destroyed) this.dispatch(item.client, item.request);
    }
  }

  private change(packet: Buffer): void {
    if (!this.grab || packet[1] !== 1) throw new Error("Fixture expected a grabbed single-code update");
    const code = packet[4]!;
    this.changes.push(code);
    let symbols = Array.from({ length: packet[5]! }, (_, i) => packet.readUInt32LE(8 + 4 * i));
    if (this.collapseGroups) symbols = [symbols[0]!];
    this.rows.set(code, symbols);
  }

  private makeReply(opcode: number, packet: Buffer): Buffer {
    switch (opcode) {
      case 98: {
        const reply = Buffer.alloc(32); reply[0] = 1; reply[8] = 1; reply[9] = 135;
        return reply;
      }
      case 135: {
        if (packet[1] === 8) return this.xkbReply();
        const reply = Buffer.alloc(32); reply[0] = 1; reply[1] = 1; reply.writeUInt16LE(1, 8);
        return reply;
      }
      case 119: {
        const reply = Buffer.alloc(32 + this.modifiers.size * 8); reply[0] = 1; reply[1] = this.modifiers.size;
        reply.writeUInt32LE(this.modifiers.size * 2, 4);
        [...this.modifiers].forEach((code, i) => { reply[32 + i] = code; });
        return reply;
      }
      case 101: return this.coreReply();
      case 43: { const reply = Buffer.alloc(32); reply[0] = 1; return reply; }
      default: throw new Error("Unexpected fixture opcode");
    }
  }

  private coreReply(): Buffer {
    const reply = Buffer.alloc(32 + 248 * 4 * 4);
    reply[0] = 1; reply[1] = 4; reply.writeUInt32LE(248 * 4, 4);
    for (let code = 8; code <= 255; code++) {
      const row = this.rows.get(code) ?? [];
      row.forEach((sym, i) => reply.writeUInt32LE(sym, 32 + (code - 8) * 16 + i * 4));
    }
    return reply;
  }

  xkbReply(): Buffer {
    // ONE_LEVEL and TWO_LEVEL, each independently encoded per XKBproto.h.
    const types = Buffer.from([0,0,0,0,1,0,0,0, 1,1,0,0,2,1,0,0, 1,1,1,1,0,0,0,0]);
    let total = 0;
    const keys: Buffer[] = [];
    for (let code = 8; code <= 255; code++) {
      const row = this.rows.get(code) ?? [];
      const groups = row.length === 4 ? 2 : Math.min(1, row.length);
      const width = groups === 0 ? 0 : row.length / groups;
      const key = Buffer.alloc(8 + row.length * 4);
      key[0] = width > 1 ? 1 : 0; key[1] = key[0]; key[4] = groups; key[5] = width;
      key.writeUInt16LE(row.length, 6);
      row.forEach((sym, i) => key.writeUInt32LE(sym, 8 + i * 4));
      total += row.length; keys.push(key);
    }
    const header = Buffer.alloc(40);
    header[0] = 1; header[10] = 8; header[11] = 255; header.writeUInt16LE(3, 12);
    header[15] = 2; header[16] = 2; header[17] = 8; header[20] = 248; header.writeUInt16LE(total, 18);
    const reply = Buffer.concat([header, types, ...keys]);
    reply.writeUInt32LE((reply.length - 32) / 4, 4);
    return reply;
  }

  private respond(client: Client, opcode: number, original: Buffer): void {
    const reply = this.fault ? this.fault(opcode, original, client.socket) : original;
    if (!reply) return;
    const notify = Buffer.alloc(32); notify[0] = 34;
    const data = opcode !== -1 && this.notify ? Buffer.concat([notify, reply]) : reply;
    if (this.fragments) {
      client.socket.write(data.subarray(0, 3));
      client.socket.write(data.subarray(3, 17));
      client.socket.write(data.subarray(17));
    } else client.socket.write(data);
  }
}

/** File-backed fake procfs plus the real private fixture socket's stat. Only
 * the designated synthetic identity/display are redirected; no real X socket
 * is opened. The production target validator runs, rather than being mocked.
 */
export function installTargetFixture(root: string, server: FakeXServer): void {
  const files: Record<string, string> = {
    "/proc/777/cmdline": ["/usr/bin/Xvfb", ":190", "-screen", "0", "1280x800x24", "-nolisten", "tcp", ""].join("\0"),
    "/tmp/.X190-lock": "       777\n",
    "/proc/net/unix": "Num RefCount Protocol Flags Type St Inode Path\n0: 2 0 10000 0001 01 12345 /tmp/.X11-unix/X190\n",
  };
  const redirects = new Map<string, string>();
  Object.entries(files).forEach(([file, content], i) => {
    const fixture = path.join(root, `proc-${i}`); fs.writeFileSync(fixture, content); redirects.set(file, fixture);
  });
  const descriptors = path.join(root, "fd"); fs.mkdirSync(descriptors); fs.writeFileSync(path.join(descriptors, "3"), "");
  const open = fs.openSync.bind(fs);
  const stat = fs.statSync.bind(fs);
  const lstat = fs.lstatSync.bind(fs);
  const opendir = fs.opendirSync.bind(fs);
  const readlink = fs.readlinkSync.bind(fs);
  const connect = net.createConnection.bind(net);
  vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => Reflect.apply(open, fs, [redirects.get(String(file)) ?? file, ...args])) as typeof fs.openSync);
  vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => Reflect.apply(stat, fs, [String(file) === "/proc/777" ? root : file, ...args])) as typeof fs.statSync);
  vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => Reflect.apply(lstat, fs, [String(file) === "/tmp/.X11-unix/X190" ? server.socketPath : file, ...args])) as typeof fs.lstatSync);
  vi.spyOn(fs, "opendirSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => Reflect.apply(opendir, fs, [String(file) === "/proc/777/fd" ? descriptors : file, ...args])) as typeof fs.opendirSync);
  vi.spyOn(fs, "readlinkSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => String(file) === "/proc/777/fd/3" ? "socket:[12345]" : Reflect.apply(readlink, fs, [file, ...args])) as typeof fs.readlinkSync);
  vi.spyOn(net, "createConnection").mockImplementation(((options: net.NetConnectOpts) => {
    if (!("path" in options) || options.path !== "/tmp/.X11-unix/X190") throw new Error("Fixture refused nonmanaged connection");
    const socket = connect({ path: server.socketPath });
    server.wires.add(socket);
    socket.once("close", () => server.wires.delete(socket));
    const emit = socket.emit;
    // Force data callback boundaries too: separate server writes alone can
    // coalesce in the kernel and would not prove fragmented header handling.
    socket.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event !== "data" || !server.fragments) return Reflect.apply(emit, socket, [event, ...args]);
      const data = args[0] as Buffer;
      for (const chunk of [data.subarray(0, 3), data.subarray(3, 17), data.subarray(17)]) {
        if (chunk.length === 0) continue;
        server.deliveredChunks.push(chunk.length);
        Reflect.apply(emit, socket, ["data", chunk]);
      }
      return true;
    }) as typeof socket.emit;
    return socket;
  }) as typeof net.createConnection);
}
