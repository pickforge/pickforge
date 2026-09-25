import type { McpServer } from "@modelcontextprotocol/server";
import { DEVICE_PASS_WORKFLOW } from "@pickforge/lab-core";
import { z } from "zod";

function userMessage(text: string): {
  messages: Array<{
    role: "user";
    content: { type: "text"; text: string };
  }>;
} {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

const HUMAN_BLOCKER_GUIDELINE =
  "If you become blocked on anything that requires a human — credentials, " +
  "license keys, 2FA, a judgment call, or a click you cannot perform — use " +
  "the `request_user_input` tool (or ask in your conversation) and WAIT " +
  "for the answer. Never guess credentials and never abandon the session; " +
  "report what you need.";

function registerPrompt1(server: McpServer): void {
  server.registerPrompt(
    "test-flutter-desktop-visually",
    {
      title: "Test a desktop app visually",
      description:
        "Build a Flutter (or any Linux) desktop app, run it in an isolated " +
        "Pickforge desktop session, and verify it visually with screenshots.",
      argsSchema: {
        appCommand: z
          .string()
          .optional()
          .describe(
            "Command that starts the app (default: the project's release binary)",
          ),
        windowTitle: z
          .string()
          .optional()
          .describe("Window title (or fragment) to wait for after launch"),
      },
    },
    ({ appCommand, windowTitle }) =>
      userMessage(
        [
          "Visually test the desktop app in an isolated Pickforge session:",
          "",
          "1. Build the app first (for Flutter: `flutter build linux`). Fix any build errors before continuing.",
          '2. Create an isolated display with the `session_create` tool (type "desktop"). Note the returned session id.',
          `3. Launch the app with \`desktop_launch\` using command ${
            appCommand === undefined
              ? "set to the built app binary (for Flutter: build/linux/x64/release/bundle/<app>)"
              : `\`${appCommand}\``
          } and arguments as an array.${
            windowTitle === undefined
              ? " Use waitWindow with the app's window title so the launch blocks until the UI is up."
              : ` Use waitWindow \`${windowTitle}\` so the launch blocks until the UI is up.`
          }`,
          "4. Capture the screen with `desktop_screenshot` and inspect the returned image. Check that the UI matches what the code should render: layout, labels, colors, missing assets.",
          "5. Drive the app like a user: `desktop_click`/`desktop_double_click` at widget coordinates, `desktop_move` to hover, `desktop_scroll` for wheel scrolling (positive deltaY scrolls down), `desktop_drag` to drag between points, `desktop_type` to fill fields, and `desktop_key` for keys/chords (Return, Tab, ctrl+s). Take a screenshot after each meaningful interaction to confirm the result.",
          "6. If something looks wrong, fix the code, rebuild, relaunch inside the same session, and re-verify with new screenshots.",
          "7. When finished, destroy the session with `session_destroy` and summarize what you verified. Use `artifact_report` to reference the captured screenshots.",
          "",
          "Never run the app on the user's real display; always work inside the Pickforge session.",
          HUMAN_BLOCKER_GUIDELINE,
        ].join("\n"),
      ),
  );
}

function registerPrompt2(server: McpServer): void {
  server.registerPrompt(
    "debug-android-apk",
    {
      title: "Debug an Android APK",
      description:
        "Install an APK in the Pickforge Android emulator, drive its UI, and " +
        "debug it with logcat and UI-tree dumps.",
      argsSchema: {
        apkPath: z.string().describe("Path to the APK to debug"),
        packageName: z
          .string()
          .optional()
          .describe('Application package name, e.g. "com.example.app"'),
      },
    },
    ({ apkPath, packageName }) =>
      userMessage(
        [
          "Debug the Android app inside the Pickforge emulator lab:",
          "",
          "1. Start an emulator session with the `android_start` tool (or `session_create` with type \"android\"). Wait for it to report a device serial.",
          `2. Install the APK with \`android_install_apk\` using apkPath \`${apkPath}\`.`,
          "3. Clear old logs with `android_logcat` (clear=true) so later output only shows this debugging session.",
          `4. Launch the app with \`android_launch_app\`${
            packageName === undefined
              ? " using its package name"
              : ` using packageName \`${packageName}\``
          }.`,
          "5. Capture the screen with `android_screenshot` and dump the widget hierarchy with `android_get_ui_tree`. Use the XML bounds to compute tap coordinates.",
          "6. Reproduce the issue: `android_tap` on widgets, `android_type` for text fields, `android_back`/`android_home` for navigation. Screenshot after each step.",
          "7. Read `android_logcat` output (it is secret-redacted) and look for exceptions, ANRs, or suspicious log lines from the app process.",
          "8. For anything else (e.g. `pm list packages`, `dumpsys`), use `android_run_adb` with an argument array.",
          "9. Fix the code, rebuild the APK, reinstall with `android_install_apk`, and verify the fix the same way.",
          "10. Destroy the session with `session_destroy` when done and summarize the root cause and fix.",
          "",
          HUMAN_BLOCKER_GUIDELINE,
        ].join("\n"),
      ),
  );
}

function registerPrompt3(server: McpServer): void {
  server.registerPrompt(
    "run-visual-regression-check",
    {
      title: "Run a visual regression check",
      description:
        "Capture fresh screenshots of the app in a Pickforge session and " +
        "compare them against a baseline directory.",
      argsSchema: {
        baselineDir: z
          .string()
          .describe("Directory holding the baseline screenshots"),
        appCommand: z
          .string()
          .optional()
          .describe("Command that starts the app"),
      },
    },
    ({ baselineDir, appCommand }) =>
      userMessage(
        [
          "Run a visual regression check against the baseline screenshots:",
          "",
          `1. List the baseline images in \`${baselineDir}\` to learn which screens are covered and their file names.`,
          '2. Create an isolated display with `session_create` (type "desktop") sized to match the baselines.',
          `3. Launch the app with \`desktop_launch\`${
            appCommand === undefined ? "" : ` using command \`${appCommand}\``
          } and wait for its window.`,
          "4. For each baseline screen: navigate to the same state (`desktop_click`, `desktop_scroll`, `desktop_type`, `desktop_key`), then capture it with `desktop_screenshot` using a runSlug matching the baseline name.",
          "5. Compare each captured screenshot with its baseline. Prefer a pixel diff (e.g. ImageMagick `compare -metric AE`) when available; otherwise inspect both images and describe differences in layout, text, color, and spacing.",
          "6. Collect the verdict per screen: unchanged, intentionally changed, or regression. For regressions, include the run id and the differing region.",
          "7. Destroy the session with `session_destroy`, then report results with `artifact_report` so every captured screenshot is referenced.",
          `8. Only update files in \`${baselineDir}\` if the user confirms the new rendering is intended.`,
          "",
          HUMAN_BLOCKER_GUIDELINE,
        ].join("\n"),
      ),
  );
}

function registerDevicePassPrompt(server: McpServer): void {
  server.registerPrompt(
    "device_pass",
    {
      title: "Run a device pass",
      description: "Interact with a rendered journey, inspect its screenshots, and record acceptance.",
      argsSchema: {
        scenario: z.string().describe("Scoped user journey to test"),
        revision: z.string().optional().describe("Revision under test"),
        device: z.string().optional().describe("Target device and viewports"),
      },
    },
    ({ scenario, revision, device }) =>
      userMessage(
        `Scenario: ${scenario}\nRevision: ${revision ?? "unknown"}\nDevice: ${device ?? "unknown"}\n\n${DEVICE_PASS_WORKFLOW}`,
      ),
  );
}

function registerFlutterComponentPreviewPrompt(server: McpServer): void {
  server.registerPrompt(
    "preview-flutter-component",
    {
      title: "Preview a Flutter component",
      description:
        "Render and verify one Flutter widget in isolation, without the full " +
        "app, auth, routing, or backend, across states and viewports.",
      argsSchema: {
        widget: z
          .string()
          .describe('Target widget, e.g. "ProfileCard in lib/profile/profile_card.dart"'),
        states: z
          .string()
          .optional()
          .describe("States and data to render (default: normal plus stress states)"),
        viewports: z
          .string()
          .optional()
          .describe("Logical widths to capture (default: 390, 768, 1440 at DPR 1)"),
      },
    },
    ({ widget, states, viewports }) =>
      userMessage(
        [
          `Preview the Flutter widget \`${widget}\` in isolation, without starting the full app, auth, routing, or backend.`,
          "",
          `States: ${states ?? "normal plus stress states: long, empty, and error content where they apply"}`,
          `Viewports: ${viewports ?? "390, 768, and 1440 logical pixels at DPR 1, unless the project says otherwise"}`,
          "",
          "1. Record `git status --short` as the baseline. Then discover before generating anything: the Flutter command (use `fvm flutter` when the repo has `.fvmrc`), the SDK version, the widget's constructor, and the theme, localization delegates, providers or inherited widgets, router and media dependencies, fonts, and assets it needs. Reuse existing test wrappers, builders, and fixtures; do not create a second app or test convention.",
          "2. Choose lanes by purpose:",
          "   a. Widget Previewer, preferred for interactive visual iteration when the SDK supports `flutter widget-preview start`. Write a temporary `@Preview` adapter that wraps the widget in the app's real theme, localizations, and inherited dependencies.",
          "   b. Widget-test capture harness, always used for the checks: deterministic state matrices, exact logical sizes, overflow, semantics, and text scaling. Write a temporary test that sets the view size and DPR, pumps each state, and fails on overflow or any exception from `tester.takeException()`. It can also write captures outside the source tree when Chromium pixels are not needed.",
          "   c. Temporary web entrypoint, only when the previewer is unavailable or cannot host the widget.",
          "3. Track every path you create. Prefer paths outside the source tree. When Flutter needs a Dart file inside the package, use a unique name, confirm it did not exist, and record it for cleanup. Never modify production routing, app startup, committed feature code, existing golden baselines, or files you did not create.",
          '4. Serve visual lanes from your own shell so the Flutter command and pub cache resolve: `flutter widget-preview start --web-server` for the previewer, or `flutter run -d web-server` for the web entrypoint, both on loopback. View the printed URL in a `session_create` (type "browser") session, which has a private profile: `desktop_key` ctrl+l, `desktop_type` the URL, then `desktop_key` Return. Never open it in the user\'s browser or on the user\'s real display. Chrome cannot shrink to phone widths, so give each viewport its own preview or route that wraps the widget in a `MediaQuery` and `SizedBox` at the requested logical size. Capture each state and viewport with `desktop_screenshot`, using a runSlug that names the state and width, and inspect every image.',
          "5. In the widget-test harness, check each state for text scaling (at least 1.0 and 2.0), semantics labels, the tap target and text contrast guidelines (`meetsGuideline`), overflow and exceptions, and every responsive breakpoint the widget has. Use real project fonts and assets. Report rendering that is not deterministic or that differs between the widget-test and Chromium engines.",
          "6. Keep generated adapters, tests, screenshots, and logs temporary. Add permanent previews or golden baselines only if the user asks for them, and never accept or update goldens automatically.",
          "7. Clean up in every outcome, including failure: stop the previewer or server, destroy the session with `session_destroy`, and delete only the paths you recorded. If a run is interrupted, print the exact paths and commands still needed to clean up.",
          "8. Confirm `git status --short` matches the baseline. Then report evidence for each requested state and viewport: screenshot paths or run ids, check results, and anything you could not verify. Use `artifact_report` for captured runs and record the verdict with `evidence_outcome`.",
          "",
          HUMAN_BLOCKER_GUIDELINE,
        ].join("\n"),
      ),
  );
}

export function registerPrompts(server: McpServer): void {
  registerPrompt1(server);
  registerPrompt2(server);
  registerPrompt3(server);
  registerDevicePassPrompt(server);
  registerFlutterComponentPreviewPrompt(server);
}
