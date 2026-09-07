import { createRequire } from "node:module";
import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import {
  readPickforgeEnv,
  redactSecrets,
  type EnvLike,
} from "@pickforge/lab-core";

const DSN =
  "https://25cc6307aeca0d1d454e0af21bee5498@o4511699702317056.ingest.us.sentry.io/4511699813990400";

const ENABLE_VALUES = new Set(["1", "true", "on"]);
let enabled = false;

export function telemetryEnabled(env: EnvLike = process.env): boolean {
  const value = readPickforgeEnv(env, "TELEMETRY")?.trim().toLowerCase();
  return ENABLE_VALUES.has(value ?? "");
}

export function initTelemetry(env: EnvLike = process.env): void {
  enabled = telemetryEnabled(env);
  if (!enabled) {
    return;
  }
  const require = createRequire(import.meta.url);
  const { version } = require("../package.json") as { version: string };
  Sentry.init({
    dsn: DSN,
    release: `pickforge@${version}`,
    tracesSampleRate: 0,
    defaultIntegrations: false,
    integrations: [
      Sentry.inboundFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
      Sentry.nodeContextIntegration(),
    ],
    beforeBreadcrumb: dropBreadcrumb,
    beforeSend: scrubEvent,
  });
}

export function dropBreadcrumb(): null {
  return null;
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.server_name;
  delete event.modules;
  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) {
      if (key !== "os" && key !== "runtime") {
        delete event.contexts[key];
      }
    }
  }
  if (typeof event.message === "string") {
    event.message = redactSecrets(event.message);
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) {
      exception.value = redactSecrets(exception.value);
    }
  }
  return event;
}

export async function captureFatal(err: unknown): Promise<void> {
  if (!enabled) {
    return;
  }
  Sentry.captureException(err);
  await Sentry.flush(2000);
}
