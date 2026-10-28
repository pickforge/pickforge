import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  back,
  clearLogcat,
  compactUiTree,
  DEFAULT_COMPACT_MAX_CHARS,
  DEFAULT_RAW_MAX_CHARS,
  getScreenDensity,
  getUiTree,
  home,
  installApk,
  launchApp,
  limitRawUiTree,
  logcat,
  MAX_UI_TREE_MAX_CHARS,
  maybeWaitForGuestReady,
  MIN_UI_TREE_MAX_CHARS,
  runAdb,
  MAX_SWIPE_COORDINATE,
  MAX_SWIPE_DURATION_MS,
  screenshot,
  swipe,
  tap,
  typeText,
} from "@pickforge/lab-android";
import { redactSecrets } from "@pickforge/lab-core";
import {
  captureRunArtifact,
  captureToTarget,
  imageContent,
  resolveScreenshotTarget,
  resolveSessionRecord,
  runTool,
  type ServerContext,
  type ToolReport,
} from "../context.js";
import { withMcpEvidence } from "../evidence.js";
import {
  createSessions,
  progressReporter,
  recordCreatedSessionsEvidence,
} from "./session.js";

const targetArgs = {
  session: z
    .string()
    .min(1)
    .optional()
    .describe("Android session id (default: the single running session)"),
  serial: z
    .string()
    .min(1)
    .optional()
    .describe("Explicit adb device serial instead of a session"),
};

interface AndroidTarget {
  serial: string;
  sessionId?: string;
}

async function resolveAndroidTarget(
  ctx: ServerContext,
  args: { session?: string; serial?: string },
): Promise<AndroidTarget> {
  if (args.serial !== undefined && args.session !== undefined) {
    throw new Error('Pass either "session" or "serial", not both');
  }
  if (args.serial !== undefined) {
    return { serial: args.serial };
  }
  const record = await resolveSessionRecord(ctx, "android", args.session);
  const serial = record.android?.serial;
  if (serial === undefined) {
    throw new Error(`Session ${record.id} has no device serial recorded`);
  }
  return { serial, sessionId: record.id };
}

function targetData(target: AndroidTarget): Record<string, unknown> {
  const data: Record<string, unknown> = { serial: target.serial };
  if (target.sessionId !== undefined) {
    data.sessionId = target.sessionId;
  }
  return data;
}

const waitReadySecondsArg = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    "Seconds to wait until guest lowmemorykiller is quiet before this action " +
      "(0 or omitted: no wait)",
  );

async function waitReadyIfRequested(
  target: AndroidTarget,
  ctx: ServerContext,
  waitReadySeconds: number | undefined,
  extra: Parameters<typeof progressReporter>[0],
): Promise<Record<string, unknown>> {
  const guestReady = await maybeWaitForGuestReady({
    serial: target.serial,
    env: ctx.env,
    waitReadySeconds,
    onProgress: progressReporter(extra),
    signal: extra.mcpReq.signal,
  });
  return guestReady === undefined ? {} : { guestReady };
}

function registerAndroidTool1(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_start",
    {
      title: "Start Android session",
      description:
        "Start an Android emulator session (boots the dedicated Pickforge AVD).",
      inputSchema: {
        avdName: z.string().min(1).optional().describe("Android AVD name"),
        coldBoot: z
          .boolean()
          .optional()
          .describe("Skip the AVD's saved state (emulator -no-snapshot-load)"),
        readOnly: z
          .boolean()
          .optional()
          .describe(
            "Share the AVD with another running emulator (emulator -read-only)",
          ),
      },
    },
    (args, extra) =>
      runTool(async () => {
        const sessions = await createSessions(
          ctx,
          {
            type: "android",
            avdName: args.avdName,
            coldBoot: args.coldBoot,
            readOnly: args.readOnly,
          },
          {
            onProgress: progressReporter(extra),
            signal: extra.mcpReq.signal,
          }
        );
        await recordCreatedSessionsEvidence(ctx, sessions, "android_start");
        return { data: { sessions } };
      }),
  );
}

function registerAndroidTool2(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_install_apk",
    {
      title: "Install APK",
      description:
        "Install an APK on the device (path relative to the project dir).",
      inputSchema: {
        ...targetArgs,
        apkPath: z.string().min(1).describe("Path to the APK"),
        waitReadySeconds: waitReadySecondsArg,
      },
    },
    (args, extra) =>
      runTool(async () => {
        const target = await resolveAndroidTarget(ctx, args);
        const apkPath = path.resolve(ctx.projectDir, args.apkPath);
        return withMcpEvidence(
          ctx,
          {
            sessionId: target.sessionId,
            tool: "android_install_apk",
            target: { name: path.basename(apkPath) },
          },
          async () => {
            const ready = await waitReadyIfRequested(
              target,
              ctx,
              args.waitReadySeconds,
              extra,
            );
            await installApk({ serial: target.serial, apkPath, env: ctx.env });
            return { data: { ...targetData(target), apkPath, ...ready } };
          },
        );
      }),
  );
}

function registerAndroidTool3(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_launch_app",
    {
      title: "Launch Android app",
      description: "Launch an installed app by package name.",
      inputSchema: {
        ...targetArgs,
        packageName: z
          .string()
          .min(1)
          .describe('Application package name, e.g. "com.example.app"'),
        activity: z
          .string()
          .min(1)
          .optional()
          .describe('Activity to start, e.g. ".MainActivity"'),
        waitReadySeconds: waitReadySecondsArg,
      },
    },
    (args, extra) =>
      runTool(async () => {
        const target = await resolveAndroidTarget(ctx, args);
        return withMcpEvidence(
          ctx,
          {
            sessionId: target.sessionId,
            tool: "android_launch_app",
            target: { name: args.packageName },
          },
          async () => {
            const ready = await waitReadyIfRequested(
              target,
              ctx,
              args.waitReadySeconds,
              extra,
            );
            const launched = await launchApp({
              serial: target.serial,
              packageName: args.packageName,
              activity: args.activity,
              env: ctx.env,
            });
            return {
              data: {
                ...targetData(target),
                packageName: args.packageName,
                ...launched,
                ...ready,
              },
            };
          },
        );
      }),
  );
}

function registerAndroidTool4(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_screenshot",
    {
      title: "Android screenshot",
      description:
        "Capture the device screen as PNG. By default the image joins the " +
        "session's active evidence run, or creates a one-shot run when evidence " +
        "is disabled or no session is selected. Small images return inline.",
      inputSchema: {
        ...targetArgs,
        out: z
          .string()
          .min(1)
          .optional()
          .describe("Explicit output path instead of a run artifact"),
        runSlug: z
          .string()
          .min(1)
          .optional()
          .describe('Run slug (default "android")'),
      },
    },
    (args) =>
      runTool(async () => {
        const target = await resolveAndroidTarget(ctx, args);
        return withMcpEvidence(
          ctx,
          {
            sessionId: target.sessionId,
            tool: "android_screenshot",
            artifacts: (result) =>
              typeof result.data?.path === "string" ? [result.data.path] : [],
          },
          async ({ actionId, run }) => {
            const capture = async (outPath: string): Promise<void> => {
              await screenshot({
                serial: target.serial,
                outPath,
                env: ctx.env,
              });
            };
            const intoEvidenceRun =
              run !== undefined &&
              args.out === undefined &&
              args.runSlug === undefined;
            let data: Record<string, unknown>;
            let outPath: string;
            if (intoEvidenceRun && run !== undefined) {
              // Bound to the evidence run's verified directory. `captureToTarget`
              // is not used here because it finalizes its run, and the evidence
              // run stays open for later actions.
              outPath = await captureRunArtifact(
                run,
                "screenshots",
                `${actionId}.png`,
                capture,
              );
              data = { path: outPath, runId: run.runId, runDir: run.dir };
            } else {
              const destination = await resolveScreenshotTarget(
                ctx,
                args,
                "android",
                target.sessionId,
              );
              data = await captureToTarget(destination, capture);
              outPath = destination.outPath;
            }
            Object.assign(data, targetData(target));
            const image = await imageContent(outPath);
            Object.assign(data, image.meta);
            return { data, extraContent: image.content };
          },
        );
      }),
  );
}

function registerAndroidTool5(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_tap",
    {
      title: "Android tap",
      description: "Tap at the given screen coordinates.",
      inputSchema: {
        ...targetArgs,
        x: z.number().int().nonnegative().describe("X coordinate"),
        y: z.number().int().nonnegative().describe("Y coordinate"),
      },
    },
    (args) =>
      runTool(async () => {
        const target = await resolveAndroidTarget(ctx, args);
        return withMcpEvidence(
          ctx,
          {
            sessionId: target.sessionId,
            tool: "android_tap",
            target: { x: args.x, y: args.y },
          },
          async () => {
            await tap({
              serial: target.serial,
              x: args.x,
              y: args.y,
              env: ctx.env,
            });
            return { data: { ...targetData(target), x: args.x, y: args.y } };
          },
        );
      }),
  );
}

const swipeCoordinate = (label: string) =>
  z.number().int().min(0).max(MAX_SWIPE_COORDINATE).describe(label);

function registerAndroidSwipe(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_swipe",
    {
      title: "Android swipe",
      description:
        "Swipe from (fromX, fromY) to (toX, toY) in screen pixels, for " +
        "example to scroll a list or dismiss a sheet. The same start and end " +
        "with a duration is a long press.",
      inputSchema: {
        ...targetArgs,
        fromX: swipeCoordinate("Start X coordinate"),
        fromY: swipeCoordinate("Start Y coordinate"),
        toX: swipeCoordinate("End X coordinate"),
        toY: swipeCoordinate("End Y coordinate"),
        durationMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_SWIPE_DURATION_MS)
          .optional()
          .describe("Gesture duration in milliseconds (device default 300)"),
      },
    },
    (args) =>
      runTool(async () => {
        const target = await resolveAndroidTarget(ctx, args);
        const gesture = {
          fromX: args.fromX,
          fromY: args.fromY,
          toX: args.toX,
          toY: args.toY,
          ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
        };
        return withMcpEvidence(
          ctx,
          {
            sessionId: target.sessionId,
            tool: "android_swipe",
            target: { fromX: args.fromX, fromY: args.fromY, x: args.toX, y: args.toY },
          },
          async () => {
            await swipe({ serial: target.serial, env: ctx.env, ...gesture });
            return { data: { ...targetData(target), ...gesture } };
          },
        );
      }),
  );
}

function registerAndroidTool6(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_type",
    {
      title: "Android type",
      description: "Type ASCII text into the focused field.",
      inputSchema: {
        ...targetArgs,
        text: z.string().min(1).describe("Text to type"),
      },
    },
    (args) =>
      runTool(async () => {
        const target = await resolveAndroidTarget(ctx, args);
        return withMcpEvidence(
          ctx,
          {
            sessionId: target.sessionId,
            tool: "android_type",
            typedValue: { value: args.text, inputType: "text" },
          },
          async () => {
            await typeText({
              serial: target.serial,
              text: args.text,
              env: ctx.env,
            });
            return { data: { ...targetData(target), length: args.text.length } };
          },
        );
      }),
  );
}

function registerAndroidTool7(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_back",
    {
      title: "Android back",
      description: "Press the back button.",
      inputSchema: { ...targetArgs },
    },
    (args) =>
      runTool(async () => {
        const target = await resolveAndroidTarget(ctx, args);
        return withMcpEvidence(
          ctx,
          { sessionId: target.sessionId, tool: "android_back" },
          async () => {
            await back({ serial: target.serial, env: ctx.env });
            return { data: targetData(target) };
          },
        );
      }),
  );
}

function registerAndroidTool8(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_home",
    {
      title: "Android home",
      description: "Press the home button.",
      inputSchema: { ...targetArgs },
    },
    (args) =>
      runTool(async () => {
        const target = await resolveAndroidTarget(ctx, args);
        return withMcpEvidence(
          ctx,
          { sessionId: target.sessionId, tool: "android_home" },
          async () => {
            await home({ serial: target.serial, env: ctx.env });
            return { data: targetData(target) };
          },
        );
      }),
  );
}

async function readUiTree(
  target: AndroidTarget,
  ctx: ServerContext,
  args: { raw?: boolean; maxChars?: number },
): Promise<ToolReport> {
  const xml = await getUiTree({ serial: target.serial, env: ctx.env });
  const density = await getScreenDensity({ serial: target.serial, env: ctx.env });
  if (args.raw === true) {
    const limited = limitRawUiTree(redactSecrets(xml), args.maxChars);
    return {
      data: { ...targetData(target), format: "raw", density, ...limited },
    };
  }
  // Compact from the unredacted XML: redaction rewrites attributes such as
  // password="false". Each output line is redacted instead.
  const { tree, ...compact } = compactUiTree(xml, {
    maxChars: args.maxChars,
    redact: redactSecrets,
  });
  return {
    data: { ...targetData(target), format: "compact", density, ...compact },
    extraContent: [{ type: "text", text: tree }],
  };
}

function registerAndroidTool9(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_get_ui_tree",
    {
      title: "Android UI tree",
      description:
        "Read the current UI hierarchy (uiautomator dump). By default a " +
        "compact tree follows the JSON summary: one line per node with text, " +
        "a label (desc), a resource id or an action, indented under its kept " +
        "ancestors. Bounds are [left,top][right,bottom] in device pixels, " +
        "ready for android_tap; dp = px * 160 / density. Pass raw=true for " +
        "the full XML. Output over maxChars is cut and marked truncated.",
      inputSchema: {
        ...targetArgs,
        raw: z
          .boolean()
          .optional()
          .describe("Return the full uiautomator XML instead of the compact tree"),
        maxChars: z
          .number()
          .int()
          .min(MIN_UI_TREE_MAX_CHARS)
          .max(MAX_UI_TREE_MAX_CHARS)
          .optional()
          .describe(
            `Output size limit in characters (default ${DEFAULT_COMPACT_MAX_CHARS}, ` +
              `raw ${DEFAULT_RAW_MAX_CHARS})`,
          ),
      },
    },
    (args) =>
      runTool(async () => {
        const target = await resolveAndroidTarget(ctx, args);
        return withMcpEvidence(
          ctx,
          { sessionId: target.sessionId, tool: "android_get_ui_tree" },
          () => readUiTree(target, ctx, args),
        );
      }),
  );
}

function registerAndroidTool10(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_logcat",
    {
      title: "Android logcat",
      description:
        "Dump recent device log lines with secrets redacted, or clear the " +
        "log buffer with clear=true.",
      inputSchema: {
        ...targetArgs,
        lines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Number of recent lines (default 500)"),
        filter: z
          .string()
          .min(1)
          .optional()
          .describe('Logcat filter spec, e.g. "ActivityManager:I *:S"'),
        clear: z
          .boolean()
          .optional()
          .describe("Clear the log buffer instead of dumping it"),
      },
    },
    (args) =>
      runTool(async () => {
        const target = await resolveAndroidTarget(ctx, args);
        return withMcpEvidence(
          ctx,
          {
            sessionId: target.sessionId,
            tool: "android_logcat",
            target: args.filter === undefined ? undefined : { name: args.filter },
          },
          async () => {
            if (args.clear === true) {
              await clearLogcat({ serial: target.serial, env: ctx.env });
              return { data: { ...targetData(target), cleared: true } };
            }
            const output = redactSecrets(
              await logcat({
                serial: target.serial,
                lines: args.lines,
                filter: args.filter,
                env: ctx.env,
              }),
            );
            return { data: { ...targetData(target), output } };
          },
        );
      }),
  );
}

function registerAndroidTool11(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_run_adb",
    {
      title: "Run adb command",
      description:
        "Run a raw adb command as an argument array. Output is redacted; " +
        "use the pickforge-lab CLI for unredacted adb access.",
      inputSchema: {
        ...targetArgs,
        args: z
          .array(z.string())
          .min(1)
          .describe('adb arguments, e.g. ["shell", "pm", "list", "packages"]'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Command timeout in milliseconds"),
      },
    },
    (args) =>
      runTool(async () => {
        let target: AndroidTarget | undefined;
        if (args.serial !== undefined || args.session !== undefined) {
          target = await resolveAndroidTarget(ctx, args);
        } else {
          try {
            target = await resolveAndroidTarget(ctx, args);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (!message.startsWith("No running android session")) {
              throw error;
            }
            target = undefined;
          }
        }
        return withMcpEvidence(
          ctx,
          {
            sessionId: target?.sessionId,
            tool: "android_run_adb",
            target: { name: args.args[0] },
          },
          async () => {
            const result = await runAdb({
              args: args.args,
              serial: target?.serial,
              env: ctx.env,
              timeoutMs: args.timeoutMs,
            });
            const data: Record<string, unknown> = {
              ...(target === undefined ? {} : targetData(target)),
              code: result.code,
              stdout: redactSecrets(result.stdout),
              stderr: redactSecrets(result.stderr),
            };
            return {
              data,
              errors: result.ok ? [] : [`adb exited with code ${result.code}`],
            };
          },
        );
      }),
  );
}

export function registerAndroidTools(server: McpServer, ctx: ServerContext): void {
  registerAndroidTool1(server, ctx);
  registerAndroidTool2(server, ctx);
  registerAndroidTool3(server, ctx);
  registerAndroidTool4(server, ctx);
  registerAndroidTool5(server, ctx);
  registerAndroidSwipe(server, ctx);
  registerAndroidTool6(server, ctx);
  registerAndroidTool7(server, ctx);
  registerAndroidTool8(server, ctx);
  registerAndroidTool9(server, ctx);
  registerAndroidTool10(server, ctx);
  registerAndroidTool11(server, ctx);
}
