import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import { ensureCliBuilt } from "./build-once.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const bin = fileURLToPath(new URL("../dist/pickforge-mcp.js", import.meta.url));
const exec = promisify(execFile);

beforeAll(ensureCliBuilt, 300_000);

// execFile keeps stdin open: a stdio server would hang until the timeout.
it.each(["--version", "-V"])("%s prints only the version without serving", async (flag) => {
  const result = await exec(process.execPath, [bin, flag], {
    timeout: 10_000,
    env: { ...process.env, PICKFORGE_TELEMETRY: "0" },
  });
  expect(result.stdout).toBe(`${version}\n`);
  expect(result.stderr).toBe("");
});

it("--help prints usage without serving", async () => {
  const result = await exec(process.execPath, [bin, "--help"], {
    timeout: 10_000,
    env: { ...process.env, PICKFORGE_TELEMETRY: "0" },
  });
  expect(result.stdout).toContain("Usage: pickforge-mcp [options]");
  expect(result.stdout).toContain("--version");
  expect(result.stderr).toBe("");
});
