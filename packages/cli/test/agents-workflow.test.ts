import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildProgram } from "../src/program.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agents-workflow-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("CODEX_HOME", path.join(home, ".codex"));
  vi.stubEnv("PICKFORGE_HOME", path.join(home, "state"));
  vi.stubEnv("PATH", "");
  fs.writeFileSync(path.join(home, ".claude.json"), "{}");
});

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

it.each([
  ["install", "codex"], ["link", "codex"],
  ["install", "claude-code"], ["link", "claude-code"],
  ["install", "pi"], ["link", "pi"],
])("agents %s %s writes and reports the shared workflow", async (command, agent) => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const args = ["node", "pickforge-lab", "agents", command, agent];
  await buildProgram().parseAsync(args);
  expect(process.exitCode ?? 0).toBe(0);
  const workflowPath = path.join(home, "state", "agents", "device-pass.md");
  expect(output).toHaveBeenCalledWith(`Acceptance workflow: ${workflowPath}`);
  expect(fs.statSync(workflowPath).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(workflowPath, "utf8")).toContain(
    "Pass is refused without a successful interaction and an inspected screenshot.",
  );
  await buildProgram().parseAsync([...args, "--json"]);
  expect(process.exitCode ?? 0).toBe(0);
  expect(JSON.parse(output.mock.calls.at(-1)![0]).snippets.devicePassPath).toBe(workflowPath);
});
