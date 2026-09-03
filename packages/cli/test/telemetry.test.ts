import { describe, expect, it } from "vitest";
import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import {
  captureFatal,
  dropBreadcrumb,
  initTelemetry,
  scrubEvent,
  telemetryEnabled,
} from "../src/telemetry.js";

describe("telemetryEnabled", () => {
  it("defaults to on when unset", () => {
    expect(telemetryEnabled({})).toBe(true);
  });

  it("defaults to on when trimmed-empty", () => {
    expect(telemetryEnabled({ PICKFORGE_TELEMETRY: "  " })).toBe(true);
  });

  it("defaults to on for unrelated values", () => {
    expect(telemetryEnabled({ PICKFORGE_TELEMETRY: "yes" })).toBe(true);
  });

  it("is off for '0'", () => {
    expect(telemetryEnabled({ PICKFORGE_TELEMETRY: "0" })).toBe(false);
  });

  it("is off for 'false'", () => {
    expect(telemetryEnabled({ PICKFORGE_TELEMETRY: "false" })).toBe(false);
  });

  it("is off for 'OFF' case-insensitively", () => {
    expect(telemetryEnabled({ PICKFORGE_TELEMETRY: "OFF" })).toBe(false);
  });

  it("is off for ' off ' with surrounding whitespace", () => {
    expect(telemetryEnabled({ PICKFORGE_TELEMETRY: " off " })).toBe(false);
  });
});

describe("initTelemetry", () => {
  it("does not initialize Sentry when opted out", () => {
    initTelemetry({ PICKFORGE_TELEMETRY: "0" });
    expect(Sentry.isInitialized()).toBe(false);
  });
});

describe("scrubEvent", () => {
  it("deletes server_name and modules", () => {
    const event: ErrorEvent = {
      type: undefined,
      server_name: "my-hostname",
      modules: { commander: "14.0.0" },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.server_name).toBeUndefined();
    expect(scrubbed.modules).toBeUndefined();
  });

  it("prunes contexts down to os and runtime", () => {
    const event: ErrorEvent = {
      type: undefined,
      contexts: {
        os: { name: "linux" },
        runtime: { name: "node", version: "v20" },
        device: { arch: "x64" },
        app: { app_start_time: "now" },
        culture: { locale: "en-US" },
        trace: { trace_id: "abc", span_id: "def" },
      },
    };
    const scrubbed = scrubEvent(event);
    expect(Object.keys(scrubbed.contexts ?? {}).sort()).toEqual([
      "os",
      "runtime",
    ]);
  });

  it("redacts secrets in the message and exception values", () => {
    const event: ErrorEvent = {
      type: undefined,
      message: "failed with token=ghp_0123456789012345678901234567890abcde",
      exception: {
        values: [
          { type: "Error", value: "adb failed: API_KEY=super-secret-value" },
          { type: "Error" },
        ],
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.message).not.toContain("ghp_");
    expect(scrubbed.exception?.values?.[0].value).toBe(
      "adb failed: API_KEY=[REDACTED]",
    );
    expect(scrubbed.exception?.values?.[1].value).toBeUndefined();
  });
});

describe("dropBreadcrumb", () => {
  it("always returns null", () => {
    expect(dropBreadcrumb()).toBeNull();
  });
});

describe("captureFatal", () => {
  it("resolves without throwing when Sentry is uninitialized", async () => {
    expect(Sentry.isInitialized()).toBe(false);
    await expect(captureFatal(new Error("boom"))).resolves.toBeUndefined();
  });
});
