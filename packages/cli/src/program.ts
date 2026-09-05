import { createRequire } from "node:module";
import { Command, Option } from "commander";
import type { PickforgeProfile, SessionType } from "@pickforge/lab-core";
import {
  runAndroidAdb,
  runAndroidBack,
  runAndroidHome,
  runAndroidInstallApk,
  runAndroidLaunchApp,
  runAndroidLogcat,
  runAndroidScreenshot,
  runAndroidTap,
  runAndroidType,
  runAndroidUiTree,
} from "./commands/android.js";
import {
  runArtifactsList,
  runArtifactsOpen,
  runArtifactsReport,
} from "./commands/artifacts.js";
import {
  runAgentsAdd,
  runAgentsDoctorCommand,
  runAgentsLink,
  runAgentsList,
  runAgentsUnlink,
} from "./commands/agents.js";
import { runBrowserDevtoolsMcp } from "./commands/browser.js";
import {
  runDesktopClick,
  runDesktopDoubleClick,
  runDesktopDrag,
  runDesktopEnv,
  runDesktopExec,
  runDesktopKey,
  runDesktopLaunch,
  runDesktopMove,
  runDesktopScreenshot,
  runDesktopScroll,
  runDesktopType,
} from "./commands/desktop.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runMcpServe } from "./commands/mcp.js";
import {
  runSessionCreate,
  runSessionDestroy,
  runSessionStatus,
} from "./commands/session.js";
import { runSetupAndroid } from "./commands/setup-android.js";
import { runSetupLabUser } from "./commands/setup-lab-user.js";
import { runTakeoverStatus, runTakeoverWatchdog } from "./commands/takeover.js";
import { runWatch } from "./commands/watch.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const PROFILES: PickforgeProfile[] = [
  "flutter-desktop",
  "android",
  "desktop+android",
  "generic",
];

const SESSION_TYPES: SessionType[] = [
  "desktop",
  "android",
  "desktop+android",
  "browser",
];

function withJson(command: Command): Command {
  return command.option("--json", "machine-readable output");
}

function withProjectDir(command: Command): Command {
  return command.option(
    "--project-dir <dir>",
    "project directory (defaults to cwd)",
  );
}

function withDesktopSession(command: Command): Command {
  return withProjectDir(
    command.option("--session <id>", "desktop session id"),
  );
}

function withAndroidTarget(command: Command): Command {
  return withProjectDir(
    command
      .option("--session <id>", "android session id")
      .option("--serial <serial>", "adb device serial"),
  );
}

const collectConfigPath = (value: string, previous: string[]): string[] => [
    ...previous,
    value,
  ];

function registerProvisioningCommands(program: Command): void {
  program
    .command("doctor")
    .description("Check dependencies and dedicated lab resources")
    .option("--json", "machine-readable output")
    .option("--fix", "apply repairs (privileged ones need --yes or a prompt)")
    .option("--yes", "consent to privileged repairs without prompting")
    .option("--dry-run", "print planned repairs without executing them")
    .option("--project-dir <dir>", "project directory for config resolution")
    .action(async (opts) => {
      process.exitCode = await runDoctor(opts);
    });

  program
    .command("init")
    .description("Initialize a Pickforge project and provision lab resources")
    .addOption(
      new Option("--profile <profile>", "project profile").choices(PROFILES),
    )
    .option("--yes", "non-interactive mode; fails closed when provisioning is impossible")
    .option("--create-lab-user", "provision the dedicated lab user")
    .option("--create-avd", "provision the dedicated Android AVD")
    .option("--dry-run", "print the provisioning plan without executing it")
    .option("--json", "machine-readable output")
    .option("--project-dir <dir>", "project directory (defaults to cwd)")
    .action(async (opts) => {
      process.exitCode = await runInit(opts);
    });

  const setup = program
    .command("setup")
    .description("Provision dedicated Pickforge lab resources");

  setup
    .command("lab-user")
    .description("Create the dedicated locked lab user (uses sudo)")
    .option("--name <name>", "lab user name")
    .option("--home <dir>", "lab user home directory")
    .option("--yes", "do not prompt for confirmation")
    .option("--dry-run", "print the provisioning plan without executing it")
    .option("--json", "machine-readable output")
    .action(async (opts) => {
      process.exitCode = await runSetupLabUser(opts);
    });

  setup
    .command("android")
    .description("Detect the Android toolchain and create the dedicated AVD")
    .option("--create-avd", "create the dedicated AVD")
    .option("--avd-name <name>", "AVD name")
    .option("--system-image <id>", 'system image id, e.g. "system-images;android-35;google_apis;x86_64"')
    .option("--yes", "do not prompt for confirmation")
    .option("--dry-run", "print the provisioning plan without executing it")
    .option("--json", "machine-readable output")
    .action(async (opts) => {
      process.exitCode = await runSetupAndroid(opts);
    });
}

function registerSessionCommands(program: Command): void {
  const session = program
    .command("session")
    .description("Manage desktop, browser, and Android lab sessions");

  withJson(
    withProjectDir(
      session
        .command("create")
        .description("Create a desktop, browser, and/or Android session")
        .addOption(
          new Option("--type <type>", "session type")
            .choices(SESSION_TYPES)
            .makeOptionMandatory(),
        )
        .option("--width <pixels>", "desktop display width")
        .option("--height <pixels>", "desktop display height")
        .option("--vnc", "expose the desktop display over read-only VNC")
        .option(
          "--vnc-control",
          "expose writable VNC for explicit manual secret entry (not coordinated)",
        )
        .option("--avd-name <name>", "Android AVD name")
        .option("--cold-boot", "skip the AVD's saved state (emulator -no-snapshot-load)")
        .option(
          "--read-only",
          "share the AVD with another running emulator (emulator -read-only)",
        )
        .option("--viewer", "open a read-only host viewer after creation")
        .option(
          "--no-viewer",
          "do not open a viewer, overriding viewer.mode=auto",
        ),
    ),
  ).action(async (opts) => {
    process.exitCode = await runSessionCreate(opts);
  });

  withJson(
    session
      .command("status")
      .description("Show liveness for one or all sessions")
      .argument("[id]", "session id"),
  ).action(async (id, opts) => {
    process.exitCode = await runSessionStatus(id, opts);
  });

  withJson(
    session
      .command("destroy")
      .description("Destroy a session and stop its processes")
      .argument("[id]", "session id")
      .option("--all", "destroy all sessions"),
  ).action(async (id, opts) => {
    process.exitCode = await runSessionDestroy(id, opts);
  });
}

function registerWatchAndBrowserCommands(program: Command): void {
  withJson(
    withDesktopSession(
      program
        .command("watch")
        .description("Watch a running desktop-capable session read-only")
        .option(
          "--control",
          "pause agent input and grant a temporary writable viewer (supervised human takeover)",
        ),
    ),
  ).action(async (opts) => {
    process.exitCode = await runWatch(opts);
  });

  const takeover = program
    .command("takeover")
    .description("Inspect supervised human-takeover state for a session");

  withJson(
    withDesktopSession(
      takeover
        .command("status")
        .description("Show whether a session is under human control"),
    ),
  ).action(async (opts) => {
    process.exitCode = await runTakeoverStatus(opts);
  });

  // Internal, undocumented commands spawned by pickforge-lab itself — not a
  // supported public CLI surface.
  const internal = program.command("internal", { hidden: true });

  internal
    .command("takeover-watchdog")
    .description(
      "Actively reclaim a writable VNC session if its human lease goes " +
        "stale; spawned detached by `watch --control`, not meant to be run directly",
    )
    .requiredOption("--session <id>", "session id")
    .requiredOption("--lease <leaseId>", "lease id to watch")
    .option("--interval <ms>", "poll interval in ms")
    .action(async (opts) => {
      process.exitCode = await runTakeoverWatchdog(opts);
    });

  const browser = program
    .command("browser")
    .description("Connect agent browser tooling to the active Pickforge browser");

  browser
    .command("devtools-mcp")
    .description("Relay Chrome DevTools MCP over stdio")
    .option("--project-dir <dir>", "project directory (defaults to cwd)")
    .action(async (opts) => {
      process.exitCode = await runBrowserDevtoolsMcp(opts);
    });
}

function registerDesktopLaunchCommands(desktop: Command): void {
  withJson(
    withDesktopSession(
      desktop
        .command("launch")
        .description("Launch an app inside the desktop session")
        .argument("<command>", "executable to launch")
        .argument("[args...]", "arguments for the executable (use -- before flags)")
        .option("--cwd <dir>", "working directory for the app")
        .option(
          "--wait-window <pattern>",
          "wait for a window whose name contains the pattern",
        ),
    ),
  ).action(async (command, args, opts) => {
    process.exitCode = await runDesktopLaunch(command, args, opts);
  });

  withJson(
    withDesktopSession(
      desktop
        .command("exec")
        .description(
          "Start a command in the desktop session and wait for a client window",
        )
        .argument("<command>", "executable to start")
        .argument("[args...]", "arguments for the executable (use -- before flags)")
        .option("--cwd <dir>", "working directory for the command")
        .option(
          "--window-timeout <ms>",
          "maximum time to wait for a client window (default 30000)",
        ),
    ),
  ).action(async (command, args, opts) => {
    process.exitCode = await runDesktopExec(command, args, opts);
  });

  withJson(
    withDesktopSession(
      desktop
        .command("env")
        .description("Print shell exports and unsets for the desktop session"),
    ),
  ).action(async (opts) => {
    process.exitCode = await runDesktopEnv(opts);
  });

  withJson(
    withDesktopSession(
      desktop
        .command("screenshot")
        .description("Capture the desktop display into a run (or --out path)")
        .option("--out <path>", "write to an explicit path instead of a run")
        .option("--run <slug>", "run slug (default: desktop)"),
    ),
  ).action(async (opts) => {
    process.exitCode = await runDesktopScreenshot(opts);
  });
}

function registerDesktopPointerCommands(desktop: Command): void {
  withJson(
    withDesktopSession(
      desktop
        .command("click")
        .description("Click at the given coordinates")
        .argument("<x>", "x coordinate")
        .argument("<y>", "y coordinate")
        .option("--button <n>", "mouse button (1-9, default 1)"),
    ),
  ).action(async (x, y, opts) => {
    process.exitCode = await runDesktopClick(x, y, opts);
  });

  withJson(
    withDesktopSession(
      desktop
        .command("move")
        .description("Move the pointer to the given coordinates (hover)")
        .argument("<x>", "x coordinate")
        .argument("<y>", "y coordinate"),
    ),
  ).action(async (x, y, opts) => {
    process.exitCode = await runDesktopMove(x, y, opts);
  });

  withJson(
    withDesktopSession(
      desktop
        .command("scroll")
        .description(
          "Scroll by wheel steps (positive deltaY: down, negative: up; " +
            "positive deltaX: right; use -- before negative values)",
        )
        .argument("<deltaX>", "horizontal wheel steps (positive: right)")
        .argument("<deltaY>", "vertical wheel steps (positive: down)")
        .option("--at <x,y>", "move the pointer there before scrolling"),
    ),
  ).action(async (deltaX, deltaY, opts) => {
    process.exitCode = await runDesktopScroll(deltaX, deltaY, opts);
  });
}

function registerDesktopInputCommands(desktop: Command): void {
  withJson(
    withDesktopSession(
      desktop
        .command("drag")
        .description("Press, move, and release the mouse between two points")
        .argument("<fromX>", "start x coordinate")
        .argument("<fromY>", "start y coordinate")
        .argument("<toX>", "end x coordinate")
        .argument("<toY>", "end y coordinate")
        .option("--button <n>", "mouse button (1-9, default 1)")
        .option("--duration <ms>", "total drag duration in ms (default 300)"),
    ),
  ).action(async (fromX, fromY, toX, toY, opts) => {
    process.exitCode = await runDesktopDrag(fromX, fromY, toX, toY, opts);
  });

  withJson(
    withDesktopSession(
      desktop
        .command("double-click")
        .description("Double-click at the given coordinates")
        .argument("<x>", "x coordinate")
        .argument("<y>", "y coordinate")
        .option("--button <n>", "mouse button (1-9, default 1)")
        .option("--interval <ms>", "delay between the clicks in ms (default 100)"),
    ),
  ).action(async (x, y, opts) => {
    process.exitCode = await runDesktopDoubleClick(x, y, opts);
  });

  withJson(
    withDesktopSession(
      desktop
        .command("type")
        .description("Type text into the focused window")
        .argument("<text>", "text to type"),
    ),
  ).action(async (text, opts) => {
    process.exitCode = await runDesktopType(text, opts);
  });

  withJson(
    withDesktopSession(
      desktop
        .command("key")
        .description('Press a key or chord (e.g. "Return", "ctrl+s")')
        .argument("<keys>", "key or chord to press"),
    ),
  ).action(async (keys, opts) => {
    process.exitCode = await runDesktopKey(keys, opts);
  });
}

function registerDesktopCommands(program: Command): void {
  const desktop = program
    .command("desktop")
    .description("Drive the desktop (X11) lab session");
  registerDesktopLaunchCommands(desktop);
  registerDesktopPointerCommands(desktop);
  registerDesktopInputCommands(desktop);
}

function registerAndroidSessionCommands(android: Command): void {
  withJson(
    withProjectDir(
      android
        .command("start")
        .description("Start an Android emulator session (alias for session create)")
        .option("--avd-name <name>", "Android AVD name")
        .option("--cold-boot", "skip the AVD's saved state (emulator -no-snapshot-load)")
        .option(
          "--read-only",
          "share the AVD with another running emulator (emulator -read-only)",
        ),
    ),
  ).action(async (opts) => {
    process.exitCode = await runSessionCreate({ ...opts, type: "android" });
  });

  withJson(
    withAndroidTarget(
      android
        .command("install-apk")
        .description("Install an APK on the device")
        .argument("<apk>", "path to the APK")
        .option(
          "--wait-ready <seconds>",
          "wait until guest lowmemorykiller is quiet before installing (default: no wait)",
        ),
    ),
  ).action(async (apk, opts) => {
    process.exitCode = await runAndroidInstallApk(apk, opts);
  });

  withJson(
    withAndroidTarget(
      android
        .command("launch-app")
        .description("Launch an app by package name")
        .argument("<package>", "application package name")
        .option("--activity <activity>", 'activity to start (e.g. ".MainActivity")')
        .option(
          "--wait-ready <seconds>",
          "wait until guest lowmemorykiller is quiet before launching (default: no wait)",
        ),
    ),
  ).action(async (packageName, opts) => {
    process.exitCode = await runAndroidLaunchApp(packageName, opts);
  });

  withJson(
    withAndroidTarget(
      android
        .command("screenshot")
        .description("Capture the device screen into a run (or --out path)")
        .option("--out <path>", "write to an explicit path instead of a run")
        .option("--run <slug>", "run slug (default: android)"),
    ),
  ).action(async (opts) => {
    process.exitCode = await runAndroidScreenshot(opts);
  });
}

function registerAndroidInputCommands(android: Command): void {
  withJson(
    withAndroidTarget(
      android
        .command("tap")
        .description("Tap at the given coordinates")
        .argument("<x>", "x coordinate")
        .argument("<y>", "y coordinate"),
    ),
  ).action(async (x, y, opts) => {
    process.exitCode = await runAndroidTap(x, y, opts);
  });

  withJson(
    withAndroidTarget(
      android
        .command("type")
        .description("Type text into the focused field")
        .argument("<text>", "text to type"),
    ),
  ).action(async (text, opts) => {
    process.exitCode = await runAndroidType(text, opts);
  });

  withJson(
    withAndroidTarget(
      android.command("back").description("Press the back button"),
    ),
  ).action(async (opts) => {
    process.exitCode = await runAndroidBack(opts);
  });

  withJson(
    withAndroidTarget(
      android.command("home").description("Press the home button"),
    ),
  ).action(async (opts) => {
    process.exitCode = await runAndroidHome(opts);
  });
}

function registerAndroidDiagnosticCommands(android: Command): void {
  withJson(
    withAndroidTarget(
      android
        .command("ui-tree")
        .description("Dump the UI hierarchy as XML")
        .option("--out <path>", "write the XML to a file instead of stdout"),
    ),
  ).action(async (opts) => {
    process.exitCode = await runAndroidUiTree(opts);
  });

  withJson(
    withAndroidTarget(
      android
        .command("logcat")
        .description("Dump (or --clear) the device log with secrets redacted")
        .option("--lines <n>", "number of recent lines (default 500)")
        .option("--filter <spec>", 'logcat filter spec, e.g. "ActivityManager:I *:S"')
        .option("--clear", "clear the log buffer instead of dumping it"),
    ),
  ).action(async (opts) => {
    process.exitCode = await runAndroidLogcat(opts);
  });

  withJson(
    withAndroidTarget(
      android
        .command("adb")
        .description(
          "Run a raw adb command (put adb flags after --); output is not redacted",
        )
        .argument("[args...]", "adb arguments"),
    ),
  ).action(async (args, opts) => {
    process.exitCode = await runAndroidAdb(args, opts);
  });
}

function registerAndroidCommands(program: Command): void {
  const android = program
    .command("android")
    .description("Drive the Android emulator lab session");
  registerAndroidSessionCommands(android);
  registerAndroidInputCommands(android);
  registerAndroidDiagnosticCommands(android);
}

function registerArtifactCommands(program: Command): void {
  const artifacts = program
    .command("artifacts")
    .description(
      "Inspect recorded run artifacts (default storage: ~/.pickforge/lab)",
    );

  withJson(
    withProjectDir(
      artifacts.command("list").description("List recorded runs"),
    ),
  ).action(async (opts) => {
    process.exitCode = await runArtifactsList(opts);
  });

  withJson(
    withProjectDir(
      artifacts
        .command("open")
        .description("Print (and open, when a display is available) a run directory")
        .argument("<runId>", "run id"),
    ),
  ).action(async (runId, opts) => {
    process.exitCode = await runArtifactsOpen(runId, opts);
  });

  withJson(
    withProjectDir(
      artifacts
        .command("report")
        .description("Render a report for a run (default: latest)")
        .argument("[runId]", "run id"),
    ),
  ).action(async (runId, opts) => {
    process.exitCode = await runArtifactsReport(runId, opts);
  });
}

function registerAgentListCommands(agents: Command): void {
  withJson(
    agents
      .command("list")
      .description("List known agents and their registration status")
      .option(
        "--config-path <agent>=<path>",
        "agent config file override, repeatable (e.g. cursor=/tmp/mcp.json)",
        collectConfigPath,
        [] as string[],
      ),
  ).action(async (opts) => {
    process.exitCode = await runAgentsList(opts);
  });
}

function registerAgentLinkCommands(agents: Command): void {
  for (const [verb, description] of [
    ["install", "Register the pickforge-lab MCP server with an agent"],
    ["link", "Register the pickforge-lab MCP server with an agent (alias of install)"],
  ] as const) {
    withJson(
      agents
        .command(verb)
        .description(description)
        .argument("<agent>", "agent name (codex, claude-code, cursor, pi)")
        .option(
          "--config-path <path>",
          "agent config file (overrides the default location)",
        ),
    ).action(async (agent, opts) => {
      process.exitCode = await runAgentsLink(agent, opts);
    });
  }

  withJson(
    agents
      .command("unlink")
      .description("Remove the pickforge-lab MCP server entry from an agent config")
      .argument("<agent>", "agent name (codex, claude-code, cursor, pi, or custom)")
      .option(
        "--config-path <path>",
        "agent config file (overrides the default location)",
      ),
  ).action(async (agent, opts) => {
    process.exitCode = await runAgentsUnlink(agent, opts);
  });
}

function registerAgentDoctorCommands(agents: Command): void {
  withJson(
    agents
      .command("doctor")
      .description(
        "Check agent registrations for broken symlinks and stale config",
      )
      .option(
        "--config-path <agent>=<path>",
        "agent config file override, repeatable (e.g. cursor=/tmp/mcp.json)",
        collectConfigPath,
        [] as string[],
      ),
  ).action(async (opts) => {
    process.exitCode = await runAgentsDoctorCommand(opts);
  });

  withJson(
    agents
      .command("add")
      .description("Store a custom agent MCP config snippet under the Pickforge home's agents dir")
      .requiredOption("--name <name>", "custom agent name")
      .requiredOption(
        "--mcp-command <command>",
        'MCP server command, split on whitespace (e.g. "pickforge-lab mcp serve")',
      )
      .option("--force", "overwrite an existing custom agent with the same name"),
  ).action(async (opts) => {
    process.exitCode = await runAgentsAdd(opts);
  });
}

function registerAgentCommands(program: Command): void {
  const agents = program
    .command("agents")
    .description("Register the Pickforge MCP server with coding agents");
  registerAgentListCommands(agents);
  registerAgentLinkCommands(agents);
  registerAgentDoctorCommands(agents);
}

function registerMcpCommands(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Model Context Protocol server");

  mcp
    .command("serve")
    .description("Serve Pickforge tools over MCP (stdio)")
    .action(async () => {
      process.exitCode = await runMcpServe();
    });
}

export function buildProgram(): Command {
  const program = new Command()
    .name("pickforge-lab")
    .description(
      "Native app and Android emulator automation for AI coding agents",
    )
    .version(version);

  registerProvisioningCommands(program);
  registerSessionCommands(program);
  registerWatchAndBrowserCommands(program);
  registerDesktopCommands(program);
  registerAndroidCommands(program);
  registerArtifactCommands(program);
  registerAgentCommands(program);
  registerMcpCommands(program);
  return program;
}
