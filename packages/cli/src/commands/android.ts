import path from "node:path";
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
import { listSessions, redactSecrets } from "@pickforge/lab-core";
import fs from "node:fs";
import {
  captureToTarget,
  parseIntArg,
  resolveScreenshotTarget,
  resolveSessionRecord,
  runReported,
  type BaseCliOptions,
  type ScreenshotTargetOptions,
} from "./shared.js";

export interface AndroidTargetOptions extends BaseCliOptions {
  session?: string;
  serial?: string;
  waitReady?: string;
}

function waitReadySecondsOf(opts: AndroidTargetOptions): number | undefined {
  if (opts.waitReady === undefined) {
    return undefined;
  }
  return parseIntArg(opts.waitReady, "--wait-ready");
}

function progressToStderr(message: string): void {
  console.error(message);
}

interface AndroidTarget {
  serial: string;
  sessionId?: string;
}

async function resolveAndroidTarget(
  opts: AndroidTargetOptions,
): Promise<AndroidTarget> {
  if (opts.serial !== undefined && opts.session !== undefined) {
    throw new Error("Pass either --session or --serial, not both");
  }
  if (opts.serial !== undefined) {
    return { serial: opts.serial };
  }
  const record = await resolveSessionRecord("android", opts);
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

export async function runAndroidInstallApk(
  apk: string,
  opts: AndroidTargetOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const target = await resolveAndroidTarget(opts);
    const apkPath = path.resolve(apk);
    const guestReady = await maybeWaitForGuestReady({
      serial: target.serial,
      waitReadySeconds: waitReadySecondsOf(opts),
      onProgress: progressToStderr,
    });
    await installApk({ serial: target.serial, apkPath });
    const data: Record<string, unknown> = { ...targetData(target), apkPath };
    if (guestReady !== undefined) {
      data.guestReady = guestReady;
    }
    return {
      data,
      lines: [`installed ${apkPath} on ${target.serial}`],
    };
  });
}

export interface AndroidLaunchAppOptions extends AndroidTargetOptions {
  activity?: string;
}

export async function runAndroidLaunchApp(
  packageName: string,
  opts: AndroidLaunchAppOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const target = await resolveAndroidTarget(opts);
    const guestReady = await maybeWaitForGuestReady({
      serial: target.serial,
      waitReadySeconds: waitReadySecondsOf(opts),
      onProgress: progressToStderr,
    });
    const launched = await launchApp({
      serial: target.serial,
      packageName,
      activity: opts.activity,
    });
    const data: Record<string, unknown> = {
      ...targetData(target),
      packageName,
      ...launched,
    };
    if (guestReady !== undefined) {
      data.guestReady = guestReady;
    }
    return {
      data,
      lines: [
        `launched ${launched.component} on ${target.serial} (pid ${launched.pid})`,
      ],
    };
  });
}

export interface AndroidScreenshotOptions
  extends AndroidTargetOptions,
    ScreenshotTargetOptions {}

export async function runAndroidScreenshot(
  opts: AndroidScreenshotOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const target = await resolveAndroidTarget(opts);
    const destination = await resolveScreenshotTarget(
      opts,
      "android",
      target.sessionId,
    );
    const data = await captureToTarget(destination, async (outPath) => {
      await screenshot({ serial: target.serial, outPath });
    });
    Object.assign(data, targetData(target));
    const lines = [`screenshot saved to ${destination.outPath}`];
    if (data.runId !== undefined) {
      lines.push(`run: ${data.runId}`);
    }
    return { data, lines };
  });
}

export async function runAndroidTap(
  x: string,
  y: string,
  opts: AndroidTargetOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const target = await resolveAndroidTarget(opts);
    const parsedX = parseIntArg(x, "x");
    const parsedY = parseIntArg(y, "y");
    await tap({ serial: target.serial, x: parsedX, y: parsedY });
    return {
      data: { ...targetData(target), x: parsedX, y: parsedY },
      lines: [`tapped (${parsedX}, ${parsedY}) on ${target.serial}`],
    };
  });
}

export async function runAndroidType(
  text: string,
  opts: AndroidTargetOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const target = await resolveAndroidTarget(opts);
    await typeText({ serial: target.serial, text });
    return {
      data: { ...targetData(target), length: text.length },
      lines: [`typed ${text.length} character(s) on ${target.serial}`],
    };
  });
}

export async function runAndroidBack(
  opts: AndroidTargetOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const target = await resolveAndroidTarget(opts);
    await back({ serial: target.serial });
    return {
      data: targetData(target),
      lines: [`pressed back on ${target.serial}`],
    };
  });
}

export async function runAndroidHome(
  opts: AndroidTargetOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const target = await resolveAndroidTarget(opts);
    await home({ serial: target.serial });
    return {
      data: targetData(target),
      lines: [`pressed home on ${target.serial}`],
    };
  });
}

export interface AndroidUiTreeOptions extends AndroidTargetOptions {
  out?: string;
}

export async function runAndroidUiTree(
  opts: AndroidUiTreeOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const target = await resolveAndroidTarget(opts);
    const xml = redactSecrets(await getUiTree({ serial: target.serial }));
    if (opts.out !== undefined) {
      const outPath = path.resolve(opts.out);
      await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
      await fs.promises.writeFile(outPath, `${xml}\n`, "utf8");
      return {
        data: { ...targetData(target), path: outPath },
        lines: [`ui tree saved to ${outPath}`],
      };
    }
    return { data: { ...targetData(target), xml }, lines: [xml] };
  });
}

export interface AndroidLogcatOptions extends AndroidTargetOptions {
  lines?: string;
  filter?: string;
  clear?: boolean;
}

export async function runAndroidLogcat(
  opts: AndroidLogcatOptions,
): Promise<number> {
  return runReported(opts, async () => {
    const target = await resolveAndroidTarget(opts);
    if (opts.clear === true) {
      await clearLogcat({ serial: target.serial });
      return {
        data: { ...targetData(target), cleared: true },
        lines: [`cleared logcat buffer on ${target.serial}`],
      };
    }
    const output = redactSecrets(
      await logcat({
        serial: target.serial,
        lines:
          opts.lines === undefined
            ? undefined
            : parseIntArg(opts.lines, "--lines"),
        filter: opts.filter,
      }),
    );
    return {
      data: { ...targetData(target), output },
      lines: [output.replace(/\n$/, "")],
    };
  });
}

// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export async function runAndroidAdb(
  args: string[],
  opts: AndroidTargetOptions,
): Promise<number> {
  try {
    let serial: string | undefined;
    let sessionId: string | undefined;
    if (opts.serial !== undefined || opts.session !== undefined) {
      ({ serial, sessionId } = await resolveAndroidTarget(opts));
    } else {
      // Fall back to a raw, untargeted adb call only when there is genuinely no
      // running android session anywhere under PICKFORGE_HOME. If this project has
      // no session but other projects do, fail closed rather than guessing a
      // device another project owns. Ambiguous (multiple-session) or any other
      // resolution failure also fails closed.
      const implicit = await resolveAndroidTarget(opts).then(
        (target) => target,
        async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.startsWith("No running android session")) {
            throw error;
          }
          const running = (await listSessions()).filter(
            (record) =>
              record.type === "android" && record.status === "running",
          );
          if (running.length > 0) {
            throw new Error(
              "No running android session for this project, but other projects " +
                "have running android sessions. Pass --session <id> or --serial " +
                "<serial>, or run the command from the project that owns the session.",
            );
          }
          return undefined;
        },
      );
      serial = implicit?.serial;
      sessionId = implicit?.sessionId;
    }
    const result = await runAdb(
      serial === undefined ? { args } : { serial, args },
    );
    if (opts.json === true) {
      const report: Record<string, unknown> = {
        ok: result.ok,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        errors: result.ok ? [] : [`adb exited with code ${result.code}`],
      };
      if (serial !== undefined) report.serial = serial;
      if (sessionId !== undefined) report.sessionId = sessionId;
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (result.stdout !== "") process.stdout.write(result.stdout);
      if (result.stderr !== "") process.stderr.write(result.stderr);
    }
    return result.ok ? 0 : (result.code ?? 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json === true) {
      console.log(JSON.stringify({ ok: false, errors: [message] }, null, 2));
    } else {
      console.error(`error: ${message}`);
    }
    return 1;
  }
}
