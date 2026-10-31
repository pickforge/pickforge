import fs from "node:fs";
import path from "node:path";
import { DirHandle, processIdentityMatches } from "@pickforge/lab-core";
import { readViewerPrivateFile, writeViewerPrivateFile, VIEWER_LAUNCH_ID_PATTERN } from "@pickforge/lab-desktop-linux";
import { THUMBNAIL_MARGIN, type HyprlandContext, type Rect } from "./hyprland.js";

/**
 * Stack of collapsed native viewers on one monitor (pickforge/pickforge#497).
 *
 * Each viewer host owns one member file in a private directory per Hyprland
 * instance. There is no owner and no lock: every host reads the whole
 * directory and places only its own window with the pure {@link stackLayout},
 * so hosts that join at once converge on the same layout. A reader prunes the
 * file of a host that is gone.
 */

/** Each back card shows this much of its top: the viewer's thumbnail title strip. */
export const STACK_PEEK = 32;
/** A hover that starts this soon after the stack folded waits for the rest. */
export const FOLD_COOLDOWN_MS = 400;
/** A pointer leave folds the stack only after this delay. */
export const LEAVE_DEBOUNCE_MS = 250;
const WATCH_DEBOUNCE_MS = 10;
const WATCH_POLL_MS = 1_000;
const MEMBER_FILE = /^([0-9a-f]{32})\.json$/;
const SESSION_ID = /^(desk|andr|duo|brow)-[0-9a-f]{6,}$/;
const MEMBER_KEYS = ["launchId", "sessionId", "hostPid", "hostStartTicks", "monitor", "mode", "stackedAt", "hover", "width", "height"] as const;

export type StackMode = "thumbnail" | "away";

export interface StackMember {
  launchId: string;
  sessionId: string;
  hostPid: number;
  hostStartTicks: number;
  monitor: number;
  /** `away` while expanded or fullscreen: the card leaves the stack. */
  mode: StackMode;
  /** When the card last became the front card, as an ISO time. */
  stackedAt: string;
  hover: boolean;
  width: number;
  height: number;
}

export type StackContext = Pick<HyprlandContext, "xdgRuntimeDir" | "instance">;
export type StackUpdate = Partial<Pick<StackMember, "monitor" | "mode" | "stackedAt" | "hover" | "width" | "height">>;

/** `<XDG_RUNTIME_DIR>/pickforge/viewer-stack/<instance>`. */
export function stackDir(ctx: StackContext): string {
  return path.join(ctx.xdgRuntimeDir, "pickforge", "viewer-stack", ctx.instance);
}

function positive(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

const MEMBER_FIELDS: Record<(typeof MEMBER_KEYS)[number], (value: unknown) => boolean> = {
  launchId: (value) => typeof value === "string" && VIEWER_LAUNCH_ID_PATTERN.test(value),
  sessionId: (value) => typeof value === "string" && SESSION_ID.test(value),
  hostPid: positive,
  hostStartTicks: positive,
  monitor: (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  mode: (value) => value === "thumbnail" || value === "away",
  stackedAt: (value) => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)),
  hover: (value) => typeof value === "boolean",
  width: windowLength,
  height: windowLength,
};

function windowLength(value: unknown): boolean {
  return positive(value) && (value as number) <= 32_767;
}

/** Exactly the allowlisted keys, each valid, for the file's own launch id. */
function validMember(value: unknown, launchId: string): value is StackMember {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const member = value as Record<string, unknown>;
  const keys = Object.keys(member);
  if (keys.length !== MEMBER_KEYS.length || !MEMBER_KEYS.every((key) => keys.includes(key))) return false;
  return member.launchId === launchId && MEMBER_KEYS.every((key) => MEMBER_FIELDS[key](member[key]));
}

function assertPrivateDir(directory: DirHandle): void {
  const { stat } = directory;
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || !stat.isDirectory()) {
    throw new Error("Unsafe viewer stack directory ownership or permissions");
  }
}

/**
 * Open the stack directory, creating each missing part with mode 0700. The
 * runtime directory must belong to this user, and every part below it must
 * be a private directory of this user, never a symlink.
 */
async function withStackDir<T>(ctx: StackContext, operation: (directory: DirHandle) => Promise<T>): Promise<T> {
  const handles: DirHandle[] = [];
  try {
    const runtime = await DirHandle.open(ctx.xdgRuntimeDir, { followFinal: true });
    handles.push(runtime);
    if (runtime.stat.uid !== process.getuid?.()) throw new Error("Wrong runtime directory owner");
    let directory = runtime;
    for (const name of ["pickforge", "viewer-stack", ctx.instance]) {
      directory = await directory.ensureChildDir(name, 0o700);
      handles.push(directory);
      assertPrivateDir(directory);
    }
    return await operation(directory);
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

async function readMember(directory: DirHandle, name: string): Promise<StackMember | undefined> {
  const launchId = MEMBER_FILE.exec(name)?.[1];
  if (launchId === undefined || !VIEWER_LAUNCH_ID_PATTERN.test(launchId)) return undefined;
  let value: unknown;
  try {
    const text = await readViewerPrivateFile(directory, name);
    if (text === undefined) return undefined;
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!validMember(value, launchId)) return undefined;
  if (!processIdentityMatches({ pid: value.hostPid, startTicks: value.hostStartTicks })) {
    await directory.unlinkChild(name).catch(() => {});
    return undefined;
  }
  return value;
}

/** Live members of the stack. Invalid files are skipped and dead hosts' files removed. */
export async function readStack(ctx: StackContext): Promise<StackMember[]> {
  return withStackDir(ctx, async (directory) => {
    const members: StackMember[] = [];
    for (const name of await directory.readEntryNames()) {
      // Temporary files of an atomic write start with a dot.
      if (name.startsWith(".")) continue;
      const member = await readMember(directory, name);
      if (member !== undefined) members.push(member);
    }
    return members;
  });
}

/**
 * Call `onChange` after the stack directory changes. A 1 s poll also runs,
 * because a host that dies leaves its file unchanged and fs.watch can miss
 * events. Returns a function that stops watching.
 */
export function watchStack(ctx: StackContext, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const fire = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; if (!stopped) onChange(); }, WATCH_DEBOUNCE_MS);
    timer.unref();
  };
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(stackDir(ctx), { persistent: false }, fire);
    watcher.on("error", () => { watcher?.close(); watcher = undefined; });
  } catch {
    watcher = undefined;
  }
  const poll = setInterval(fire, WATCH_POLL_MS);
  poll.unref();
  return () => {
    stopped = true;
    watcher?.close();
    clearInterval(poll);
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** One host's member file. Writes are serialized, and nothing is written after leave. */
export class StackMembership {
  private member?: StackMember;
  private left = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: StackContext) {}

  get current(): StackMember | undefined {
    return this.member;
  }

  join(member: StackMember): Promise<void> {
    if (!VIEWER_LAUNCH_ID_PATTERN.test(member.launchId)) return Promise.reject(new Error("Invalid launch id"));
    this.member = { ...member };
    return this.write();
  }

  update(patch: StackUpdate): Promise<void> {
    if (this.member === undefined || this.left) return Promise.resolve();
    this.member = { ...this.member, ...patch };
    return this.write();
  }

  leave(): Promise<void> {
    if (this.left) return this.writes;
    this.left = true;
    const member = this.member;
    if (member === undefined) return this.writes;
    return this.chain(() => withStackDir(this.ctx, async (directory) => { await directory.unlinkChild(`${member.launchId}.json`); }));
  }

  read(): Promise<StackMember[]> {
    return readStack(this.ctx);
  }

  watch(onChange: () => void): () => void {
    return watchStack(this.ctx, onChange);
  }

  private write(): Promise<void> {
    return this.chain(async () => {
      const member = this.member;
      if (member === undefined || this.left) return;
      // Only the allowlisted keys reach the file, in a fixed order.
      const body = Object.fromEntries(MEMBER_KEYS.map((key) => [key, member[key]]));
      await withStackDir(this.ctx, (directory) => writeViewerPrivateFile(directory, `${member.launchId}.json`, `${JSON.stringify(body)}\n`));
    });
  }

  private chain(operation: () => Promise<void>): Promise<void> {
    const next = this.writes.then(operation);
    this.writes = next.catch(() => {});
    return next;
  }
}

function frontFirst(a: StackMember, b: StackMember): number {
  const time = Date.parse(b.stackedAt) - Date.parse(a.stackedAt);
  if (time !== 0) return time;
  return a.launchId < b.launchId ? -1 : a.launchId > b.launchId ? 1 : 0;
}

/** Collapsed members on the monitor of `self`, front card first. */
export function stackCards(members: readonly StackMember[], self: StackMember): StackMember[] {
  return members.filter((member) => member.monitor === self.monitor && member.mode === "thumbnail").sort(frontFirst);
}

/** Whether the stack on the monitor of `self` is fanned out. */
export function stackFanned(members: readonly StackMember[], self: StackMember): boolean {
  return stackCards(members, self).some((member) => member.hover);
}

/**
 * Where this host's card goes, or undefined when it is not in the stack.
 *
 * The front card sits in the thumbnail corner of `area`. Collapsed, each back
 * card sits {@link STACK_PEEK} higher than the card in front, so only its
 * title strip shows, and never ends below the front card. Fanned, each card
 * sits right above the card in front, without a gap, so a pointer on any
 * collapsed strip stays on a card; when that runs past the top margin, the
 * cards share the space uniformly, at least {@link STACK_PEEK} apart. The
 * front card never moves. Cards align to the right margin.
 */
export function stackLayout(members: readonly StackMember[], selfLaunchId: string, area: Rect): Rect | undefined {
  const self = members.find((member) => member.launchId === selfLaunchId);
  if (self === undefined || self.mode !== "thumbnail") return undefined;
  const cards = stackCards(members, self);
  const index = cards.indexOf(self);
  const top0 = area.y + area.height - cards[0]!.height - THUMBNAIL_MARGIN;
  const tops = [top0];
  if (stackFanned(members, self)) {
    for (let k = 1; k < cards.length; k++) tops.push(tops[k - 1]! - cards[k]!.height);
    if (tops.at(-1)! < area.y + THUMBNAIL_MARGIN) {
      const spacing = Math.max(STACK_PEEK, Math.floor((top0 - area.y - THUMBNAIL_MARGIN) / (cards.length - 1)));
      for (let k = 1; k < cards.length; k++) tops[k] = top0 - k * spacing;
    }
  } else {
    const bottom = top0 + cards[0]!.height;
    for (let k = 1; k < cards.length; k++) tops.push(Math.min(tops[k - 1]! - STACK_PEEK, bottom - cards[k]!.height));
  }
  return { x: area.x + area.width - self.width - THUMBNAIL_MARGIN, y: tops[index]!, width: self.width, height: self.height };
}
