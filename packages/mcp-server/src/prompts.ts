import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

// eslint-disable-next-line max-lines-per-function -- Legacy gate debt: pickforge/pickforge#60
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "test-flutter-desktop-visually",
    {
      title: "Test a desktop app visually",
      description:
        "Build a Flutter (or any Linux) desktop app, run it in an isolated " +
        "PickLab desktop session, and verify it visually with screenshots.",
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
          "Visually test the desktop app in an isolated PickLab session:",
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
          "Never run the app on the user's real display; always work inside the PickLab session.",
          HUMAN_BLOCKER_GUIDELINE,
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "debug-android-apk",
    {
      title: "Debug an Android APK",
      description:
        "Install an APK in the PickLab Android emulator, drive its UI, and " +
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
          "Debug the Android app inside the PickLab emulator lab:",
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

  server.registerPrompt(
    "run-visual-regression-check",
    {
      title: "Run a visual regression check",
      description:
        "Capture fresh screenshots of the app in a PickLab session and " +
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
