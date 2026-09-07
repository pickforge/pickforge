const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"]);
const RESERVED_ARG_PREFIXES = [
  "--profile-directory",
  "--remote-debugging-address",
  "--remote-debugging-pipe",
  "--remote-debugging-port",
  "--user-data-dir",
] as const;

function assertSafeStartUrl(url: string): void {
  if (url === "about:blank") return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid browser start URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Refusing browser start URL with unsupported protocol: ${parsed.protocol}`,
    );
  }
}

function assertSafeExtraArgs(args: string[]): void {
  for (const arg of args) {
    if (RESERVED_ARG_PREFIXES.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`))) {
      throw new Error(`Browser extraArgs cannot override reserved option: ${arg}`);
    }
  }
}

export interface BuildChromeArgsOptions {
  /** Chrome `--user-data-dir`; the ephemeral profile. */
  profileDir: string;
  /** CDP bind address; must be loopback. Defaults to `127.0.0.1`. */
  cdpAddress?: string;
  width?: number;
  height?: number;
  /** Disable Chrome's own sandbox. Off by default; only for constrained hosts. */
  noSandbox?: boolean;
  startUrl?: string;
  extraArgs?: string[];
}

/**
 * Build the argv array for a headed Chrome launched inside a private Xvfb.
 *
 * The DevTools endpoint uses an OS-assigned port (`--remote-debugging-port=0`)
 * bound explicitly to loopback, so two concurrent sessions never collide and
 * the endpoint is never reachable off-host. The port is discovered afterwards
 * by reading `<profile>/DevToolsActivePort`.
 */
export function buildChromeArgs(opts: BuildChromeArgsOptions): string[] {
  if (opts.profileDir === "") {
    throw new Error("buildChromeArgs requires a non-empty profileDir");
  }
  const address = opts.cdpAddress ?? "127.0.0.1";
  if (!LOOPBACK_ADDRESSES.has(address)) {
    throw new Error(
      `Refusing to bind the DevTools endpoint to non-loopback address "${address}"`,
    );
  }
  const startUrl = opts.startUrl ?? "about:blank";
  assertSafeStartUrl(startUrl);
  if (opts.extraArgs !== undefined) {
    assertSafeExtraArgs(opts.extraArgs);
  }
  const args = [
    `--user-data-dir=${opts.profileDir}`,
    "--remote-debugging-port=0",
    `--remote-debugging-address=${address}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--disable-notifications",
    // Internal policy invalidations start GCM even with sync and Web Push off.
    // Chromium has no GCM kill switch; sink all three transports on loopback.
    "--gcm-checkin-url=https://127.0.0.1:0",
    "--gcm-registration-url=https://127.0.0.1:0",
    "--gcm-mcs-endpoint=https://127.0.0.1:0",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    // Background networking is not a firewall. Disable independent vendor services
    // explicitly; see README's browser lab section for Chromium switch sources.
    "--disable-features=Translate,MediaRouter,AutofillServerCommunication,OptimizationHints,OptimizationTargetPrediction,OptimizationGuideModelExecution",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--password-store=basic",
    "--use-mock-keychain",
  ];
  if (opts.width !== undefined && opts.height !== undefined) {
    args.push(`--window-size=${opts.width},${opts.height}`);
  }
  if (opts.noSandbox === true) {
    args.push("--no-sandbox");
  }
  if (opts.extraArgs !== undefined) {
    args.push(...opts.extraArgs);
  }
  args.push(startUrl);
  return args;
}
