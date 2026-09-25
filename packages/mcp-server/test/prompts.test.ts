import { DEVICE_PASS_SUMMARY, DEVICE_PASS_WORKFLOW } from "@pickforge/lab-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectLab,
  makeLabDirs,
  removeLabDirs,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

let dirs: LabDirs;
let lab: ConnectedLab;

beforeAll(async () => {
  dirs = makeLabDirs();
  lab = await connectLab({
    projectDir: dirs.projectDir,
    env: { PICKFORGE_HOME: dirs.home, PATH: dirs.binDir },
  });
});

afterAll(async () => {
  await lab.close();
  removeLabDirs(dirs);
});

function promptText(result: {
  messages: Array<{ content: unknown }>;
}): string {
  const content = result.messages[0]?.content as { type: string; text: string };
  expect(content.type).toBe("text");
  return content.text;
}

describe("prompts", () => {
  it("lists the workflow prompts with arguments", async () => {
    const { prompts } = await lab.client.listPrompts();
    const byName = new Map(prompts.map((prompt) => [prompt.name, prompt]));
    expect([...byName.keys()].sort()).toEqual([
      "debug-android-apk",
      "device_pass",
      "preview-flutter-component",
      "run-visual-regression-check",
      "test-flutter-desktop-visually",
    ]);
    expect(byName.get("device_pass")?.arguments).toEqual([
      expect.objectContaining({ name: "scenario", required: true }),
      expect.objectContaining({ name: "revision", required: false }),
      expect.objectContaining({ name: "device", required: false }),
    ]);
    expect(
      byName
        .get("debug-android-apk")
        ?.arguments?.map((argument) => argument.name),
    ).toContain("apkPath");
    expect(
      byName
        .get("run-visual-regression-check")
        ?.arguments?.map((argument) => argument.name),
    ).toContain("baselineDir");
    expect(
      byName
        .get("test-flutter-desktop-visually")
        ?.arguments?.map((argument) => argument.name),
    ).toContain("appCommand");
    expect(byName.get("preview-flutter-component")?.arguments).toEqual([
      expect.objectContaining({ name: "widget", required: true }),
      expect.objectContaining({ name: "states", required: false }),
      expect.objectContaining({ name: "viewports", required: false }),
    ]);
  });

  it("delivers short acceptance instructions during initialization", () => {
    const instructions = lab.client.getInstructions();
    expect(instructions).toBe(DEVICE_PASS_SUMMARY);
    expect(instructions).toContain("Pass is refused without a successful interaction and an inspected screenshot");
    expect(instructions).toContain("evidence_outcome");
    expect(instructions).toContain("device_pass");
    expect(instructions).not.toBe(DEVICE_PASS_WORKFLOW);
  });

  it("renders the device pass with its arguments as a user message", async () => {
    const result = await lab.client.getPrompt({
      name: "device_pass",
      arguments: { scenario: "Checkout", revision: "abc123", device: "mobile 390x844" },
    });
    expect(result.messages).toEqual([{
      role: "user",
      content: { type: "text", text: `Scenario: Checkout\nRevision: abc123\nDevice: mobile 390x844\n\n${DEVICE_PASS_WORKFLOW}` },
    }]);
  });

  it("keeps omitted device and revision unknown and requires a scenario", async () => {
    const result = await lab.client.getPrompt({ name: "device_pass", arguments: { scenario: "Login" } });
    expect(promptText(result)).toBe(`Scenario: Login\nRevision: unknown\nDevice: unknown\n\n${DEVICE_PASS_WORKFLOW}`);
    await expect(lab.client.getPrompt({ name: "device_pass" })).rejects.toThrow();
  });

  it("carries the native desktop loop in the device pass prompt", async () => {
    const result = await lab.client.getPrompt({
      name: "device_pass",
      arguments: { scenario: "Settings dialog" },
    });
    const text = promptText(result);
    expect(text).toMatch(
      /desktop_screenshot.*inspect the image.*act.*bounded desktop_wait.*recapture/,
    );
    expect(text).toMatch(/Recapture after every launch or focus change/);
    expect(text).toMatch(/image pixels and reported scale/);
    expect(text).toMatch(/Before typing.*desktop_windows.*desktop_focus/);
    expect(text).toMatch(/black or empty capture as a possible escape/);
    expect(text).toMatch(/Never continue blind clicking/);
  });

  it("scopes the device pass prompt to the managed display and honest waits", async () => {
    const result = await lab.client.getPrompt({
      name: "device_pass",
      arguments: { scenario: "Settings dialog" },
    });
    const text = promptText(result);
    expect(text).toMatch(/managed X11 Xvfb display with a private HOME/);
    expect(text).toMatch(/never on the real desktop or a Wayland session/);
    expect(text).toMatch(/bounded observation, not proof of success/);
    expect(text).toMatch(/stays off unless you ask for it/);
    expect(text).toMatch(/not OCR-redacted/);
    expect(text).toMatch(/only watch --control holds the pausing lease/);
    expect(text).toMatch(/not an OS filesystem or network sandbox/);
  });

  it("repeats the desktop essentials in the short server instructions", () => {
    const instructions = lab.client.getInstructions() ?? "";
    expect(instructions).toContain("desktop_windows");
    expect(instructions).toContain("desktop_focus");
    expect(instructions).toMatch(/black or empty capture/);
    expect(instructions).toMatch(/instead of clicking blind/);
    expect(instructions.length).toBeLessThan(DEVICE_PASS_WORKFLOW.length);
  });

  it("guides a desktop visual test workflow", async () => {
    const result = await lab.client.getPrompt({
      name: "test-flutter-desktop-visually",
      arguments: { appCommand: "./build/linux/x64/release/bundle/app" },
    });
    const text = promptText(result);
    expect(text).toContain("session_create");
    expect(text).toContain("desktop_launch");
    expect(text).toContain("desktop_screenshot");
    expect(text).toContain("session_destroy");
    expect(text).toContain("./build/linux/x64/release/bundle/app");
    expect(text).toContain("request_user_input");
  });

  it("guides an android apk debugging workflow", async () => {
    const result = await lab.client.getPrompt({
      name: "debug-android-apk",
      arguments: {
        apkPath: "build/app/outputs/flutter-apk/app-debug.apk",
        packageName: "com.example.app",
      },
    });
    const text = promptText(result);
    expect(text).toContain("android_start");
    expect(text).toContain("android_install_apk");
    expect(text).toContain("android_logcat");
    expect(text).toContain("android_get_ui_tree");
    expect(text).toContain("build/app/outputs/flutter-apk/app-debug.apk");
    expect(text).toContain("com.example.app");
    expect(text).toContain("request_user_input");
  });

  it("guides a visual regression workflow", async () => {
    const result = await lab.client.getPrompt({
      name: "run-visual-regression-check",
      arguments: { baselineDir: "test/baselines" },
    });
    const text = promptText(result);
    expect(text).toContain("desktop_screenshot");
    expect(text).toContain("artifact_report");
    expect(text).toContain("test/baselines");
    expect(text).toContain("request_user_input");
  });

  it("guides an isolated flutter component preview", async () => {
    const result = await lab.client.getPrompt({
      name: "preview-flutter-component",
      arguments: {
        widget: "ProfileCard",
        states: "signed out, 80-character name",
        viewports: "360 and 1024",
      },
    });
    const text = promptText(result);
    expect(text).toContain("`ProfileCard`");
    expect(text).toContain("States: signed out, 80-character name");
    expect(text).toContain("Viewports: 360 and 1024");
    expect(text).toMatch(/Discover before generating anything/);
    expect(text).toMatch(/fvm flutter.*\.fvmrc/);
    expect(text).toMatch(/theme, localization delegates, providers or inherited widgets/);
    expect(text).toMatch(/Reuse existing test wrappers/);
    expect(text).toMatch(/a\. Widget Previewer[\s\S]*b\. Widget-test capture harness[\s\S]*c\. Temporary web entrypoint, only when/);
    expect(text).toContain("flutter widget-preview start");
    expect(text).toContain("@Preview");
    expect(text).toContain("tester.takeException()");
    expect(text).toContain("session_create");
    expect(text).toContain("desktop_launch");
    expect(text).toContain("desktop_screenshot");
    expect(text).toMatch(/never on the user's real display/);
    expect(text).toMatch(/text scaling \(at least 1\.0 and 2\.0\), semantics labels/);
    expect(text).toContain("meetsGuideline");
    expect(text).toMatch(/Never modify production routing, app startup/);
    expect(text).toMatch(/never accept or update goldens automatically/);
    expect(text).toMatch(/Clean up in every outcome, including failure/);
    expect(text).toMatch(/delete only the paths you recorded/);
    expect(text).toMatch(/If a run is interrupted, print the exact paths/);
    expect(text).toContain("git status --short");
    expect(text).toContain("session_destroy");
    expect(text).toContain("artifact_report");
    expect(text).toContain("evidence_outcome");
    expect(text).toContain("request_user_input");
  });

  it("defaults the component preview states and viewports", async () => {
    const result = await lab.client.getPrompt({
      name: "preview-flutter-component",
      arguments: { widget: "ProfileCard" },
    });
    const text = promptText(result);
    expect(text).toMatch(/States: normal plus stress states: long, empty, and error content/);
    expect(text).toMatch(/Viewports: 390, 768, and 1440 logical pixels at DPR 1/);
    await expect(
      lab.client.getPrompt({ name: "preview-flutter-component" }),
    ).rejects.toThrow();
  });
});
