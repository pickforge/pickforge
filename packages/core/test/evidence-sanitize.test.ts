import { describe, expect, it } from "vitest";
import {
  MAX_ERROR_TEXT_LENGTH,
  sanitizeActionTarget,
  sanitizeCaptureLinks,
  sanitizeErrorText,
  sanitizeNetworkFailure,
  sanitizeTypedValue,
  sanitizeUrlForEvidence,
} from "../src/evidence-sanitize.js";

const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM";

describe("sanitizeUrlForEvidence", () => {
  it("keeps origin and path only", () => {
    expect(
      sanitizeUrlForEvidence("https://app.test:8443/checkout/step-2"),
    ).toBe("https://app.test:8443/checkout/step-2");
  });

  it("drops query, hash, and userinfo", () => {
    expect(
      sanitizeUrlForEvidence(
        `https://alice:hunter2@app.test/cb?access_token=${JWT}&code=abc#otp=123456`,
      ),
    ).toBe("https://app.test/cb");
  });

  it("keeps only the protocol for non-hierarchical schemes", () => {
    expect(sanitizeUrlForEvidence("data:text/html,<h1>secret</h1>")).toBe(
      "data:",
    );
    expect(sanitizeUrlForEvidence("about:blank")).toBe("about:");
  });

  it("keeps only the safe origin for blob URLs", () => {
    expect(
      sanitizeUrlForEvidence(
        "blob:https://app.test/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe("blob:https://app.test");
  });

  it("never leaks blob inner userinfo or paths", () => {
    const out = sanitizeUrlForEvidence(
      "blob:https://alice:hunter2@app.test/550e8400-e29b-41d4-a716-446655440000",
    );
    expect(out).toBe("blob:https://app.test");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("550e8400");
    expect(sanitizeUrlForEvidence("blob:token=abc123")).toBe("blob:");
  });

  it("strips semicolon path parameters like jsessionid", () => {
    expect(
      sanitizeUrlForEvidence(
        "https://app.test/cart;jsessionid=0000ABC123?item=1",
      ),
    ).toBe("https://app.test/cart");
    expect(sanitizeUrlForEvidence("https://app.test/a;sid=XYZ/b")).toBe(
      "https://app.test/a/b",
    );
  });

  it("returns a placeholder for unparseable input, never the original", () => {
    const raw = "not a url token=abc123";
    const out = sanitizeUrlForEvidence(raw);
    expect(out).toBe("[invalid-url]");
    expect(out).not.toContain("abc123");
  });

  it("redacts CDP websocket capability GUIDs in paths", () => {
    expect(
      sanitizeUrlForEvidence(
        "ws://127.0.0.1:9222/devtools/browser/1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809",
      ),
    ).toBe("ws://127.0.0.1:9222/devtools/browser/[REDACTED]");
  });
});

describe("sanitizeErrorText", () => {
  it("redacts planted secrets", () => {
    const out = sanitizeErrorText(
      `fetch failed: Cookie: sid=abc123; Authorization: Bearer ${JWT}`,
    );
    expect(out).not.toContain("abc123");
    expect(out).not.toContain(JWT);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("fetch failed");
  });

  it("bounds output length after redaction", () => {
    const out = sanitizeErrorText("x".repeat(MAX_ERROR_TEXT_LENGTH + 100));
    expect(out).toBe("x".repeat(MAX_ERROR_TEXT_LENGTH) + " [truncated]");
  });

  it("keeps short text unchanged", () => {
    expect(sanitizeErrorText("net::ERR_CONNECTION_REFUSED")).toBe(
      "net::ERR_CONNECTION_REFUSED",
    );
  });

  it("rejects a non-positive bound", () => {
    expect(() => sanitizeErrorText("x", 0)).toThrow(
      "maxLength must be a positive integer",
    );
  });
});

describe("sanitizeTypedValue", () => {
  it("keeps only length and an allowlisted input type", () => {
    expect(sanitizeTypedValue("hunter2-super-secret", "password")).toEqual({
      length: 20,
      inputType: "password",
    });
    expect(sanitizeTypedValue("123456", "otp")).toEqual({
      length: 6,
      inputType: "otp",
    });
  });

  it("normalizes case and whitespace of the input type", () => {
    expect(sanitizeTypedValue("a", " Email ")).toEqual({
      length: 1,
      inputType: "email",
    });
  });

  it("collapses unknown or missing input types to other", () => {
    expect(sanitizeTypedValue("abc", "credit-card sid=abc")).toEqual({
      length: 3,
      inputType: "other",
    });
    expect(sanitizeTypedValue("abc")).toEqual({ length: 3, inputType: "other" });
  });
});

describe("sanitizeActionTarget", () => {
  it("keeps only allowlisted fields and drops unknown ones", () => {
    const out = sanitizeActionTarget({
      role: "button",
      name: "Submit",
      selector: "#submit",
      url: "https://app.test/form?csrf=deadbeef",
      x: 10.6,
      y: 20.2,
      headers: { authorization: "Bearer abc" },
      value: "hunter2",
      innerText: "secret dump",
    });
    expect(out).toEqual({
      role: "button",
      name: "Submit",
      selector: "#submit",
      url: "https://app.test/form",
      x: 11,
      y: 20,
    });
  });

  it("redacts secrets inside kept text fields", () => {
    const out = sanitizeActionTarget({ name: `token=${JWT}` });
    expect(out.name).not.toContain(JWT);
    expect(out.name).toContain("[REDACTED]");
  });

  it("bounds kept text fields", () => {
    const out = sanitizeActionTarget({ selector: "#" + "a".repeat(400) });
    expect(out.selector?.length).toBeLessThanOrEqual(212);
    expect(out.selector?.endsWith(" [truncated]")).toBe(true);
  });

  it("drops non-string text and non-finite coordinates", () => {
    expect(
      sanitizeActionTarget({
        role: 5,
        name: "",
        x: Number.NaN,
        y: Infinity,
      }),
    ).toEqual({});
  });

  it("returns an empty target for non-object input", () => {
    expect(sanitizeActionTarget(null)).toEqual({});
    expect(sanitizeActionTarget("token=abc")).toEqual({});
    expect(sanitizeActionTarget(42)).toEqual({});
  });
});

describe("sanitizeActionTarget pointer fields", () => {
  const root = { x: 640, y: 400, coordinateSpace: "xvfb-root" };

  it("keeps a valid drag start pair and the verified coordinate space", () => {
    expect(sanitizeActionTarget({ ...root, fromX: 0, fromY: 20 })).toEqual({
      x: 640, y: 400, fromX: 0, fromY: 20, coordinateSpace: "xvfb-root",
    });
    expect(sanitizeActionTarget(root)).toEqual({ x: 640, y: 400, coordinateSpace: "xvfb-root" });
  });

  it.each([
    ["only fromX", { fromX: 10 }],
    ["only fromY", { fromY: 10 }],
    ["a negative start", { fromX: -1, fromY: 10 }],
    ["a fractional start", { fromX: 10.4, fromY: 10 }],
    ["a string start", { fromX: "10", fromY: 10 }],
    ["a null start", { fromX: null, fromY: 10 }],
    ["an unsafe integer start", { fromX: Number.MAX_SAFE_INTEGER + 1, fromY: 10 }],
    ["an infinite start", { fromX: Infinity, fromY: 10 }],
  ])("drops the drag start and the coordinate space for %s", (_label, start) => {
    expect(sanitizeActionTarget({ ...root, ...start })).toEqual({ x: 640, y: 400 });
  });

  it.each([
    ["an unknown space", { coordinateSpace: "screen" }],
    ["a differently cased space", { coordinateSpace: "XVFB-ROOT" }],
    ["a fractional x", { x: 10.4 }],
    ["a negative y", { y: -3 }],
    ["a missing y", { y: undefined }],
    ["a string x", { x: "10" }],
  ])("drops the coordinate space for %s", (_label, change) => {
    expect(sanitizeActionTarget({ ...root, ...change })).not.toHaveProperty("coordinateSpace");
  });

  it("keeps rounding plain x and y for browser targets", () => {
    expect(sanitizeActionTarget({ x: -10.6, y: 3.5 })).toEqual({ x: -11, y: 4 });
  });
});

describe("sanitizeCaptureLinks", () => {
  const before = { path: "screenshots/a-before.png", phase: "before", width: 1280, height: 800 };
  const after = { path: "screenshots/a-after.png", phase: "after", width: 200, height: 120 };

  it("keeps well-formed links and copies only the four known fields", () => {
    expect(sanitizeCaptureLinks([{ ...before, extra: "token" }, after])).toEqual([
      { path: "screenshots/a-before.png", phase: "before", width: 1280, height: 800 },
      { path: "screenshots/a-after.png", phase: "after", width: 200, height: 120 },
    ]);
  });

  it.each([undefined, null, "screenshots/a.png", {}, 42])("returns no links for %s", (value) => {
    expect(sanitizeCaptureLinks(value)).toEqual([]);
  });

  it.each([
    ["a traversal path", { path: "screenshots/../a.png" }],
    ["a dotted traversal name", { path: "screenshots/..a.png" }],
    ["a nested path", { path: "screenshots/x/a.png" }],
    ["an absolute path", { path: "/screenshots/a.png" }],
    ["a non-png path", { path: "screenshots/a.jpg" }],
    ["a non-screenshot path", { path: "report.html" }],
    ["a non-string path", { path: 7 }],
    ["an unknown phase", { phase: "during" }],
    ["a zero width", { width: 0 }],
    ["a fractional height", { height: 1.5 }],
    ["a negative width", { width: -1 }],
    ["a string height", { height: "800" }],
    ["an unsafe width", { width: Number.MAX_SAFE_INTEGER + 1 }],
  ])("drops %s", (_label, change) => {
    expect(sanitizeCaptureLinks([{ ...before, ...change }, after])).toEqual([after]);
  });

  it("drops every entry for a repeated path or phase as ambiguous", () => {
    expect(sanitizeCaptureLinks([before, { ...after, path: before.path }])).toEqual([]);
    expect(sanitizeCaptureLinks([before, after, { ...before, path: "screenshots/b.png" }])).toEqual([after]);
  });

  it("counts malformed entries when deciding ambiguity", () => {
    expect(sanitizeCaptureLinks([before, after, { path: before.path, phase: "during" }])).toEqual([after]);
    expect(sanitizeCaptureLinks([before, after, { phase: "after", width: 0 }])).toEqual([before]);
    expect(sanitizeCaptureLinks([before, null, "x", after])).toEqual([before, after]);
  });
});

describe("sanitizeNetworkFailure", () => {
  it("keeps method, origin/path, status, resource type, timing, and error", () => {
    expect(
      sanitizeNetworkFailure({
        method: "post",
        url: `https://api.test/v1/login?session=${JWT}`,
        status: 401,
        resourceType: "Fetch",
        durationMs: 123.7,
        error: "401 Unauthorized",
      }),
    ).toEqual({
      method: "POST",
      url: "https://api.test/v1/login",
      status: 401,
      resourceType: "fetch",
      durationMs: 124,
      error: "401 Unauthorized",
    });
  });

  it("never has fields for headers, bodies, or query strings", () => {
    const out = sanitizeNetworkFailure({
      method: "GET",
      url: "https://api.test/data?token=abc123",
      ...({
        requestHeaders: { cookie: "sid=abc" },
        responseBody: "secret body",
      } as object),
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("abc123");
    expect(json).not.toContain("sid=abc");
    expect(json).not.toContain("secret body");
    expect(Object.keys(out).sort()).toEqual(["method", "url"]);
  });

  it("drops unknown methods, resource types, and invalid numbers", () => {
    expect(
      sanitizeNetworkFailure({
        method: "STEAL",
        resourceType: "credentials",
        status: 12345,
        durationMs: -5,
      }),
    ).toEqual({});
  });

  it("sanitizes planted secrets in error text", () => {
    const out = sanitizeNetworkFailure({
      error: `blocked: Set-Cookie: session=s3cr3t; Path=/ and otp=123456`,
    });
    expect(out.error).not.toContain("s3cr3t");
    expect(out.error).not.toContain("123456");
    expect(out.error).toContain("Path=/");
  });
});
