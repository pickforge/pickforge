import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { stopProcessGroupVerified } from "@pickforge/lab-core";
import { buildVncArgs, startVnc, type VncHandle } from "../src/vnc.js";
import { findOnPath } from "../src/util.js";
import {
  allocateDisplay,
  buildXvfbArgs,
  startXvfb,
  stopXvfb,
  type XvfbHandle,
} from "../src/index.js";

const pendingBytes = new WeakMap<net.Socket, Buffer>();

async function readBytes(socket: net.Socket, length: number): Promise<Buffer> {
  let available = pendingBytes.get(socket) ?? Buffer.alloc(0);
  while (available.length < length) {
    const chunk = socket.read() as Buffer | null;
    if (chunk !== null) {
      available = Buffer.concat([available, chunk]);
    } else {
      if (socket.destroyed || socket.readableEnded) {
        throw new Error("RFB connection ended");
      }
      await once(socket, "readable");
    }
  }
  pendingBytes.set(socket, available.subarray(length));
  return available.subarray(0, length);
}

class RfbFramebuffer {
  readonly pixels: Buffer;
  cursorShapes = 0;
  cursorPositions = 0;

  constructor(
    readonly socket: net.Socket,
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = Buffer.alloc(width * height * 4);
  }

  async rectangle(): Promise<number> {
    const header = await readBytes(this.socket, 12);
    const x = header.readUInt16BE(0);
    const y = header.readUInt16BE(2);
    const width = header.readUInt16BE(4);
    const height = header.readUInt16BE(6);
    const encoding = header.readInt32BE(8);
    if (encoding === -239) {
      this.cursorShapes++;
      await readBytes(
        this.socket,
        width * height * 4 + Math.ceil(width / 8) * height,
      );
      return 0;
    }
    if (encoding === -232) {
      this.cursorPositions++;
      return 0;
    }
    expect(encoding).toBe(0);
    const pixels = await readBytes(this.socket, width * height * 4);
    for (let row = 0; row < height; row++) {
      pixels.copy(
        this.pixels,
        ((y + row) * this.width + x) * 4,
        row * width * 4,
        (row + 1) * width * 4,
      );
    }
    return width * height;
  }

  async snapshot(incremental = false): Promise<Buffer> {
    const request = Buffer.alloc(10);
    request[0] = 3;
    request[1] = incremental ? 1 : 0;
    request.writeUInt16BE(this.width, 6);
    request.writeUInt16BE(this.height, 8);
    this.socket.write(request);
    let pixelsReceived = 0;
    do {
      expect((await readBytes(this.socket, 1))[0]).toBe(0);
      const update = await readBytes(this.socket, 3);
      for (let rectangle = 0; rectangle < update.readUInt16BE(1); rectangle++) {
        pixelsReceived += await this.rectangle();
      }
    } while (!incremental && pixelsReceived < this.width * this.height);
    return Buffer.from(this.pixels);
  }
}

async function connectRfb(port: number): Promise<RfbFramebuffer> {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setTimeout(5_000, () => socket.destroy(new Error("RFB deadline")));
  socket.on("error", () => {});
  await once(socket, "connect");
  try {
    expect((await readBytes(socket, 12)).toString()).toMatch(
      /^RFB 003\.00[78]\n$/,
    );
    socket.write("RFB 003.008\n");
    const count = (await readBytes(socket, 1))[0]!;
    expect(await readBytes(socket, count)).toContain(1);
    socket.write(Buffer.from([1]));
    expect((await readBytes(socket, 4)).readUInt32BE()).toBe(0);
    socket.write(Buffer.from([1]));
    const server = await readBytes(socket, 24);
    await readBytes(socket, server.readUInt32BE(20));
    const format = Buffer.alloc(20);
    format.set([32, 24, 0, 1], 4);
    for (const offset of [8, 10, 12]) {
      format.writeUInt16BE(255, offset);
    }
    format.set([16, 8, 0], 14);
    socket.write(format);
    const encodings = Buffer.alloc(16);
    encodings[0] = 2;
    encodings.writeUInt16BE(3, 2);
    encodings.writeInt32BE(0, 4);
    encodings.writeInt32BE(-239, 8);
    encodings.writeInt32BE(-232, 12);
    socket.write(encodings);
    return new RfbFramebuffer(
      socket,
      server.readUInt16BE(0),
      server.readUInt16BE(2),
    );
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function cursorPixelChanges(
  first: Buffer,
  second: Buffer,
  width: number,
): { oldPosition: number; newPosition: number; elsewhere: number } {
  const changes = { oldPosition: 0, newPosition: 0, elsewhere: 0 };
  for (let offset = 0; offset < first.length; offset += 4) {
    if (
      first
        .subarray(offset, offset + 3)
        .equals(second.subarray(offset, offset + 3))
    ) {
      continue;
    }
    const x = (offset / 4) % width;
    const y = Math.floor(offset / 4 / width);
    if (Math.abs(x - 60) < 32 && Math.abs(y - 70) < 32) {
      changes.oldPosition++;
    } else if (Math.abs(x - 200) < 32 && Math.abs(y - 130) < 32) {
      changes.newPosition++;
    } else {
      changes.elsewhere++;
    }
  }
  return changes;
}

async function snapshotWithCursorAt(
  framebuffer: RfbFramebuffer,
  display: string,
  x: number,
  y: number,
): Promise<Buffer> {
  execFileSync("xdotool", ["mousemove", "--sync", String(x), String(y)], {
    env: { ...process.env, DISPLAY: display },
  });
  let pixels: Buffer = Buffer.alloc(0);
  await vi.waitFor(
    async () => {
      pixels = await framebuffer.snapshot(true);
      let cursorPixels = 0;
      for (let row = y; row < y + 24; row++) {
        for (let column = x; column < x + 24; column++) {
          const offset = (row * framebuffer.width + column) * 4;
          if (
            !pixels.subarray(offset, offset + 3).equals(pixels.subarray(0, 3))
          ) {
            cursorPixels++;
          }
        }
      }
      expect(cursorPixels).toBeGreaterThan(0);
    },
    { timeout: 5_000, interval: 50 },
  );
  return pixels;
}

async function setVisibleRootCursor(display: string): Promise<ChildProcess> {
  // Xvfb starts without a visible cursor until an X client defines one.
  const client = spawn(
    "python3",
    [
      "-c",
      `
import ctypes
import sys
xlib = ctypes.CDLL('libX11.so.6')
xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
xlib.XOpenDisplay.restype = ctypes.c_void_p
xlib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
xlib.XDefaultRootWindow.restype = ctypes.c_ulong
xlib.XCreateFontCursor.argtypes = [ctypes.c_void_p, ctypes.c_uint]
xlib.XCreateFontCursor.restype = ctypes.c_ulong
xlib.XDefineCursor.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
xlib.XSetWindowBackground.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
xlib.XClearWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
xlib.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
connection = xlib.XOpenDisplay(sys.argv[1].encode())
if not connection:
    raise RuntimeError('Xvfb unavailable')
root = xlib.XDefaultRootWindow(connection)
cursor = xlib.XCreateFontCursor(connection, 68)
xlib.XDefineCursor(connection, root, cursor)
xlib.XSetWindowBackground(connection, root, 0x335577)
xlib.XClearWindow(connection, root)
xlib.XSync(connection, 0)
class CursorImage(ctypes.Structure):
    _fields_ = [('x', ctypes.c_short), ('y', ctypes.c_short),
                ('width', ctypes.c_ushort), ('height', ctypes.c_ushort),
                ('xhot', ctypes.c_ushort), ('yhot', ctypes.c_ushort)]
fixes = ctypes.CDLL('libXfixes.so.3')
fixes.XFixesGetCursorImage.argtypes = [ctypes.c_void_p]
fixes.XFixesGetCursorImage.restype = ctypes.POINTER(CursorImage)
image = fixes.XFixesGetCursorImage(connection).contents
print('cursor size', image.width, image.height, flush=True)
if not image.width or not image.height:
    raise RuntimeError('Visible X cursor unavailable')
print('ready', flush=True)
sys.stdin.read()
xlib.XCloseDisplay(connection)
`,
      display,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const [ready] = await once(client.stdout!, "data");
  console.info("X cursor fixture:", ready.toString().trim());
  return client;
}

const prerequisites = ["Xvfb", "xdotool", "x11vnc", "python3"].every(
  (binary) => findOnPath(binary) !== null,
);

it.skipIf(!prerequisites)(
  "paints the session pointer into read-only RFB pixels even when cursor extensions are offered",
  async () => {
    const directory = await fs.mkdtemp(
      path.join(process.cwd(), ".viewer-cursor-test-"),
    );
    const allocatedDisplay = allocateDisplay({ start: 1_001 });
    const displayOptions = {
      display: allocatedDisplay,
      width: 320,
      height: 200,
      depth: 24,
      logDir: directory,
    };
    const displayArgs = buildXvfbArgs(displayOptions);
    let displayServer: XvfbHandle | undefined;
    let vnc: VncHandle | undefined;
    let framebuffer: RfbFramebuffer | undefined;
    let cursorClient: ChildProcess | undefined;
    try {
      displayServer = await startXvfb(displayOptions);
      const display = displayServer.display;
      expect(display).toBe(allocatedDisplay);
      cursorClient = await setVisibleRootCursor(display);
      vnc = await startVnc({
        display,
        port: await freePort(),
        logDir: directory,
        env: { HOME: directory },
      });
      framebuffer = await connectRfb(vnc.port);
      await framebuffer.snapshot();
      const first = await snapshotWithCursorAt(framebuffer, display, 60, 70);
      const second = await snapshotWithCursorAt(framebuffer, display, 200, 130);
      const changes = cursorPixelChanges(first, second, framebuffer.width);
      console.info(
        "Cursor framebuffer evidence:",
        JSON.stringify({
          display,
          displayArgs,
          vncArgs: buildVncArgs({ display, port: vnc.port }),
          moves: [
            [60, 70],
            [200, 130],
          ],
          changes,
          cursorShapes: framebuffer.cursorShapes,
          cursorPositions: framebuffer.cursorPositions,
        }),
      );
      expect(changes.oldPosition).toBeGreaterThan(0);
      expect(changes.newPosition).toBeGreaterThan(0);
      expect(changes.elsewhere).toBe(0);
      expect(framebuffer.cursorShapes).toBe(0);
    } finally {
      framebuffer?.socket.destroy();
      if (vnc !== undefined) {
        await stopProcessGroupVerified({
          pid: vnc.pid,
          startTicks: vnc.startTimeTicks,
        });
      }
      if (cursorClient?.exitCode === null && cursorClient.signalCode === null) {
        const cursorClosed = once(cursorClient, "exit");
        cursorClient.stdin!.end();
        await cursorClosed;
      }
      if (displayServer !== undefined) {
        expect(
          await stopXvfb(displayServer.pid, displayServer.startTimeTicks),
        ).toBe(true);
      }
      const displayNumber = allocatedDisplay.slice(1);
      await expect(fs.lstat(`/tmp/.X${displayNumber}-lock`)).rejects.toThrow();
      await expect(
        fs.lstat(`/tmp/.X11-unix/X${displayNumber}`),
      ).rejects.toThrow();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);
