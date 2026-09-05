import {
  createAndroidSession,
  destroyAndroidSession,
  getAndroidSessionStatus,
  teardownAndroidSession,
} from "@pickforge/lab-android";
import {
  createBrowserSession,
  destroyBrowserSession,
  getBrowserSessionStatus,
  teardownBrowserSession,
} from "@pickforge/lab-browser";
import {
  createLocalSessions,
  destroyLocalSessions,
  getSession,
  listSessions,
  loadConfig,
  localSessionStatusEntry,
  reapDeadRunningSessions,
  type LocalSessionCreateRuntime,
  type LocalSessionDestroyRuntime,
  type LocalSessionRecipe,
  type LocalSessionStatusEntry,
  type LocalSessionStatusRuntime,
  type LocalSessionSummary,
  type LocalSessionTeardownRuntime,
  type SessionRecord,
} from "@pickforge/lab-core";
import {
  createDesktopSession,
  destroyDesktopSession,
  getDesktopSessionStatus,
  teardownDesktopSession,
} from "@pickforge/lab-desktop-linux";
import {
  parseIntArg,
  resolveProjectDir,
  runReported,
  type BaseCliOptions,
} from "./shared.js";
import { watchDesktopSession } from "./watch.js";

export interface SessionCreateOptions extends BaseCliOptions {
  type: LocalSessionRecipe;
  width?: string;
  height?: string;
  vnc?: boolean;
  vncControl?: boolean;
  avdName?: string;
  coldBoot?: boolean;
  readOnly?: boolean;
  viewer?: boolean;
}

function createRuntime(opts: SessionCreateOptions): LocalSessionCreateRuntime {
  const projectDir = resolveProjectDir(opts);
  return {
    desktop: {
      create: () =>
        createDesktopSession({
          projectDir,
          width:
            opts.width === undefined
              ? undefined
              : parseIntArg(opts.width, "--width"),
          height:
            opts.height === undefined
              ? undefined
              : parseIntArg(opts.height, "--height"),
          vnc: opts.vnc,
          vncControl: opts.vncControl,
        }),
      destroy: (id) => destroyDesktopSession(id),
    },
    browser: {
      create: () =>
        createBrowserSession({
          projectDir,
          width:
            opts.width === undefined
              ? undefined
              : parseIntArg(opts.width, "--width"),
          height:
            opts.height === undefined
              ? undefined
              : parseIntArg(opts.height, "--height"),
        }),
    },
    android: {
      create: async () => {
        const config = await loadConfig(projectDir);
        const avdName = opts.avdName ?? config.android?.avdName;
        return createAndroidSession({
          projectDir,
          ...(avdName === undefined ? {} : { avdName }),
          ...(opts.coldBoot === true ? { coldBoot: true } : {}),
          ...(opts.readOnly === true ? { readOnly: true } : {}),
        });
      },
    },
  };
}

const statusRuntime: LocalSessionStatusRuntime = {
  desktop: { status: (id) => getDesktopSessionStatus(id) },
  browser: { status: (id) => getBrowserSessionStatus(id) },
  android: { status: (id) => getAndroidSessionStatus(id) },
};

const destroyRuntime: LocalSessionDestroyRuntime = {
  desktop: { destroy: (id) => destroyDesktopSession(id) },
  browser: { destroy: (id) => destroyBrowserSession(id) },
  android: { destroy: (id) => destroyAndroidSession(id) },
};

const reaperRuntime: LocalSessionTeardownRuntime = {
  desktop: {
    teardown: (id, finalize) =>
      teardownDesktopSession(id, process.env, finalize),
  },
  browser: {
    teardown: (id, finalize) =>
      teardownBrowserSession(id, process.env, finalize),
  },
  android: {
    teardown: (id, finalize) =>
      teardownAndroidSession(id, process.env, {}, finalize),
  },
};

function describeCreated(summary: LocalSessionSummary): string {
  if (summary.type === "desktop") {
    const vnc =
      summary.vncPort === undefined ? "" : `, vnc port ${summary.vncPort}`;
    return `created desktop session ${summary.id} (display ${summary.display}${vnc})`;
  }
  if (summary.type === "browser") {
    return `created browser session ${summary.id} (display ${summary.display}, cdp port ${summary.cdpPort})`;
  }
  return `created android session ${summary.id} (serial ${summary.serial})`;
}

export async function runSessionCreate(
  opts: SessionCreateOptions,
): Promise<number> {
  // eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
  return runReported(opts, async () => {
    const projectDir = resolveProjectDir(opts);
    const config = await loadConfig(projectDir);
    const viewerMode = config.viewer?.mode ?? "manual";
    if (viewerMode !== "manual" && viewerMode !== "auto") {
      throw new Error(
        `Invalid viewer.mode "${String(viewerMode)}": expected "manual" or "auto"`,
      );
    }
    if (opts.viewer === true && opts.vncControl === true) {
      throw new Error(
        "--viewer cannot be combined with --vnc-control because watch is read-only",
      );
    }
    if (opts.viewer === true && opts.type === "android") {
      throw new Error("--viewer requires a desktop-capable session type");
    }
    const createsWatchable =
      opts.type === "desktop" ||
      opts.type === "desktop+android" ||
      opts.type === "browser";
    const createsWritableDesktop =
      opts.type === "desktop" || opts.type === "desktop+android";
    const autoViewerSuppressed =
      createsWritableDesktop &&
      opts.viewer === undefined &&
      viewerMode === "auto" &&
      opts.vncControl === true;
    const wantsViewer =
      createsWatchable &&
      (opts.viewer ??
        (viewerMode === "auto" &&
          (!createsWritableDesktop || opts.vncControl !== true)));

    await reapDeadRunningSessions(process.env, reaperRuntime);
    const sessions = await createLocalSessions(opts.type, createRuntime(opts));

    const lines = sessions.map(describeCreated);
    const data: Record<string, unknown> = { sessions };
    const errors: string[] = [];
    const watchable = sessions.find((session) => session.type !== "android");
    if (autoViewerSuppressed) {
      const reason =
        "viewer.mode=auto was suppressed because --vnc-control creates writable VNC";
      data.viewer = { opened: false, suppressed: true, reason };
      lines.push(reason);
    } else if (wantsViewer && watchable !== undefined) {
      try {
        const watched = await watchDesktopSession({
          session: watchable.id,
          projectDir,
          waitForViewerExit: false,
        });
        data.viewer = watched.data;
        lines.push(...(watched.lines ?? []));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const viewerError =
          `Viewer failed after creating session ${watchable.id}: ${message}`;
        data.viewer = {
          sessionId: watchable.id,
          opened: false,
          error: message,
        };
        errors.push(viewerError);
      }
    }
    return { data, lines, errors };
  });
}

function statusLine(entry: LocalSessionStatusEntry): string {
  const parts = [`${entry.id}  ${entry.type}  ${entry.status}`];
  const desktop = entry.desktop as Record<string, unknown> | undefined;
  if (desktop !== undefined) {
    parts.push(
      `display=${desktop.display}`,
      `xvfb=${desktop.xvfbAlive === true ? "alive" : "dead"}`,
    );
    if (desktop.vncPort !== undefined) {
      parts.push(`vnc=${desktop.vncAlive === true ? "alive" : "dead"}`);
    }
  }
  const browser = entry.browser as Record<string, unknown> | undefined;
  if (browser !== undefined) {
    parts.push(
      `browser=${browser.browserAlive === true ? "alive" : "dead"}`,
      `cdp=${browser.cdpPort ?? "unknown"}`,
    );
  }
  const android = entry.android as Record<string, unknown> | undefined;
  if (android !== undefined) {
    parts.push(
      `serial=${android.serial ?? "unknown"}`,
      `emulator=${android.emulatorAlive === true ? "alive" : "dead"}`,
      `device=${android.deviceState ?? "unknown"}`,
    );
  }
  return parts.join("  ");
}

export async function runSessionStatus(
  id: string | undefined,
  opts: BaseCliOptions,
): Promise<number> {
  return runReported(opts, async () => {
    let records: SessionRecord[];
    if (id !== undefined) {
      const record = await getSession(id);
      if (record === undefined) {
        throw new Error(`Session not found: ${id}`);
      }
      records = [record];
    } else {
      records = await listSessions();
    }
    const sessions: LocalSessionStatusEntry[] = [];
    for (const record of records) {
      sessions.push(await localSessionStatusEntry(record, statusRuntime));
    }
    return {
      data: { sessions },
      lines: sessions.length === 0 ? ["no sessions"] : sessions.map(statusLine),
    };
  });
}

export interface SessionDestroyOptions extends BaseCliOptions {
  all?: boolean;
}

export async function runSessionDestroy(
  id: string | undefined,
  opts: SessionDestroyOptions,
): Promise<number> {
  return runReported(opts, async () => {
    if (id !== undefined && opts.all === true) {
      throw new Error("Pass either a session id or --all, not both");
    }
    if (id === undefined && opts.all !== true) {
      throw new Error("Pass a session id or --all");
    }
    const records: SessionRecord[] = [];
    if (id !== undefined) {
      const record = await getSession(id);
      if (record === undefined) {
        throw new Error(`Session not found: ${id}`);
      }
      records.push(record);
    } else {
      records.push(...(await listSessions()));
    }
    const { destroyed, errors } = await destroyLocalSessions(
      records,
      destroyRuntime,
    );
    return {
      data: { destroyed },
      lines:
        destroyed.length === 0
          ? ["no sessions destroyed"]
          : destroyed.map((sessionId) => `destroyed session ${sessionId}`),
      errors,
    };
  });
}
