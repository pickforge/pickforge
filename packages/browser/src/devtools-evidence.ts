import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  appendAction,
  beginEvidenceRun,
  isEvidenceEnabled,
  loadConfig,
  sanitizeActionTarget,
  sanitizeErrorText,
  sanitizeNetworkFailure,
  sanitizeTypedValue,
  type EvidenceAction,
  type AppendOutcome,
  type EnvLike,
  type RunHandle,
} from "@pickforge/lab-core";
import type { JsonRpcHook, JsonRpcMessage } from "./ndjson.js";

const MAX_PENDING_ACTIONS = 1_024;
const MAX_DIAGNOSTICS_PER_RESPONSE = 100;
const MAX_INLINE_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SUPPORTED_TOOL_NAMES: Readonly<Record<string, true>> = {
  click: true,
  click_at: true,
  close_heapsnapshot: true,
  drag: true,
  close_page: true,
  compare_heapsnapshots: true,
  evaluate: true,
  emulate: true,
  evaluate_script: true,
  execute_3p_developer_tool: true,
  execute_webmcp_tool: true,
  fill: true,
  fill_form: true,
  get_console_message: true,
  get_heapsnapshot_class_nodes: true,
  get_heapsnapshot_details: true,
  get_heapsnapshot_dominators: true,
  get_heapsnapshot_duplicate_strings: true,
  get_heapsnapshot_edges: true,
  get_heapsnapshot_retainers: true,
  get_heapsnapshot_retaining_paths: true,
  get_heapsnapshot_summary: true,
  get_network_request: true,
  get_tab_id: true,
  handle_dialog: true,
  hover: true,
  install_extension: true,
  lighthouse_audit: true,
  list_3p_developer_tools: true,
  list_console_messages: true,
  list_extensions: true,
  list_network_requests: true,
  list_pages: true,
  list_webmcp_tools: true,
  navigate_page: true,
  new_page: true,
  performance_analyze_insight: true,
  performance_start_trace: true,
  performance_stop_trace: true,
  press_key: true,
  reload_extension: true,
  resize_page: true,
  screencast_start: true,
  screencast_stop: true,
  navigate: true,
  select_page: true,
  take_heapsnapshot: true,
  take_screenshot: true,
  take_snapshot: true,
  trigger_extension_action: true,
  type_text: true,
  uninstall_extension: true,
  upload_file: true,
  wait_for: true,
  screenshot: true,
};
const NAVIGATION_TYPES: Readonly<Record<string, true>> = {
  url: true,
  back: true,
  forward: true,
  reload: true,
};
const UID_PATTERN = /^\d+_\d+$/;
const TYPED_ARGUMENT_KEYS: Readonly<Record<string, string>> = {
  fill: "value",
  type_text: "text",
  press_key: "key",
  handle_dialog: "promptText",
  evaluate_script: "function",
};

interface PendingAction {
  actionId: string;
  startedAt: Date;
  tool: string;
  target?: Record<string, unknown>;
}

export interface DevtoolsEvidenceRecorder {
  beforeForward: JsonRpcHook;
  afterResponse: JsonRpcHook;
  flushPending(status?: EvidenceAction["status"]): Promise<void>;
}

export interface CreateDevtoolsEvidenceRecorderOptions {
  projectDir: string;
  sessionId: string;
  env?: EnvLike;
  reportFailure?: (detail: string) => void;
  /** Injectable evidence cap for deterministic boundary tests. */
  maxBytes?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestId(message: JsonRpcMessage): string | number | undefined {
  return typeof message.id === "string" || typeof message.id === "number"
    ? message.id
    : undefined;
}

function toolCall(message: JsonRpcMessage): {
  id: string | number;
  name: string;
  args: Record<string, unknown>;
} | undefined {
  if (message.method !== "tools/call") return undefined;
  const id = requestId(message);
  if (id === undefined || !isObject(message.params)) return undefined;
  const name = message.params.name;
  if (typeof name !== "string" || !isObject(message.params.arguments)) {
    return undefined;
  }
  return { id, name, args: message.params.arguments };
}

function persistedToolName(name: string): string {
  return SUPPORTED_TOOL_NAMES[name] === true
    ? `chrome_devtools/${name}`
    : "chrome_devtools/unknown";
}

function typedMetadata(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const key = TYPED_ARGUMENT_KEYS[name];
  if (key !== undefined && typeof args[key] === "string") {
    return { ...sanitizeTypedValue(args[key], "other") };
  }
  if (name !== "fill_form" || !Array.isArray(args.elements)) return undefined;
  let length = 0;
  let fieldCount = 0;
  for (const element of args.elements) {
    if (!isObject(element) || typeof element.value !== "string") continue;
    length += element.value.length;
    fieldCount += 1;
  }
  return fieldCount === 0
    ? undefined
    : { length, inputType: "other", fieldCount };
}

function actionTarget(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const raw: Record<string, unknown> = {};
  if (typeof args.url === "string") raw.url = args.url;
  if (typeof args.uid === "string" && UID_PATTERN.test(args.uid)) {
    raw.selector = args.uid;
  }
  if (typeof args.x === "number") raw.x = args.x;
  if (typeof args.y === "number") raw.y = args.y;
  if (
    name === "navigate_page" &&
    typeof args.type === "string" &&
    NAVIGATION_TYPES[args.type] === true
  ) {
    raw.name = args.type;
  }
  const target: Record<string, unknown> = { ...sanitizeActionTarget(raw) };
  const typed = typedMetadata(name, args);
  if (typed !== undefined) Object.assign(target, typed);
  return Object.keys(target).length === 0 ? undefined : target;
}

function responseError(message: JsonRpcMessage): string | undefined {
  return Object.prototype.hasOwnProperty.call(message, "error") ||
    (isObject(message.result) && message.result.isError === true)
    ? "DevTools tool failed"
    : undefined;
}

function structuredContent(message: JsonRpcMessage): Record<string, unknown> | undefined {
  return isObject(message.result) && isObject(message.result.structuredContent)
    ? message.result.structuredContent
    : undefined;
}

// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
function diagnosticActions(
  message: JsonRpcMessage,
  sessionId: string,
  startedAt: string,
): EvidenceAction[] {
  const structured = structuredContent(message);
  if (structured === undefined) return [];
  const actions: EvidenceAction[] = [];
  if (Array.isArray(structured.networkRequests)) {
    for (const request of structured.networkRequests) {
      if (actions.length >= MAX_DIAGNOSTICS_PER_RESPONSE) break;
      if (!isObject(request)) continue;
      const rawStatus = request.status;
      const numericStatus =
        typeof rawStatus === "number"
          ? rawStatus
          : typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus)
            ? Number(rawStatus)
            : undefined;
      const failedWithoutStatus =
        typeof rawStatus === "string" &&
        numericStatus === undefined &&
        rawStatus !== "pending";
      const error = failedWithoutStatus
        ? /^net::[A-Z0-9_]+$/.test(rawStatus)
          ? rawStatus
          : "Network request failed"
        : undefined;
      if (
        (numericStatus === undefined || numericStatus < 400) &&
        error === undefined
      ) {
        continue;
      }
      actions.push({
        actionId: crypto.randomUUID(),
        source: "devtools",
        tool: "network_failure",
        sessionId,
        startedAt,
        status: "error",
        target: {
          ...sanitizeNetworkFailure({
            method:
              typeof request.method === "string" ? request.method : undefined,
            url: typeof request.url === "string" ? request.url : undefined,
            status: numericStatus,
            resourceType:
              typeof request.resourceType === "string"
                ? request.resourceType
                : undefined,
            durationMs:
              typeof request.durationMs === "number"
                ? request.durationMs
                : undefined,
            error,
          }),
        },
      });
    }
  }
  if (Array.isArray(structured.consoleMessages)) {
    for (const message of structured.consoleMessages) {
      if (actions.length >= MAX_DIAGNOSTICS_PER_RESPONSE) break;
      if (!isObject(message) || (message.type !== "error" && message.type !== "warning")) {
        continue;
      }
      actions.push({
        actionId: crypto.randomUUID(),
        source: "devtools",
        tool: "console_message",
        sessionId,
        startedAt,
        status: "error",
        target: { role: message.type },
        error: `Console ${message.type}`,
      });
    }
  }
  return actions;
}

interface RunIdentity {
  dev: number;
  ino: number;
}

function descriptorRoot(): string {
  if (process.platform === "linux") return "/proc/self/fd";
  if (process.platform === "darwin") return "/dev/fd";
  throw new Error(
    `Safe inline screenshot writes are unsupported on ${process.platform}`,
  );
}

async function withPinnedScreenshotDirectory<T>(
  runDir: string,
  runIdentity: RunIdentity,
  operation: (directoryPath: string) => Promise<T>,
): Promise<T> {
  const fdRoot = descriptorRoot();
  const directoryFlags =
    fs.constants.O_RDONLY |
    fs.constants.O_DIRECTORY |
    fs.constants.O_NOFOLLOW;
  const runHandle = await fs.promises.open(runDir, directoryFlags);
  try {
    const stat = await runHandle.stat();
    if (
      !stat.isDirectory() ||
      stat.dev !== runIdentity.dev ||
      stat.ino !== runIdentity.ino
    ) {
      throw new Error("Evidence run directory changed before screenshot access");
    }
    const screenshotsHandle = await fs.promises.open(
      path.join(fdRoot, String(runHandle.fd), "screenshots"),
      directoryFlags,
    );
    try {
      return await operation(
        path.join(fdRoot, String(screenshotsHandle.fd)),
      );
    } finally {
      await screenshotsHandle.close();
    }
  } finally {
    await runHandle.close();
  }
}

async function writePinnedScreenshot(
  runDir: string,
  runIdentity: RunIdentity,
  filename: string,
  bytes: Buffer,
): Promise<void> {
  await withPinnedScreenshotDirectory(
    runDir,
    runIdentity,
    async (directoryPath) => {
      await fs.promises.writeFile(path.join(directoryPath, filename), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    },
  );
}

async function removePinnedScreenshot(
  runDir: string,
  runIdentity: RunIdentity,
  filename: string,
): Promise<void> {
  await withPinnedScreenshotDirectory(
    runDir,
    runIdentity,
    async (directoryPath) => {
      await fs.promises.rm(path.join(directoryPath, filename), { force: true });
    },
  );
}

async function captureInlinePng(
  message: JsonRpcMessage,
  run: RunHandle,
  runIdentity: RunIdentity,
  actionId: string,
): Promise<string | undefined> {
  if (!isObject(message.result) || !Array.isArray(message.result.content)) {
    return undefined;
  }
  const image = message.result.content.find(
    (entry) =>
      isObject(entry) &&
      entry.type === "image" &&
      entry.mimeType === "image/png" &&
      typeof entry.data === "string",
  );
  if (!isObject(image) || typeof image.data !== "string") return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return undefined;
  const estimatedBytes = Math.floor((image.data.length * 3) / 4);
  if (estimatedBytes > MAX_INLINE_SCREENSHOT_BYTES) return undefined;
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return undefined;
  }
  const filename = `devtools-${actionId}.png`;
  await writePinnedScreenshot(run.dir, runIdentity, filename, bytes);
  return path.join("screenshots", filename);
}

// eslint-disable-next-line max-lines-per-function -- Legacy gate debt: pickforge/pickforge#60
export async function createDevtoolsEvidenceRecorder(
  opts: CreateDevtoolsEvidenceRecorderOptions,
): Promise<DevtoolsEvidenceRecorder | undefined> {
  const config = await loadConfig(opts.projectDir, opts.env);
  if (!isEvidenceEnabled(config)) return undefined;
  const { run } = await beginEvidenceRun(
    opts.projectDir,
    opts.sessionId,
    { slug: "computer-use" },
    opts.env,
  );
  const runStat = await fs.promises.lstat(run.dir);
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
    throw new Error("Evidence run directory is not a real directory");
  }
  const runIdentity: RunIdentity = { dev: runStat.dev, ino: runStat.ino };
  const pending = new Map<string | number, PendingAction>();
  const report = (error: unknown): void => {
    const detail = sanitizeErrorText(
      error instanceof Error ? error.message : String(error),
    );
    try {
      opts.reportFailure?.(detail);
    } catch {
      // Evidence diagnostics must never break the relay.
    }
  };
  const append = async (
    action: EvidenceAction,
  ): Promise<AppendOutcome | undefined> => {
    try {
      const result = await appendAction(run, action, {
        maxBytes: opts.maxBytes,
      });
      return result.outcome;
    } catch (error) {
      report(error);
      return undefined;
    }
  };

  return {
    beforeForward: async (message) => {
      try {
        const call = toolCall(message);
        if (call === undefined || pending.size >= MAX_PENDING_ACTIONS) return;
        pending.set(call.id, {
          actionId: crypto.randomUUID(),
          startedAt: new Date(),
          tool: persistedToolName(call.name),
          target: actionTarget(call.name, call.args),
        });
      } catch (error) {
        report(error);
      }
    },
    // eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
    afterResponse: async (message) => {
      try {
        const id = requestId(message);
        if (id === undefined) return;
        const action = pending.get(id);
        if (action === undefined) return;
        pending.delete(id);
        const error = responseError(message);
        const artifacts: string[] = [];
        if (
          (action.tool === "chrome_devtools/take_screenshot" ||
            action.tool === "chrome_devtools/screenshot") &&
          error === undefined
        ) {
          try {
            const screenshot = await captureInlinePng(
              message,
              run,
              runIdentity,
              action.actionId,
            );
            if (screenshot !== undefined) artifacts.push(screenshot);
          } catch (captureError) {
            report(captureError);
          }
        }
        const record: EvidenceAction = {
          actionId: action.actionId,
          source: "devtools",
          tool: action.tool,
          sessionId: opts.sessionId,
          startedAt: action.startedAt.toISOString(),
          durationMs: Date.now() - action.startedAt.getTime(),
          status: error === undefined ? "ok" : "error",
        };
        if (action.target !== undefined) record.target = action.target;
        if (artifacts.length > 0) record.artifacts = artifacts;
        if (error !== undefined) record.error = error;
        const outcome = await append(record);
        if (
          artifacts.length > 0 &&
          (outcome === "capped" || outcome === undefined)
        ) {
          for (const artifact of artifacts) {
            await removePinnedScreenshot(
              run.dir,
              runIdentity,
              path.basename(artifact),
            ).catch(report);
          }
        }
        for (const diagnostic of diagnosticActions(
          message,
          opts.sessionId,
          new Date().toISOString(),
        )) {
          await append(diagnostic);
        }
      } catch (error) {
        report(error);
      }
    },
    flushPending: async (status = "cancelled") => {
      const unfinished = [...pending.values()];
      pending.clear();
      for (const action of unfinished) {
        await append({
          actionId: action.actionId,
          source: "devtools",
          tool: action.tool,
          sessionId: opts.sessionId,
          startedAt: action.startedAt.toISOString(),
          durationMs: Date.now() - action.startedAt.getTime(),
          status,
          ...(action.target === undefined ? {} : { target: action.target }),
          error: "DevTools relay ended before the tool returned",
        });
      }
    },
  };
}
