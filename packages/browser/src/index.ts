export const packageName = "@pickforge/lab-browser";

export {
  SUPPORTED_CHROME_BINARIES,
  detectChromeBinary,
  requireChromeBinary,
  type DetectChromeOptions,
} from "./detect.js";

export {
  browserRuntimeLayout,
  buildBrowserEnv,
  type BrowserRuntimeLayout,
  type BuildBrowserEnvOptions,
} from "./env.js";

export { buildChromeArgs, type BuildChromeArgsOptions } from "./args.js";

export {
  buildSupervisedBrowserCommand,
  resolveSupervisorScript,
  type SupervisedBrowserCommand,
  type SupervisorCdpPaths,
} from "./supervisor.js";

export {
  CdpAlreadyAttachedError,
  attachCdpClient,
  cdpWebSocketUrl,
  parseCdpEndpoint,
  probeCdpEndpoint,
  readCdpEndpoint,
  requestCdpBrowserClose,
  waitForCdpEndpoint,
  type CdpClientLease,
  type CdpEndpoint,
  type CdpEndpointResult,
  type WaitForCdpEndpointOptions,
} from "./devtools.js";

export {
  browserSessionLogDir,
  createBrowserSession,
  destroyBrowserSession,
  getBrowserSessionStatus,
  readBrowserSessionCdpEndpoint,
  teardownBrowserSession,
  type BrowserSessionHandle,
  type BrowserSessionStatus,
  type CreateBrowserSessionOptions,
} from "./session.js";

export { createDeferred, type Deferred } from "./deferred.js";

export {
  JsonRpcNdjsonBuffer,
  DEFAULT_MAX_JSON_RPC_RECORD_BYTES,
  JsonRpcProtocolError,
  assertJsonRpcMessage,
  createJsonRpcWriteQueue,
  pumpJsonRpcNdjson,
  serializeJsonRpcMessage,
  writeWithBackpressure,
  type JsonRpcHook,
  type JsonRpcId,
  type JsonRpcIntercept,
  type JsonRpcMessage,
  type JsonRpcRecord,
  type JsonRpcWriteSerializer,
  type PumpJsonRpcNdjsonOptions,
} from "./ndjson.js";

export {
  CHROME_DEVTOOLS_MCP_BIN,
  CHROME_DEVTOOLS_MCP_PACKAGE,
  CHROME_DEVTOOLS_MCP_VERSION,
  DEFAULT_MAX_DIAGNOSTIC_LINE_BYTES,
  SESSION_CHECK_FAILED_ERROR_CODE,
  SESSION_ENDED_ERROR_CODE,
  TAKEOVER_BUSY_ERROR_CODE,
  createSessionEndedIntercept,
  createTakeoverBusyIntercept,
  resolveDevtoolsMcpExecutable,
  resolveLiveBrowserSession,
  runDevtoolsMcpRelay,
  runProjectDevtoolsMcp,
  type DevtoolsMcpExecutable,
  type DevtoolsSpawn,
  type LiveBrowserSession,
  type RelayExit,
  type RelayHooks,
  type RelaySignalSource,
  type ResolveLiveBrowserSessionOptions,
  type RunDevtoolsMcpRelayOptions,
  type RunProjectDevtoolsMcpOptions,
} from "./devtools-mcp.js";

export {
  DEVTOOLS_PERMIT_WATCH_MS,
  createDevtoolsPermitGate,
  type DevtoolsPermitGate,
} from "./devtools-permits.js";

export {
  BROWSER_PROFILE_NAME,
  browserProfileDir,
  claimBrowserProfile,
  releaseBrowserProfile,
  listBrowserProfiles,
  deleteBrowserProfile,
  validateBrowserProfileName,
  type BrowserProfileEntry,
} from "./profiles.js";

export { enterPlainBrowser, restoreCdpBrowser } from "./handoff.js";
