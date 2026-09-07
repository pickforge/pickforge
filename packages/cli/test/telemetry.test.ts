import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import {
  captureFatal,
  dropBreadcrumb,
  initTelemetry,
  scrubEvent,
  telemetryEnabled,
} from "../src/telemetry.js";

vi.mock("@sentry/node", async (importOriginal) => ({
  ...await importOriginal<typeof Sentry>(),
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
  vi.clearAllMocks();
  initTelemetry({});
});

describe("telemetry opt-in", () => {
  it.each([undefined, "", "  ", "0", "false", "off", "OFF", " off ", "yes", "2", "enabled"])(
    "does not initialize or report for %s", async (value) => {
      const env = { PICKFORGE_TELEMETRY: value };
      expect(telemetryEnabled(env)).toBe(false);
      initTelemetry(env);
      await captureFatal(new Error("boom"));
      expect(Sentry.init).not.toHaveBeenCalled();
      expect(Sentry.isInitialized()).toBe(false);
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(Sentry.flush).not.toHaveBeenCalled();
    },
  );

  it.each(["1", "true", "on", " TRUE ", " On "])(
    "initializes redacted fatal reporting for %s", async (value) => {
      const env = { PICKFORGE_TELEMETRY: value };
      expect(telemetryEnabled(env)).toBe(true);
      initTelemetry(env);
      expect(Sentry.init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        tracesSampleRate: 0,
        defaultIntegrations: false,
        beforeBreadcrumb: dropBreadcrumb,
        beforeSend: scrubEvent,
      }));
      const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
      const event: ErrorEvent = {
        type: undefined,
        message: "API_KEY=super-secret-value",
        exception: { values: [{ value: "token=ghp_0123456789012345678901234567890abcde" }] },
      };
      const scrubbed = await options.beforeSend!(event, {});
      expect(scrubbed?.message).toBe("API_KEY=[REDACTED]");
      expect(scrubbed?.exception?.values?.[0].value).not.toContain("ghp_");
      const error = new Error("boom");
      await captureFatal(error);
      expect(Sentry.captureException).toHaveBeenCalledExactlyOnceWith(error);
      expect(Sentry.flush).toHaveBeenCalledExactlyOnceWith(2000);
    },
  );

  it("honors the legacy name with one warning per process", () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const value of ["1", "true", "on"]) {
        initTelemetry({ PICKLAB_TELEMETRY: value });
      }
      expect(Sentry.init).toHaveBeenCalledTimes(3);
      for (const value of ["0", "false", "off", "yes", ""]) {
        expect(telemetryEnabled({ PICKLAB_TELEMETRY: value })).toBe(false);
      }
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        "warning: PICKLAB_TELEMETRY is deprecated; use PICKFORGE_TELEMETRY instead",
      );
    } finally {
      warning.mockRestore();
    }
  });

  it.each(["", "0", "false", "off", "yes"])(
    "prefers the current name %s over legacy opt-in", (value) => {
      const warning = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        initTelemetry({ PICKFORGE_TELEMETRY: value, PICKLAB_TELEMETRY: "1" });
        expect(Sentry.init).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
      }
    },
  );
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
