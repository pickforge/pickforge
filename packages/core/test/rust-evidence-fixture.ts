import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRun } from "../src/run.js";

export const rustId = "20260909-120000-flutter";
export const plantedSecret = `ghp_${"x".repeat(36)}`;
export function rustDocument(runId = rustId) {
  const artifact = { kind: "screenshot", label: "Before", path: "artifacts/before-home-abcd.png",
    width: 100, height: 200, sha256: "abcd", bytes: 8, mediaType: "image/png" };
  return {
    schemaVersion: 3, runId, projectId: "project-123", projectPath: "/project",
    createdAt: "2026-09-09T12:00:00Z", scenario: `Login token=${plantedSecret}`, outcome: "passed",
    before: { summary: "Login screen", observations: [], artifacts: [artifact] },
    steps: [{ label: "login", summary: "Tap login", observations: [], artifacts: [artifact] }],
    after: { summary: "Home", observations: [], artifacts: [] },
    sourceChanges: [], checks: [{ name: "Home", status: "passed", summary: "Visible", step: "login" }],
    limitations: [`password=${plantedSecret}`, "Emulator only"],
  };
}
export async function mixedRuns(projectDir: string) {
  const lab = await createRun(projectDir, "lab", {
    evidence: true, now: new Date("2026-09-08T12:00:00Z"),
  }, { PICKFORGE_STORAGE_MODE: "project-local" });
  await lab.finish("completed");
  const root = path.dirname(lab.dir);
  const rustDir = path.join(root, rustId);
  fs.mkdirSync(path.join(rustDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(rustDir, "artifacts/before-home-abcd.png"), "picture");
  fs.writeFileSync(path.join(rustDir, "evidence.json"), JSON.stringify(rustDocument()));
  fs.writeFileSync(path.join(rustDir, "report.md"), "Original Rust report");
  const corruptDir = path.join(root, "corrupt-rust");
  fs.mkdirSync(corruptDir);
  fs.writeFileSync(path.join(corruptDir, "evidence.json"), "{broken");
  const linkedDir = path.join(root, "linked-rust");
  fs.mkdirSync(linkedDir);
  fs.symlinkSync(path.join(rustDir, "evidence.json"), path.join(linkedDir, "evidence.json"));
  return { lab, rustDir, corruptDir, linkedDir };
}
export function hashDir(dir: string): string {
  const hash = createHash("sha256");
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    hash.update(name).update(String(stat.mode)).update(String(stat.mtimeMs));
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
    else if (stat.isDirectory()) hash.update(hashDir(file));
    else hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}
