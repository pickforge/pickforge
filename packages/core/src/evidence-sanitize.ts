import { redactSecrets } from "./redact.js";

/**
 * Fail-closed sanitizers for structured computer-use evidence
 * (pickforge/pickforge#20). Every function in this module drops or normalizes
 * anything it does not positively recognize; unknown fields, unparseable
 * values, and free-form text never reach persisted evidence unchanged.
 */

/** Maximum characters retained for one sanitized error summary. */
export const MAX_ERROR_TEXT_LENGTH = 512;

const TRUNCATION_MARKER = " [truncated]";

/** Placeholder recorded when a URL cannot be parsed at all. */
const INVALID_URL = "[invalid-url]";

/**
 * Reduce a URL to origin plus path for evidence. Query, hash, userinfo, and
 * semicolon path parameters (`;jsessionid=...`) are always dropped.
 * Non-hierarchical schemes (`data:`, `about:`, ...) keep only the protocol,
 * and unparseable input yields a placeholder rather than any part of the
 * original string. `blob:` URLs keep only `blob:` plus the inner origin —
 * their pathname is the raw inner URL (userinfo, path, and all), so it can
 * never be persisted.
 */
export function sanitizeUrlForEvidence(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return INVALID_URL;
  }
  if (url.protocol === "blob:") {
    return url.origin === "null" || url.origin === ""
      ? url.protocol
      : `${url.protocol}${url.origin}`;
  }
  if (url.origin === "null" || url.origin === "") {
    return url.protocol;
  }
  const path = url.pathname.replace(/;[^/]*/g, "");
  return redactSecrets(`${url.origin}${path}`);
}

/**
 * Redact secrets from free-form error text and bound its length so one error
 * cannot bloat the evidence journal. Truncation happens after redaction so a
 * secret can never straddle the cut and survive.
 */
export function sanitizeErrorText(
  text: string,
  maxLength: number = MAX_ERROR_TEXT_LENGTH,
): string {
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new Error("maxLength must be a positive integer");
  }
  const redacted = redactSecrets(text);
  if (redacted.length <= maxLength) {
    return redacted;
  }
  return redacted.slice(0, maxLength) + TRUNCATION_MARKER;
}

const TYPED_INPUT_TYPES = [
  "text",
  "search",
  "email",
  "url",
  "tel",
  "number",
  "password",
  "otp",
] as const;

/** Allowlisted input kinds a typed/fill action may record. */
export type TypedInputType = (typeof TYPED_INPUT_TYPES)[number] | "other";

export interface SanitizedTypedValue {
  /** Character count of the typed value; the value itself is never kept. */
  length: number;
  inputType: TypedInputType;
}

/**
 * Record a typed/fill value as length plus an allowlisted input type only.
 * Unrecognized input types collapse to `"other"` instead of persisting a
 * caller-provided string.
 */
export function sanitizeTypedValue(
  value: string,
  inputType?: string,
): SanitizedTypedValue {
  const normalized = inputType?.trim().toLowerCase();
  const allowed = (TYPED_INPUT_TYPES as readonly string[]).includes(
    normalized ?? "",
  )
    ? (normalized as TypedInputType)
    : "other";
  return { length: value.length, inputType: allowed };
}

/** Maximum characters retained for one target descriptor field. */
const MAX_TARGET_FIELD_LENGTH = 200;

export interface SanitizedActionTarget {
  role?: string;
  name?: string;
  selector?: string;
  url?: string;
  x?: number;
  y?: number;
}

function sanitizeTargetText(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const redacted = redactSecrets(value);
  return redacted.length <= MAX_TARGET_FIELD_LENGTH
    ? redacted
    : redacted.slice(0, MAX_TARGET_FIELD_LENGTH) + TRUNCATION_MARKER;
}

function sanitizeCoordinate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : undefined;
}

/**
 * Reduce an action target to an explicit per-field allowlist. Fields not
 * named here — headers, values, DOM snapshots, whatever a caller attaches —
 * are dropped, and each kept field is sanitized for its own shape.
 */
export function sanitizeActionTarget(target: unknown): SanitizedActionTarget {
  if (typeof target !== "object" || target === null) {
    return {};
  }
  const source = target as Record<string, unknown>;
  const result: SanitizedActionTarget = {};
  const role = sanitizeTargetText(source.role);
  if (role !== undefined) result.role = role;
  const name = sanitizeTargetText(source.name);
  if (name !== undefined) result.name = name;
  const selector = sanitizeTargetText(source.selector);
  if (selector !== undefined) result.selector = selector;
  if (typeof source.url === "string" && source.url !== "") {
    result.url = sanitizeUrlForEvidence(source.url);
  }
  const x = sanitizeCoordinate(source.x);
  if (x !== undefined) result.x = x;
  const y = sanitizeCoordinate(source.y);
  if (y !== undefined) result.y = y;
  return result;
}

const HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
] as const;

/** Allowlisted HTTP method recorded for a network failure. */
export type SanitizedHttpMethod = (typeof HTTP_METHODS)[number];

const RESOURCE_TYPES = [
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "texttrack",
  "xhr",
  "fetch",
  "eventsource",
  "websocket",
  "manifest",
  "ping",
  "other",
] as const;

/** Allowlisted resource type recorded for a network failure. */
export type SanitizedResourceType = (typeof RESOURCE_TYPES)[number];

export interface SanitizedNetworkFailure {
  method?: SanitizedHttpMethod;
  /** Origin plus path only — never query, hash, or userinfo. */
  url?: string;
  status?: number;
  resourceType?: SanitizedResourceType;
  durationMs?: number;
  error?: string;
}

/**
 * Reduce a network failure to method, origin/path, status, resource type,
 * timing, and a sanitized error summary. Headers, bodies, and query strings
 * have no field here and can never be persisted through this shape.
 */
// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
export function sanitizeNetworkFailure(input: {
  method?: string;
  url?: string;
  status?: number;
  resourceType?: string;
  durationMs?: number;
  error?: string;
}): SanitizedNetworkFailure {
  const result: SanitizedNetworkFailure = {};
  const method = input.method?.trim().toUpperCase();
  if (
    method !== undefined &&
    (HTTP_METHODS as readonly string[]).includes(method)
  ) {
    result.method = method as SanitizedHttpMethod;
  }
  if (typeof input.url === "string" && input.url !== "") {
    result.url = sanitizeUrlForEvidence(input.url);
  }
  if (
    typeof input.status === "number" &&
    Number.isInteger(input.status) &&
    input.status >= 0 &&
    input.status <= 999
  ) {
    result.status = input.status;
  }
  const resourceType = input.resourceType?.trim().toLowerCase();
  if (
    resourceType !== undefined &&
    (RESOURCE_TYPES as readonly string[]).includes(resourceType)
  ) {
    result.resourceType = resourceType as SanitizedResourceType;
  }
  if (
    typeof input.durationMs === "number" &&
    Number.isFinite(input.durationMs) &&
    input.durationMs >= 0
  ) {
    result.durationMs = Math.round(input.durationMs);
  }
  if (typeof input.error === "string" && input.error !== "") {
    result.error = sanitizeErrorText(input.error);
  }
  return result;
}
