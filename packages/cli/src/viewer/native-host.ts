import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { getSession, readProcessIdentity, processIdentityMatches } from "@pickforge/lab-core";
import {
  prepareViewerLaunch, writeViewerLaunchRecord, verifyOwnedDisplayTarget,
  withViewerDir, writeViewerPrivateFile, sessionViewerDir, withSessionVncLock,
  VIEWER_MESSAGE_MAX_BYTES, validTakeoverMessage, validTakeoverTimeout,
  type StartHumanTakeoverOptions,
  type NativeViewerCommand, type NativeViewerHostIdentity, type NativeViewerLaunchRecord,
  type NativeViewerMode, type ViewerHostResponse, type ViewerWindowSize,
} from "@pickforge/lab-desktop-linux";
import { NativeControl } from "./native-control.js";
import { NativeRequests } from "./native-requests.js";
import type { SpawnWatchdogFn } from "../commands/takeover-hold.js";
import { viewerWindowSizes, viewerWindowClass } from "./launch.js";
import { viewerLabel } from "./contract.js";
import {
  detectHyprland, hyprlandRuleName, viewerClassPattern, installViewerRule,
  disableViewerRule, disableViewerOpacityRule, waitForViewerWindow, applyHyprlandWindowMode,
} from "./hyprland.js";

/** One bounded JSON object per line. Unknown discriminants are ignored by the caller. */
export function readViewerLines(stream: NodeJS.ReadableStream, onMessage: (message: Record<string, unknown>) => void, onError: () => void): void {
  let pending = Buffer.alloc(0);
  let failed = false;
  stream.on("data", (value: Buffer | string) => {
    if (failed) return;
    pending = Buffer.concat([pending, Buffer.from(value)]);
    while (pending.includes(10)) {
      const end = pending.indexOf(10);
      if (end > VIEWER_MESSAGE_MAX_BYTES) { failed = true; onError(); return; }
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      try {
        const message: unknown = JSON.parse(line.toString("utf8"));
        if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error("Invalid message");
        onMessage(message as Record<string, unknown>);
      } catch { failed = true; onError(); return; }
    }
    if (pending.length > VIEWER_MESSAGE_MAX_BYTES) { failed = true; onError(); }
  });
}

function validReadyScale(scale: unknown): boolean {
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0;
}

function validReady(message: Record<string, unknown>, record: NativeViewerLaunchRecord, version: string): boolean {
  if (message.version !== version || message.pid !== record.viewerPid) return false;
  if (!["wayland", "x11"].includes(String(message.backend)) || !validReadyScale(message.scale)) return false;
  return processIdentityMatches({ pid: record.viewerPid, startTicks: record.viewerStartTicks });
}

interface HostOperation {
  valid(request: Record<string, unknown>): boolean;
  run(request: Record<string, unknown>): Promise<void>;
  serial: boolean;
}

function watchOperation(run: () => Promise<void>, serial = false): HostOperation {
  return { valid: (request) => Object.keys(request).every((key) => key === "op"), run, serial };
}

class NativeHost {
  private readonly control: NativeControl;
  private readonly requests: NativeRequests;
  private exited = false;
  private stopped = false;
  private ended = false;
  private mode: NativeViewerMode | "fullscreen" = "thumbnail";
  private receivedReady = false;
  private timer?: NodeJS.Timeout;
  private readonly sessionMonitor = new AbortController();
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private host?: NativeViewerHostIdentity;
  private stopping?: Promise<void>;
  private actions = Promise.resolve();
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
  private readonly exit: Promise<void>;
  private readonly onSignal = (): void => { void this.stop(); };

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly record: NativeViewerLaunchRecord,
    private readonly version: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly options: NativeHostOptions,
  ) {
    this.requests = new NativeRequests({ env, send: (command) => this.send(command),
      mode: (mode) => this.setMode(mode), currentMode: () => this.mode, controlling: () => this.control.active });
    this.control = new NativeControl({ sessionId: record.sessionId, env, send: (command) => this.send(command),
      kill: () => { if (!this.exited) this.child.kill("SIGKILL"); },
      taken: () => this.requests.taken(), returned: (reason) => this.requests.returned(reason),
      takeoverOptions: { ...options._takeoverOptions, viewerPid: record.viewerPid, viewerStartTicks: record.viewerStartTicks }, spawnWatchdog: options._spawnWatchdog });
    this.exit = new Promise<void>((resolve) => child.once("exit", () => { this.exited = true; this.control.viewerExited(); resolve(); }));
    child.stderr.resume(); // Logs never enter socket responses or persisted state.
    child.stdin.on("error", () => {});
    process.on("SIGTERM", this.onSignal);
    process.on("SIGINT", this.onSignal);
  }

  private send(command: NativeViewerCommand): void {
    if (!this.exited && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private enqueue(operation: () => Promise<void>): void {
    this.actions = this.actions.then(operation).catch(() => { console.error("Native viewer operation failed"); });
  }

  private async setMode(next: NativeViewerMode): Promise<void> {
    let size: ViewerWindowSize | undefined;
    if (this.record.hyprland !== undefined && !await applyHyprlandWindowMode(this.record, next, (placed) => { size = placed; })) {
      throw new Error("Native viewer window could not be placed");
    }
    this.send({ cmd: "setMode", mode: next, ...(size === undefined ? {} : { width: size.width, height: size.height }) });
    this.mode = next;
  }

  private controlEvent(message: Record<string, unknown>): boolean {
    switch (message.event) {
      case "takeRequested":
        if (this.receivedReady && !this.ended && !this.stopped) void this.control.take();
        else this.send({ cmd: "control", state: "revoked", leaseId: "", reason: "unavailable" });
        break;
      case "returnRequested":
        if (message.reason === "button" || message.reason === "closed") {
          if (message.reason === "closed") this.requests.beginClose();
          void this.control.end("returned").catch(() => { void this.stop(); });
        }
        break;
      case "controlAck": this.control.acknowledge(message.leaseId, message.state); break;
      default: return false;
    }
    return true;
  }

  private event(message: Record<string, unknown>): void {
    if (this.controlEvent(message)) return;
    switch (message.event) {
      case "ready":
        if (!validReady(message, this.record, this.version)) this.readyReject(new Error("Native viewer readiness identity or version differs"));
        else { this.receivedReady = true; this.readyResolve(); }
        break;
      case "expandRequested": this.requestMode("expanded"); break;
      case "collapseRequested": this.requestMode("thumbnail"); break;
      case "mode":
        if (["thumbnail", "expanded", "fullscreen"].includes(String(message.mode))) this.mode = message.mode as typeof this.mode;
        break;
      case "sessionEnded": this.endSession(); break;
      case "closed": this.requests.beginClose(); void this.stop(); break;
      case "error": this.readyReject(new Error("Native viewer reported an error")); void this.stop(); break;
      default: console.error("Unknown native viewer event ignored");
    }
  }

  private requestMode(mode: NativeViewerMode): void {
    if (this.receivedReady && this.record.hyprland !== undefined) this.enqueue(() => this.setMode(mode));
  }

  private connection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
    socket.setTimeout(2_000, () => socket.destroy());
    let handled = false;
    const reply = (response: ViewerHostResponse): void => { if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`); };
    // No socket operation grants control or injects input.
    let requestId: string | undefined;
    const operations: Record<string, HostOperation> = Object.assign(Object.create(null), {
      status: watchOperation(async () => {}),
      expand: watchOperation(() => this.setMode("expanded"), true),
      collapse: watchOperation(() => this.setMode("thumbnail"), true),
      shutdown: watchOperation(async () => {}),
      requestTakeover: {
        valid: (r: Record<string, unknown>) => Object.keys(r).every((key) => ["op", "message", "timeoutMs"].includes(key)) &&
          validTakeoverMessage(r.message) && validTakeoverTimeout(r.timeoutMs),
        run: async (r: Record<string, unknown>) => { requestId = await this.requests.request(r.message as string, r.timeoutMs as number); }, serial: true,
      },
      cancelRequest: {
        valid: (r: Record<string, unknown>) => Object.keys(r).every((key) => ["op", "requestId"].includes(key)) && typeof r.requestId === "string",
        run: (r: Record<string, unknown>) => this.requests.cancel(r.requestId as string), serial: false,
      },
      subscribe: {
        valid: (r: Record<string, unknown>) => Object.keys(r).every((key) => ["op", "requestId"].includes(key)) &&
          (r.requestId === undefined || typeof r.requestId === "string" && this.requests.has(r.requestId)),
        run: async () => {}, serial: false,
      },
    });
    readViewerLines(socket, (request) => {
      if (handled) return;
      handled = true;
      if (typeof request.op !== "string") {
        reply({ ok: false, error: "invalid-request" }); return;
      }
      const operation = operations[request.op];
      if (operation === undefined) { reply({ ok: false, error: "unknown-operation" }); return; }
      if (!operation.valid(request)) { reply({ ok: false, error: "invalid-request" }); return; }
      const op = request.op;
      const run = async (): Promise<void> => {
        try {
          await operation.run(request);
          const response: ViewerHostResponse = { ok: true, host: this.host!, mode: this.mode, sessionEnded: this.ended,
            ...(requestId === undefined ? {} : { requestId }) };
          if (op === "subscribe") {
            socket.setTimeout(0);
            const id = request.requestId as string | undefined;
            const unsubscribe = this.requests.subscribe((event) => {
              if (event.requestId === id && !socket.destroyed) socket.write(`${JSON.stringify(event)}\n`);
            });
            socket.once("close", unsubscribe);
            socket.write(`${JSON.stringify({ ...response, requestState: id === undefined ? undefined : this.requests.state(id) })}\n`);
          } else reply(response);
          if (op === "shutdown") setImmediate(() => { void this.stop(); });
        } catch { reply({ ok: false, error: "operation-failed" }); }
      };
      // Status and shutdown stay responsive while a compositor move is pending.
      if (operation.serial) this.enqueue(run);
      else void run();
    }, () => reply({ ok: false, error: "invalid-request" }));
  }

  private async listen(): Promise<void> {
    await withViewerDir(this.record.sessionId, this.env, false, async (directory) => {
      const server = net.createServer((socket) => this.connection(socket));
      this.server = server;
      server.listen(directory.resolve("host.sock"));
      await once(server, "listening");
      server.on("error", () => { void this.stop(); });
      await fs.promises.chmod(directory.resolve("host.sock"), 0o600);
      const socket = await directory.lstatChild("host.sock");
      if (socket === undefined || !socket.isSocket()) throw new Error("Viewer socket unavailable");
      this.host = {
        sessionId: this.record.sessionId, launchId: this.record.launchId, version: this.version,
        pid: this.record.hostPid, startTicks: this.record.hostStartTicks,
        viewerPid: this.record.viewerPid, viewerStartTicks: this.record.viewerStartTicks,
        socket: path.join(sessionViewerDir(this.record.sessionId, this.env), "host.sock"),
        socketIno: socket.ino, socketDev: socket.dev,
      };
      await writeViewerPrivateFile(directory, "host.json", `${JSON.stringify(this.host)}\n`);
    });
  }

  private endSession(): void {
    this.ended = true;
    this.send({ cmd: "sessionEnded" });
    this.requests.beginClose();
    void this.control.end("session-ended", true).then(() => this.requests.close()).catch(() => { void this.stop(); });
  }

  private monitorSession(): void {
    let polling = false;
    this.timer = setInterval(() => {
      if (polling || this.ended || this.stopped) return;
      polling = true;
      const read = (): ReturnType<typeof getSession> => getSession(this.record.sessionId, this.env);
      void withSessionVncLock(this.record.sessionId, this.env, read, { signal: this.sessionMonitor.signal }).catch(read).then((current) => {
        if (!this.stopped && current?.status !== "running") { this.endSession(); }
      }).catch(() => {}).finally(() => { polling = false; });
    }, 500);
    this.timer.unref();
  }

  private stop(): Promise<void> {
    return this.stopping ??= (async () => {
      this.stopped = true;
      this.requests.beginClose();
      this.sessionMonitor.abort();
      if (this.timer !== undefined) clearInterval(this.timer);
      await this.control.end("stopping", true).catch(() => { if (!this.exited) this.child.kill("SIGKILL"); });
      this.requests.close();
      this.send({ cmd: "status", code: "stopping" });
      this.send({ cmd: "shutdown" });
      await Promise.race([this.exit, sleep(300)]);
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (this.exited) break;
        // The owned child and exit listener prevent PID reuse during signaling.
        this.child.kill(signal);
        await Promise.race([this.exit, sleep(700)]);
      }
      for (const socket of this.sockets) socket.destroy();
      if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    })();
  }

  async run(): Promise<number> {
    try {
      await writeViewerLaunchRecord(this.record, this.env);
      readViewerLines(this.child.stdout, (message) => this.event(message), () => {
        this.readyReject(new Error("Invalid native viewer protocol frame")); void this.stop();
      });
      void this.exit.then(() => this.readyReject(new Error("Native viewer exited before readiness")));
      const startupControl = this.options.control === true ? this.control.take(true) : undefined;
      // Handle failure while readiness is pending, then surface it after readiness.
      const startupResult = startupControl?.then(() => undefined, (error: unknown) => error);
      await this.ready;
      const startupError = await startupResult;
      if (startupError !== undefined) { console.error("Native viewer could not take control"); return 1; }
      const hyprland = this.record.hyprland;
      if (hyprland !== undefined) {
        await waitForViewerWindow(hyprland, hyprland.classPattern, this.record.viewerPid, { stopped: () => this.exited || this.stopped });
        await disableViewerRule(hyprland, hyprland.ruleName);
      }
      if (this.exited || this.stopped) throw new Error("Native viewer stopped during startup");
      await this.listen();
      this.control.viewerReady();
      this.monitorSession();
      await this.exit;
      return this.child.exitCode === 0 || this.stopped ? 0 : 1;
    } finally {
      await this.stop();
      process.off("SIGTERM", this.onSignal);
      process.off("SIGINT", this.onSignal);
    }
  }
}

export interface NativeHostOptions {
  session: string; binary: string; viewerVersion: string; control?: boolean;
  /** Test hooks use real isolated displays without spawning a CLI watchdog. */
  _takeoverOptions?: StartHumanTakeoverOptions;
  _spawnWatchdog?: SpawnWatchdogFn;
}
export async function runNativeViewerHost(options: NativeHostOptions): Promise<number> {
  const env = process.env;
  const session = await getSession(options.session, env);
  const desktop = session?.desktop;
  const target = desktop === undefined ? undefined : await verifyOwnedDisplayTarget(options.session, desktop.display, env);
  if (session?.status !== "running" || desktop === undefined || target === undefined || !path.isAbsolute(options.binary)) {
    throw new Error("Native viewer requires a verified running desktop");
  }
  const hostIdentity = readProcessIdentity(process.pid);
  if (hostIdentity === undefined) throw new Error("Viewer host identity unavailable");
  const { launchId } = await prepareViewerLaunch(options.session, env);
  const sizes = viewerWindowSizes(desktop);
  sizes.expanded.height += 32;
  let hyprland: NativeViewerLaunchRecord["hyprland"];
  const ctx = await detectHyprland(env);
  const ruleName = hyprlandRuleName(launchId);
  const classPattern = viewerClassPattern(launchId, "native");
  if (ctx !== undefined) {
    if (await installViewerRule(ctx, ruleName, classPattern, sizes.thumbnail)) hyprland = { ...ctx, ruleName, classPattern };
    else await disableViewerRule(ctx, ruleName);
  }
  try {
    const child = spawn(options.binary, [
      "--display", target.display, "--xvfb-pid", String(target.pid), "--xvfb-start-ticks", String(target.startTicks),
      "--width", String(sizes.expanded.width), "--height", String(sizes.expanded.height - 32),
      "--class", viewerWindowClass(launchId), "--thumbnail-width", "384", "--placement", hyprland === undefined ? "self" : "host",
      "--label", viewerLabel(options.session, session.projectDir),
    ], { env, shell: false, detached: false, stdio: ["pipe", "pipe", "pipe"] });
    await once(child, "spawn");
    const viewerIdentity = readProcessIdentity(child.pid!);
    if (viewerIdentity === undefined) { child.kill("SIGKILL"); throw new Error("Viewer identity unavailable"); }
    return await new NativeHost(child, {
      kind: "native", sessionId: options.session, launchId, createdAt: new Date().toISOString(), binary: options.binary,
      hostPid: hostIdentity.pid, hostStartTicks: hostIdentity.startTicks,
      viewerPid: viewerIdentity.pid, viewerStartTicks: viewerIdentity.startTicks, ...viewerIdentity, ...sizes, hyprland,
    }, options.viewerVersion, env, options).run();
  } finally {
    if (hyprland !== undefined) {
      await disableViewerRule(hyprland, ruleName);
      await disableViewerOpacityRule(hyprland, ruleName);
    }
  }
}
