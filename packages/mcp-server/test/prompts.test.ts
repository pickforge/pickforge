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
});
