import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  back,
  clearLogcat,
  getUiTree,
  home,
  installApk,
  launchApp,
  logcat,
  maybeWaitForGuestReady,
  runAdb,
  screenshot,
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
  .positive()
  .optional()
  .describe(
    "Seconds to wait until guest lowmemorykiller is quiet before this action " +
      "(default: no wait)",
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

function registerAndroidTool9(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "android_get_ui_tree",
    {
      title: "Android UI tree",
      description:
        "Dump the current UI hierarchy as XML (uiautomator dump). Use it to " +
        "find widget bounds before tapping.",
      inputSchema: { ...targetArgs },
    },
    (args) =>
      runTool(async () => {
        const target = await resolveAndroidTarget(ctx, args);
        return withMcpEvidence(
          ctx,
          { sessionId: target.sessionId, tool: "android_get_ui_tree" },
          async () => {
            const xml = redactSecrets(
              await getUiTree({ serial: target.serial, env: ctx.env }),
            );
            return { data: { ...targetData(target), xml } };
          },
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
  registerAndroidTool6(server, ctx);
  registerAndroidTool7(server, ctx);
  registerAndroidTool8(server, ctx);
  registerAndroidTool9(server, ctx);
  registerAndroidTool10(server, ctx);
  registerAndroidTool11(server, ctx);
}
