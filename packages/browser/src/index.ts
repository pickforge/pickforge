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
  type SupervisedBrowserCommand,
} from "./supervisor.js";

export {
  parseDevToolsActivePort,
  probeDevToolsHttp,
  readDevToolsActivePort,
  waitForDevToolsPort,
  type DevToolsPortResult,
  type WaitForDevToolsPortOptions,
} from "./devtools.js";

export {
  browserSessionLogDir,
  createBrowserSession,
  destroyBrowserSession,
  getBrowserSessionStatus,
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
  TAKEOVER_BUSY_ERROR_CODE,
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
