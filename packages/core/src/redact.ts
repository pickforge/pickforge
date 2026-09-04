const REPLACEMENT = "[REDACTED]";

// `otp` (plus totp/hotp) must stand alone between non-letters so ordinary
// words like "screenshotPath" (…hotP…) never trip the secret-key patterns.
const OTP_KEYWORD = "(?<![a-z])[th]?otp(?![a-z])";

const KEY_PATTERN = new RegExp(
  `(token|secret|password|passwd|api[_-]?key|authorization|bearer|credential|cookie|csrf|xsrf|${OTP_KEYWORD})`,
  "i",
);

// Bare `session`/`sessionId`-style keys are credentials, but session-adjacent
// metadata (`sessionCount`, `sessionStatus`, `SESSION_MANAGER`) is not: the
// key must end right after `session`, or continue only into an `id` suffix
// (`sessionId`, `session_id`, `jsessionid`, `PHPSESSID`).
const SESSION_KEYWORD = "sess(?:ion)?[-_]?id(?![a-z0-9])|session(?![a-z0-9_-])";

const JSON_FIELD_RE = new RegExp(
  `("[^"\\r\\n]*(?:token|secret|password|passwd|api[_-]?key|authorization|bearer|credential|cookie|csrf|xsrf|${OTP_KEYWORD}|${SESSION_KEYWORD})[^"\\r\\n]*"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
  "gi",
);

// `(?<![?&\w.-])` keeps this rule off URL query parameters (QUERY_VALUE_RE
// owns those and preserves the following `&param=` pairs) while still
// anchoring key starts like the old `\b` did. Semicolon path parameters
// (`;jsessionid=...`) start after `;`, which the lookbehind permits, so
// session/token matrix params in free text are redacted here. Unquoted
// values stop at `;` so subsequent cookie pairs / matrix params survive.
const ASSIGNMENT_RE = new RegExp(
  `(?<![?&\\w.-])([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|bearer|credential|csrf|xsrf|${OTP_KEYWORD}|${SESSION_KEYWORD})[A-Za-z0-9_.-]*\\s*[=:]\\s*)("(?:[^"\\\\\\r\\n]|\\\\.)*"|'(?:[^'\\\\\\r\\n]|\\\\.)*'|(?:Bearer\\s+)?(?:<[^<>\\r\\n]*>|[^\\s\\r\\n"'<>;]+(?:<[^<>\\r\\n]*>[^\\s\\r\\n"'<>;]*)*))`,
  "gi",
);

const BEARER_VALUE_RE = /(\bBearer\s+)(?:<[^<>\r\n]*>|[^\s\r\n"'<>]+)/gi;

// `Cookie:` / `Set-Cookie:` header lines. The prefix is matched here; the
// remainder is walked by redactCookiePairs, which understands balanced
// quoted values, apostrophes inside unquoted values, and XML/JSON embedding
// boundaries — cases a single value regex cannot separate.
const COOKIE_PREFIX_RE = /\b(?:set-)?cookie[ \t]*:[ \t]*/gi;
const COOKIE_ATTRIBUTES = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "samesite",
  "priority",
]);

// `Authorization:` header lines redact the full remainder so every scheme
// (Bearer, Basic, Digest, ...) fails closed. Balanced quoted parameters
// (Digest `username="alice", ...`) are part of the credential and are
// consumed, but only when the closing quote sits at a plausible parameter
// boundary — so a surrounding XML/JSON closing quote stays intact.
const AUTH_QUOTED = `"[^"\\r\\n]*"(?=[ \\t,;"'\\r\\n]|$)|'[^'\\r\\n]*'(?=[ \\t,;"'\\r\\n]|$)`;
const AUTH_UNIT = `(?:${AUTH_QUOTED}|[^\\s"',;])+`;
const AUTHORIZATION_HEADER_RE = new RegExp(
  `(\\bauthorization[ \\t]*:[ \\t]*)(${AUTH_UNIT}(?:[ \\t,;]+${AUTH_UNIT})*)`,
  "gi",
);

// Bare JWTs: header and payload are base64url-encoded JSON, so both segments
// start with `eyJ`; the signature may be empty for unsigned tokens.
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

// Credential-bearing URL query values: parameter names that contain an
// auth-like word, or exactly match short credential names (auth, code, sid,
// key). Substring matching stays narrow ("sess", not "auth") so names like
// "author" survive.
const QUERY_VALUE_RE = new RegExp(
  `([?&](?:[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|bearer|credential|sess|csrf|xsrf|${OTP_KEYWORD}|jwt)[A-Za-z0-9_.-]*|auth|oauth|authorization|code|sid|key)=)[^&#\\s"'\\r\\n]*`,
  "gi",
);

// Chrome DevTools websocket capability URLs and GUID paths. Keeping the
// origin/path prefix preserves diagnostics; the GUID is the capability.
const CDP_WEBSOCKET_RE =
  /((?:\bwss?:\/\/[^\s"'<>]*)?\/devtools\/(?:browser|page)\/)[A-Za-z0-9-]+/gi;

const LITERAL_RES: RegExp[] = [
  /ghp_[A-Za-z0-9]{36}/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/**
 * Find the closing `token` for a quoted cookie value on the current line.
 * Legal cookie values cannot contain quotes, so the first occurrence
 * decides: it is the close only when a plausible boundary follows — `;`,
 * whitespace, comma, end of line/text, or a quote (the embedding XML/JSON
 * document's own closing delimiter). A first quote followed by other text
 * belongs to the embedding document, and the "quoted" opener was really that
 * document's closing delimiter. Newlines end the search.
 */
function findQuotedValueClose(
  text: string,
  token: string,
  from: number,
): number {
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\n" || ch === "\r") return -1;
    if (text.startsWith(token, j)) {
      const after = text[j + token.length];
      return after === undefined ||
        after === ";" ||
        after === "," ||
        after === " " ||
        after === "\t" ||
        after === "\r" ||
        after === "\n" ||
        after === '"' ||
        after === "'"
        ? j
        : -1;
    }
  }
  return -1;
}

/**
 * Whether `token` occurs anywhere later on the current line, regardless of
 * what follows it. Used only after `findQuotedValueClose` has failed: a
 * later occurrence — even one that itself fails the boundary check — means
 * the opening quote is plausibly the embedding document's own delimiter, so
 * shape is preserved. No later occurrence at all means the value is a truly
 * unterminated quote with no candidate close anywhere on the line: it can
 * only be opaque credential material, so it must be redacted outright rather
 * than left as an unmatched raw tail.
 */
function hasLaterQuoteToken(text: string, token: string, from: number): boolean {
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\n" || ch === "\r") return false;
    if (text.startsWith(token, j)) return true;
  }
  return false;
}

function isEmbeddingBoundary(text: string, index: number): boolean {
  const ch = text[index];
  return ch === undefined || /[\s,}\]>\/]/.test(ch);
}

/**
 * Walk the remainder of a Cookie/Set-Cookie header from `start`, redacting
 * each pair's value while preserving structure. Handles balanced quoted
 * values (`sid="abc; def"`, including `\"`-escaped quotes inside JSON
 * strings), apostrophes inside legal unquoted values (`name=o'brien`), and
 * XML/JSON embedding: a quote that does not open a value ends the header so
 * the surrounding document's delimiters survive.
 */
// eslint-disable-next-line complexity -- Legacy gate debt: pickforge/pickforge#60
function redactCookiePairs(
  text: string,
  start: number,
): { replacement: string; end: number } {
  let out = "";
  let i = start;
  const len = text.length;
  while (i < len) {
    // Pair name (leading whitespace kept verbatim; trimmed for lookup).
    const nameStart = i;
    while (i < len && !'=;"\'\r\n'.includes(text[i]!)) i++;
    const name = text.slice(nameStart, i);
    if (i >= len || text[i] !== "=") {
      if (text[i] === ";") {
        // Valueless flag such as HttpOnly / Secure.
        out += `${name};`;
        i++;
        continue;
      }
      // Newline, or a quote closing the embedding document. No `=`, so
      // nothing secret; keep the flag text and stop before the terminator.
      out += name;
      return { replacement: out, end: i };
    }
    i++; // consume '='
    const isAttribute = COOKIE_ATTRIBUTES.has(name.trim().toLowerCase());
    // Quoted value? Accept `"`, `'`, or their backslash-escaped forms as the
    // delimiter when a matching close exists on the same line.
    let quoteToken: string | undefined;
    if (text[i] === '"' || text[i] === "'") {
      quoteToken = text[i];
    } else if (text[i] === "\\" && (text[i + 1] === '"' || text[i + 1] === "'")) {
      quoteToken = text.slice(i, i + 2);
    }
    let value: string;
    if (quoteToken !== undefined) {
      const close = findQuotedValueClose(text, quoteToken, i + quoteToken.length);
      if (close === -1) {
        if (
          isEmbeddingBoundary(text, i + quoteToken.length) &&
          hasLaterQuoteToken(text, quoteToken, i + quoteToken.length)
        ) {
          // Unbalanced empty value followed by an embedding boundary: the
          // opening quote plausibly belongs to the embedding document.
          // Redact the value and stop before the quote.
          out += `${name}=${isAttribute ? "" : REPLACEMENT}`;
          return { replacement: out, end: i };
        }
        // No candidate close exists anywhere on the line: this is a truly
        // unterminated quoted value, not an embedding boundary. Fail closed
        // and redact through the end of the line/text so no opaque
        // credential tail can survive.
        let end = i + quoteToken.length;
        while (end < len && text[end] !== "\r" && text[end] !== "\n") end++;
        out += `${name}=${isAttribute ? text.slice(i, end) : REPLACEMENT}`;
        return { replacement: out, end };
      }
      const closeEnd = close + quoteToken.length;
      value = text.slice(i, closeEnd);
      out += isAttribute
        ? `${name}=${value}`
        : `${name}=${quoteToken}${REPLACEMENT}${quoteToken}`;
      i = closeEnd;
    } else {
      const valueStart = i;
      while (i < len) {
        const ch = text[i]!;
        if (ch === ";" || ch === '"' || ch === "\r" || ch === "\n") break;
        // An apostrophe stays in the value only when more value text follows
        // (o'brien); otherwise it closes the embedding document.
        if (ch === "'" && !/[A-Za-z0-9]/.test(text[i + 1] ?? "")) break;
        i++;
      }
      value = text.slice(valueStart, i);
      out += isAttribute ? `${name}=${value}` : `${name}=${REPLACEMENT}`;
    }
    // Optional whitespace, then either the next pair or the header's end.
    let ws = i;
    while (ws < len && (text[ws] === " " || text[ws] === "\t")) ws++;
    if (text[ws] === ";") {
      out += text.slice(i, ws) + ";";
      i = ws + 1;
      continue;
    }
    return { replacement: out, end: i };
  }
  return { replacement: out, end: i };
}

function redactCookieHeaders(text: string): string {
  COOKIE_PREFIX_RE.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = COOKIE_PREFIX_RE.exec(text)) !== null) {
    out += text.slice(cursor, match.index) + match[0];
    const { replacement, end } = redactCookiePairs(
      text,
      match.index + match[0].length,
    );
    out += replacement;
    cursor = end;
    COOKIE_PREFIX_RE.lastIndex = end;
  }
  return out + text.slice(cursor);
}

export function redactSecrets(text: string): string {
  let result = redactCookieHeaders(text);
  // JSON fields first so `"authorization": "..."` keeps its quoting; the
  // header rule then only sees unquoted `Authorization:` lines.
  result = result.replace(JSON_FIELD_RE, `$1"${REPLACEMENT}"`);
  result = result.replace(AUTHORIZATION_HEADER_RE, `$1${REPLACEMENT}`);
  result = result.replace(ASSIGNMENT_RE, (_match, prefix, value) => {
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      return `${prefix}${quote}${REPLACEMENT}${quote}`;
    }
    return `${prefix}${REPLACEMENT}`;
  });
  result = result.replace(BEARER_VALUE_RE, `$1${REPLACEMENT}`);
  result = result.replace(JWT_RE, REPLACEMENT);
  result = result.replace(QUERY_VALUE_RE, `$1${REPLACEMENT}`);
  result = result.replace(CDP_WEBSOCKET_RE, `$1${REPLACEMENT}`);
  for (const re of LITERAL_RES) {
    result = result.replace(re, REPLACEMENT);
  }
  return result;
}

export function isSecretKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function redactEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] =
      value !== undefined && isSecretKey(key) ? REPLACEMENT : value;
  }
  return result;
}
