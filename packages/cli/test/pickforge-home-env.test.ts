import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { collectSnapshot } from "../src/provision/detect.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pickforge-home-env-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("doctor detection resolves the Pickforge home under the env HOME when PICKFORGE_HOME is empty", async () => {
  const home = path.join(root, "home");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".pickforge", "lab"), { recursive: true });
  fs.mkdirSync(path.join(home, ".picklab"), { recursive: true });
  fs.mkdirSync(projectDir);
  const snapshot = await collectSnapshot({
    env: { PICKFORGE_HOME: "", HOME: home, PATH: path.join(root, "bin") },
    projectDir,
    labUserHome: path.join(root, "lab-user"),
  });
  expect(snapshot.pickforgeHome).toEqual({ path: path.join(home, ".pickforge", "lab"), exists: true, writable: true });
  expect(snapshot.legacyHomes).toEqual([{ path: path.join(home, ".picklab") }]);
});
