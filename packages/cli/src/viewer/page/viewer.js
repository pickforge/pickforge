// Passive viewer page (pickforge/pickforge#207). Mirrors
// packages/cli/src/viewer/contract.ts; keep both in sync.
import RFB from "/novnc/core/rfb.js";

const CLOSE_CODES = {
  vncUnavailable: 4001,
  vncWritable: 4002,
  sessionEnded: 4003,
  shuttingDown: 4004,
};
const LAUNCH_ID_PATTERN = /^[0-9a-f]{32}$/;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10000;
const WRITABLE_RETRY_MS = 5000;
const STATUS_API_PATH = "/api/status";
const STATUS_TIMEOUT_MS = 5000;
/** Mirrors VIEWER_LABEL_MAX_CHARS. */
const LABEL_MAX_CHARS = 256;
/** Control, format, bidi and line or paragraph separator characters. */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const TITLE = "Pickforge viewer";
/** Consecutive failed status probes that mean the bridge is gone for good. */
const MAX_PROBE_FAILURES = 2;

const STATUS_TEXT = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  control: "Human control active",
  ended: "Session ended",
  stopped: "Viewer stopped",
  expired: "Link expired",
};
/** States that end the page: no further connection attempts. */
const FINAL_STATES = new Set(["ended", "stopped", "expired"]);
/** Every pointer, touch and wheel event the shield swallows. */
const SHIELDED_EVENTS = [
  "pointerdown",
  "pointerup",
  "pointermove",
  "mousedown",
  "mouseup",
  "mousemove",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "wheel",
  "touchstart",
  "touchmove",
  "touchend",
];

const state = {
  launchId: "",
  token: "",
  status: "connecting",
  mode: "thumbnail",
  rfb: null,
  socket: null,
  attempts: 0,
  connectedOnce: false,
  retryTimer: undefined,
  probeFailures: 0,
};

function element(id) {
  return document.getElementById(id);
}

function storageKey(name) {
  return `pickforge.watch.${state.launchId}.${name}`;
}

function readStored(name) {
  try {
    return sessionStorage.getItem(storageKey(name)) ?? "";
  } catch {
    return "";
  }
}

function writeStored(name, value) {
  try {
    sessionStorage.setItem(storageKey(name), value);
  } catch {
    // Storage can be unavailable; the page still works until a reload.
  }
}

/**
 * The token and the label arrive in the fragment once, then live in
 * sessionStorage.
 */
function takeFragment() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash !== "") {
    history.replaceState(null, "", location.pathname + location.search);
  }
  const token = params.get("token");
  if (token) {
    writeStored("token", token);
    writeStored("label", params.get("label") ?? "");
    return { token, label: params.get("label") ?? "" };
  }
  return { token: readStored("token"), label: readStored("label") };
}

/** Shows the session label in the title and the thumbnail, as plain text. */
function showLabel(raw) {
  const label = [...raw.replace(HIDDEN_CHARACTERS, "").trim()].slice(0, LABEL_MAX_CHARS).join("");
  document.title = label === "" ? TITLE : `${label} \u00b7 ${TITLE}`;
  element("label").textContent = label;
  element("label").hidden = label === "";
}

function setStatus(status) {
  state.status = status;
  document.body.dataset.status = status;
  element("status-text").textContent = STATUS_TEXT[status];
}

function stopConnection() {
  clearTimeout(state.retryTimer);
  state.retryTimer = undefined;
  const rfb = state.rfb;
  state.rfb = null;
  state.socket = null;
  if (rfb !== null) {
    try {
      rfb.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

function finish(status) {
  stopConnection();
  setStatus(status);
}

function scheduleRetry(delayMs, status) {
  setStatus(status);
  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(connect, delayMs);
}

function backoffMs() {
  const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** state.attempts);
  state.attempts += 1;
  return delay;
}

function onSocketClose(socket, code) {
  if (state.socket !== socket) return;
  state.rfb = null;
  state.socket = null;
  if (FINAL_STATES.has(state.status)) return;
  if (code === CLOSE_CODES.sessionEnded) {
    finish("ended");
  } else if (code === CLOSE_CODES.shuttingDown) {
    finish("stopped");
  } else if (code === CLOSE_CODES.vncWritable) {
    scheduleRetry(WRITABLE_RETRY_MS, "control");
  } else if (code === CLOSE_CODES.vncUnavailable) {
    retryWithBackoff();
  } else {
    void probeThenRetry();
  }
}

function retryWithBackoff() {
  scheduleRetry(backoffMs(), state.connectedOnce ? "reconnecting" : "connecting");
}

/**
 * An abnormal close looks the same for a rejected token and an outage. A
 * restarted bridge has a new token and a new port, so ask before retrying.
 */
async function probeThenRetry() {
  setStatus(state.connectedOnce ? "reconnecting" : "connecting");
  let response;
  try {
    response = await fetch(STATUS_API_PATH, {
      headers: { Authorization: `Bearer ${state.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
  } catch {
    response = null;
  }
  if (FINAL_STATES.has(state.status)) return;
  if (response === null) {
    state.probeFailures += 1;
    if (state.probeFailures >= MAX_PROBE_FAILURES) {
      finish("stopped");
      return;
    }
  } else {
    state.probeFailures = 0;
    if (response.status === 401 || response.status === 403) {
      finish("expired");
      return;
    }
  }
  retryWithBackoff();
}

function configure(rfb) {
  rfb.viewOnly = true;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.focusOnClick = false;
  rfb.clipViewport = false;
  rfb.showDotCursor = false;
  rfb.background = "#0a0a0b";
}

function connect() {
  state.retryTimer = undefined;
  if (FINAL_STATES.has(state.status)) return;
  const url = `ws://${location.host}/websockify?token=${encodeURIComponent(state.token)}`;
  // Our own socket, handed to noVNC, so the page sees the close code.
  const socket = new WebSocket(url);
  socket.addEventListener("close", (event) => onSocketClose(socket, event.code));
  const rfb = new RFB(element("screen"), socket);
  configure(rfb);
  rfb.addEventListener("connect", () => {
    state.attempts = 0;
    state.connectedOnce = true;
    setStatus("live");
  });
  state.rfb = rfb;
  state.socket = socket;
}

function validDimension(value) {
  return Number.isInteger(value) && value > 0;
}

function validSize(size) {
  if (size === null || typeof size !== "object") return false;
  return validDimension(size.width) && validDimension(size.height);
}

/** Ask the bridge to resize the window; fall back to resizeTo elsewhere. */
async function requestWindow(mode) {
  let response;
  try {
    response = await fetch(`/api/launches/${state.launchId}/window`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode }),
      cache: "no-store",
    });
  } catch {
    return;
  }
  if (response.status === 401 || response.status === 403) {
    finish("expired");
    return;
  }
  if (!response.ok) return;
  const body = await response.json().catch(() => null);
  if (body === null || body.applied === true || !validSize(body.size)) return;
  window.resizeTo(
    Math.min(body.size.width, screen.availWidth),
    Math.min(body.size.height, screen.availHeight),
  );
}

function setMode(mode, resize) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  element("toolbar").hidden = mode !== "expanded";
  element("shield").title = mode === "expanded" ? "" : "Expand";
  writeStored("mode", mode);
  if (resize) void requestWindow(mode);
}

/** Capture phase: the event never reaches noVNC and never grants control. */
function onShieldEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  if (event.type === "click" && state.mode === "thumbnail") setMode("expanded", true);
}

function onKeyDown(event) {
  if (event.key === "Escape" && state.mode === "expanded") {
    event.preventDefault();
    setMode("thumbnail", true);
  }
}

function start() {
  const match = /^\/viewer\/([^/]+)$/.exec(location.pathname);
  state.launchId = match !== null && LAUNCH_ID_PATTERN.test(match[1]) ? match[1] : "";
  const fragment = state.launchId === "" ? { token: "", label: "" } : takeFragment();
  state.token = fragment.token;
  showLabel(fragment.label);
  const shield = element("shield");
  for (const type of SHIELDED_EVENTS) {
    shield.addEventListener(type, onShieldEvent, { capture: true, passive: false });
  }
  document.addEventListener("keydown", onKeyDown);
  element("collapse").addEventListener("click", () => setMode("thumbnail", true));
  if (state.token === "") {
    setStatus("expired");
    return;
  }
  const restored = readStored("mode") === "expanded" ? "expanded" : "thumbnail";
  setMode(restored, restored === "expanded");
  setStatus("connecting");
  connect();
}

start();
