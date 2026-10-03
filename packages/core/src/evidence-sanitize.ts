import type { EvidenceCaptureLink } from "./evidence.js";
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
  /** Drag start; `x`/`y` stay the destination. */
  fromX?: number;
  fromY?: number;
  /** Set only when the input target was verified as the session's owned Xvfb. */
  coordinateSpace?: "xvfb-root";
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
  return Object.assign(result, sanitizePointer(source));
}

function pixelIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Drag start and coordinate space are exact pixel facts: kept only when the
 * raw values are already non-negative integers, never rounded or completed.
 */
function sanitizePointer(source: Record<string, unknown>): SanitizedActionTarget {
  const { fromX, fromY } = source;
  const result: SanitizedActionTarget = {};
  const start = pixelIndex(fromX) && pixelIndex(fromY);
  if (start) {
    result.fromX = fromX;
    result.fromY = fromY;
  }
  const noStart = fromX === undefined && fromY === undefined;
  if (source.coordinateSpace === "xvfb-root" && pixelIndex(source.x) && pixelIndex(source.y) && (start || noStart)) {
    result.coordinateSpace = "xvfb-root";
  }
  return result;
}

/** The report's only admissible capture path shape. */
export function isSafeScreenshotPath(value: unknown): value is string {
  return typeof value === "string" && /^screenshots\/[A-Za-z0-9._-]+\.png$/.test(value) && !value.includes("..");
}

function captureLink(entry: unknown): EvidenceCaptureLink[] {
  if (typeof entry !== "object" || entry === null) return [];
  const { path, phase, width, height } = entry as Record<string, unknown>;
  const size = (value: unknown): value is number => pixelIndex(value) && value > 0;
  return isSafeScreenshotPath(path) && (phase === "before" || phase === "after") && size(width) && size(height)
    ? [{ path, phase, width, height }]
    : [];
}

function repeatedValues(entries: readonly unknown[], key: string): Set<unknown> {
  const seen = new Set<unknown>();
  const repeated = new Set<unknown>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return repeated;
}

/**
 * Keep only well-formed capture links. A path or phase named by more than one
 * entry, malformed entries included, is ambiguous, so every entry naming it
 * is dropped rather than guessing which one is right.
 */
export function sanitizeCaptureLinks(value: unknown): EvidenceCaptureLink[] {
  if (!Array.isArray(value)) return [];
  const paths = repeatedValues(value, "path");
  const phases = repeatedValues(value, "phase");
  return value.flatMap(captureLink).filter((link) => !paths.has(link.path) && !phases.has(link.phase));
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
// oxlint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
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
