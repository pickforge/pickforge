export const packageName = "@pickforge/lab-desktop-linux";

export {
  XvfbStartError,
  allocateDisplay,
  buildXvfbArgs,
  isDisplayAlive,
  parseDisplayNumber,
  startXvfb,
  stopXvfb,
  type AllocateDisplayOptions,
  type StartXvfbOptions,
  type XvfbPartialStart,
  type XvfbStartFailureReason,
  type XvfbArgsOptions,
  type XvfbHandle,
} from "./display.js";

export {
  buildVncArgs,
  detectVncBinary,
  startVnc,
  VncStartError,
  type StartVncOptions,
  type VncArgsOptions,
  type VncHandle,
  type VncPartialStart,
  type VncStartFailureReason,
} from "./vnc.js";

export {
  buildVncViewerArgs,
  detectVncViewer,
  openVncViewer,
  type DetectedVncViewer,
  type OpenVncViewerOptions,
  type OpenVncViewerResult,
  type VncViewerName,
} from "./viewer.js";

export {
  DEFAULT_EXEC_WINDOW_TIMEOUT_MS,
  execApp,
  launchApp,
  listWindows,
  noClientWindowsWarning,
  waitForWindow,
  type AppHandle,
  type ExecAppHandle,
  type ExecAppOptions,
  type LaunchAppOptions,
  type WindowInfo,
} from "./apps.js";

export {
  createIsolatedDesktopEnvironment,
  desktopEnvironmentRecipe,
  type DesktopEnvironmentOptions,
  type DesktopEnvironmentRecipe,
} from "./environment.js";

export {
  createDesktopRuntimeDir,
  desktopRuntimeLayout,
  DESKTOP_RUNTIME_DIR_NAME,
  removeDesktopRuntimeDir,
  type DesktopRuntimeLayout,
  type RuntimeDirRemoval,
} from "./runtime.js";

export {
  buildScreenshotCommand,
  detectScreenshotTool,
  screenshot,
  type ScreenshotOptions,
  type ScreenshotResult,
  type ScreenshotStep,
  type ScreenshotTool,
} from "./screenshot.js";

export {
  buildClickArgs,
  buildDoubleClickArgs,
  buildDragArgs,
  buildKeyArgs,
  buildMoveArgs,
  buildScrollArgs,
  buildTypeArgs,
  click,
  doubleClick,
  drag,
  MAX_DOUBLE_CLICK_INTERVAL_MS,
  MAX_DRAG_DURATION_MS,
  MAX_SCROLL_STEPS,
  move,
  pressKey,
  scroll,
  typeText,
  type ClickArgsOptions,
  type ClickOptions,
  type DoubleClickArgsOptions,
  type DoubleClickOptions,
  type DragArgsOptions,
  type DragOptions,
  type MoveArgsOptions,
  type MoveOptions,
  type PressKeyOptions,
  type ScrollArgsOptions,
  type ScrollOptions,
  type TypeTextOptions,
} from "./input.js";

export {
  createDesktopSession,
  desktopSessionLogDir,
  destroyDesktopSession,
  ensureDesktopSessionIsolation,
  ensureSessionVnc,
  getDesktopSessionStatus,
  startSessionVnc,
  stopOwnedSessionVnc,
  teardownDesktopSession,
  withSessionVncLock,
  type CreateDesktopSessionOptions,
  type DesktopSessionHandle,
  type DesktopSessionIsolation,
  type DesktopSessionStatus,
  type EnsureSessionVncOptions,
  type EnsuredSessionVnc,
  type StartSessionVncOptions,
} from "./session.js";

export { findOnPath } from "./util.js";

export {
  endHumanTakeover,
  recoverStaleHumanLease,
  renewHumanTakeover,
  startHumanTakeover,
  type EndHumanTakeoverOptions,
  type EndHumanTakeoverResult,
  type HumanTakeoverHandle,
  type StartHumanTakeoverOptions,
  type TakeoverEndReason,
} from "./takeover.js";

export {
  DEFAULT_TAKEOVER_WATCHDOG_POLL_MS,
  runTakeoverWatchdogLoop,
  type RunTakeoverWatchdogLoopOptions,
} from "./takeover-watchdog.js";
