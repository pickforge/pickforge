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

function numericNetworkStatus(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
}

function networkError(
  rawStatus: unknown,
  numericStatus: number | undefined,
): string | undefined {
  if (
    typeof rawStatus !== "string" ||
    numericStatus !== undefined ||
    rawStatus === "pending"
  ) {
    return undefined;
  }
  return /^net::[A-Z0-9_]+$/.test(rawStatus)
    ? rawStatus
    : "Network request failed";
}

function networkDiagnostic(
  request: Record<string, unknown>,
  sessionId: string,
  startedAt: string,
): EvidenceAction | undefined {
  const status = numericNetworkStatus(request.status);
  const error = networkError(request.status, status);
  if ((status === undefined || status < 400) && error === undefined) {
    return undefined;
  }
  return {
    actionId: crypto.randomUUID(),
    source: "devtools",
    tool: "network_failure",
    sessionId,
    startedAt,
    status: "error",
    target: {
      ...sanitizeNetworkFailure({
        method: typeof request.method === "string" ? request.method : undefined,
        url: typeof request.url === "string" ? request.url : undefined,
        status,
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
  };
}

function addNetworkDiagnostics(
  actions: EvidenceAction[],
  requests: unknown,
  sessionId: string,
  startedAt: string,
): void {
  if (!Array.isArray(requests)) return;
  for (const request of requests) {
    if (actions.length >= MAX_DIAGNOSTICS_PER_RESPONSE) return;
    if (!isObject(request)) continue;
    const action = networkDiagnostic(request, sessionId, startedAt);
    if (action !== undefined) actions.push(action);
  }
}

function consoleDiagnostic(
  message: unknown,
  sessionId: string,
  startedAt: string,
): EvidenceAction | undefined {
  if (
    !isObject(message) ||
    (message.type !== "error" && message.type !== "warning")
  ) {
    return undefined;
  }
  return {
    actionId: crypto.randomUUID(),
    source: "devtools",
    tool: "console_message",
    sessionId,
    startedAt,
    status: "error",
    target: { role: message.type },
    error: `Console ${message.type}`,
  };
}

function addConsoleDiagnostics(
  actions: EvidenceAction[],
  messages: unknown,
  sessionId: string,
  startedAt: string,
): void {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (actions.length >= MAX_DIAGNOSTICS_PER_RESPONSE) return;
    const action = consoleDiagnostic(message, sessionId, startedAt);
    if (action !== undefined) actions.push(action);
  }
}

function diagnosticActions(
  message: JsonRpcMessage,
  sessionId: string,
  startedAt: string,
): EvidenceAction[] {
  const structured = structuredContent(message);
  if (structured === undefined) return [];
  const actions: EvidenceAction[] = [];
  addNetworkDiagnostics(actions, structured.networkRequests, sessionId, startedAt);
  addConsoleDiagnostics(actions, structured.consoleMessages, sessionId, startedAt);
  return actions;
}

async function captureInlinePng(
  message: JsonRpcMessage,
  run: RunHandle,
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
  await run.captureArtifact("screenshots", filename, async (outPath) => {
    await fs.promises.writeFile(outPath, bytes, { flag: "wx", mode: 0o600 });
  });
  return path.join("screenshots", filename);
}

function removeInlineScreenshot(
  run: RunHandle,
  artifact: string,
): Promise<boolean> {
  return run.removeArtifact("screenshots", path.basename(artifact));
}

interface RecorderContext {
  opts: CreateDevtoolsEvidenceRecorderOptions;
  run: RunHandle;
  pending: Map<string | number, PendingAction>;
}

function reportRecorderFailure(ctx: RecorderContext, error: unknown): void {
  const detail = sanitizeErrorText(
    error instanceof Error ? error.message : String(error),
  );
  try {
    ctx.opts.reportFailure?.(detail);
  } catch {
    // Evidence diagnostics must never break the relay.
  }
}

async function appendRecorderAction(
  ctx: RecorderContext,
  action: EvidenceAction,
): Promise<AppendOutcome | undefined> {
  try {
    return (
      await appendAction(ctx.run, action, { maxBytes: ctx.opts.maxBytes })
    ).outcome;
  } catch (error) {
    reportRecorderFailure(ctx, error);
    return undefined;
  }
}

function pendingAction(call: NonNullable<ReturnType<typeof toolCall>>): PendingAction {
  return {
    actionId: crypto.randomUUID(),
    startedAt: new Date(),
    tool: persistedToolName(call.name),
    target: actionTarget(call.name, call.args),
  };
}

async function beforeForward(
  ctx: RecorderContext,
  message: JsonRpcMessage,
): Promise<void> {
  try {
    const call = toolCall(message);
    if (call === undefined || ctx.pending.size >= MAX_PENDING_ACTIONS) return;
    ctx.pending.set(call.id, pendingAction(call));
  } catch (error) {
    reportRecorderFailure(ctx, error);
  }
}

function takePendingAction(
  ctx: RecorderContext,
  message: JsonRpcMessage,
): PendingAction | undefined {
  const id = requestId(message);
  if (id === undefined) return undefined;
  const action = ctx.pending.get(id);
  if (action !== undefined) ctx.pending.delete(id);
  return action;
}

function isScreenshotAction(action: PendingAction): boolean {
  return (
    action.tool === "chrome_devtools/take_screenshot" ||
    action.tool === "chrome_devtools/screenshot"
  );
}

async function responseArtifacts(
  ctx: RecorderContext,
  message: JsonRpcMessage,
  action: PendingAction,
  error: string | undefined,
): Promise<string[]> {
  if (!isScreenshotAction(action) || error !== undefined) return [];
  try {
    const screenshot = await captureInlinePng(
      message,
      ctx.run,
      action.actionId,
    );
    return screenshot === undefined ? [] : [screenshot];
  } catch (captureError) {
    reportRecorderFailure(ctx, captureError);
    return [];
  }
}

function responseActionRecord(
  ctx: RecorderContext,
  action: PendingAction,
  artifacts: string[],
  error: string | undefined,
): EvidenceAction {
  const record: EvidenceAction = {
    actionId: action.actionId,
    source: "devtools",
    tool: action.tool,
    sessionId: ctx.opts.sessionId,
    startedAt: action.startedAt.toISOString(),
    durationMs: Date.now() - action.startedAt.getTime(),
    status: error === undefined ? "ok" : "error",
  };
  if (action.target !== undefined) record.target = action.target;
  if (artifacts.length > 0) record.artifacts = artifacts;
  if (error !== undefined) record.error = error;
  return record;
}

async function removeRejectedArtifacts(
  ctx: RecorderContext,
  artifacts: string[],
  outcome: AppendOutcome | undefined,
): Promise<void> {
  if (outcome !== "capped" && outcome !== undefined) return;
  for (const artifact of artifacts) {
    await removeInlineScreenshot(ctx.run, artifact).catch((error) =>
      reportRecorderFailure(ctx, error),
    );
  }
}

async function appendResponseDiagnostics(
  ctx: RecorderContext,
  message: JsonRpcMessage,
): Promise<void> {
  const diagnostics = diagnosticActions(
    message,
    ctx.opts.sessionId,
    new Date().toISOString(),
  );
  for (const diagnostic of diagnostics) {
    await appendRecorderAction(ctx, diagnostic);
  }
}

async function recordResponse(
  ctx: RecorderContext,
  message: JsonRpcMessage,
  action: PendingAction,
): Promise<void> {
  const error = responseError(message);
  const artifacts = await responseArtifacts(ctx, message, action, error);
  const record = responseActionRecord(ctx, action, artifacts, error);
  const outcome = await appendRecorderAction(ctx, record);
  await removeRejectedArtifacts(ctx, artifacts, outcome);
  await appendResponseDiagnostics(ctx, message);
}

async function afterResponse(
  ctx: RecorderContext,
  message: JsonRpcMessage,
): Promise<void> {
  try {
    const action = takePendingAction(ctx, message);
    if (action === undefined) return;
    await recordResponse(ctx, message, action);
  } catch (error) {
    reportRecorderFailure(ctx, error);
  }
}

async function flushPending(
  ctx: RecorderContext,
  status: EvidenceAction["status"],
): Promise<void> {
  const unfinished = [...ctx.pending.values()];
  ctx.pending.clear();
  for (const action of unfinished) {
    await appendRecorderAction(ctx, {
      actionId: action.actionId,
      source: "devtools",
      tool: action.tool,
      sessionId: ctx.opts.sessionId,
      startedAt: action.startedAt.toISOString(),
      durationMs: Date.now() - action.startedAt.getTime(),
      status,
      ...(action.target === undefined ? {} : { target: action.target }),
      error: "DevTools relay ended before the tool returned",
    });
  }
}

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
  const ctx: RecorderContext = { opts, run, pending: new Map() };
  return {
    beforeForward: (message) => beforeForward(ctx, message),
    afterResponse: (message) => afterResponse(ctx, message),
    flushPending: (status = "cancelled") => flushPending(ctx, status),
  };
}
