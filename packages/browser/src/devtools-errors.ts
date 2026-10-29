import type { JsonRpcMessage } from "./ndjson.js";

/** JSON-RPC error code for the stable "human control is active" busy response. */
export const TAKEOVER_BUSY_ERROR_CODE = -32050;
/** JSON-RPC error code for the stable "browser session has ended" response. */
export const SESSION_ENDED_ERROR_CODE = -32051;
/** JSON-RPC error code for a call refused because the session check failed. */
export const SESSION_CHECK_FAILED_ERROR_CODE = -32052;

export type RelayErrorCode =
  | typeof TAKEOVER_BUSY_ERROR_CODE
  | typeof SESSION_ENDED_ERROR_CODE
  | typeof SESSION_CHECK_FAILED_ERROR_CODE;

const RELAY_ERROR_MESSAGES: Record<RelayErrorCode, string> = {
  [TAKEOVER_BUSY_ERROR_CODE]:
    "Pickforge: human control is active; agent input is paused until control returns",
  [SESSION_ENDED_ERROR_CODE]:
    "Pickforge: the browser session has ended; create a new session and restart the DevTools relay",
  [SESSION_CHECK_FAILED_ERROR_CODE]:
    "Pickforge: could not check the browser session; try the call again",
};

export function jsonRpcRequestId(message: JsonRpcMessage): string | number | undefined {
  return typeof message.id === "string" || typeof message.id === "number"
    ? message.id
    : undefined;
}

/** The relay's stable error response for a refused or ended call. */
export function relayErrorResponse(id: string | number, code: RelayErrorCode): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message: RELAY_ERROR_MESSAGES[code] } };
}
