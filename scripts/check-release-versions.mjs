// Prove one version across the release surface: every workspace package, the
// Cargo workspace, and (when given) an expected tag. Used by the release
// workflow and by docs/releases/CHECKLIST.md so both agree by construction.
//
// Usage: node scripts/check-release-versions.mjs [expected-tag]
// Prints the version on success; exits non-zero with the mismatch otherwise.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const problems = [];

function packageVersion(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8")).version;
}

const version = packageVersion("packages/cli/package.json");

for (const name of readdirSync(path.join(root, "packages"))) {
  const relative = `packages/${name}/package.json`;
  let actual;
  try {
    actual = packageVersion(relative);
  } catch {
    continue;
  }
  if (actual !== version) problems.push(`${relative} is ${actual}, expected ${version}`);
}

const rootVersion = packageVersion("package.json");
if (rootVersion !== version) problems.push(`package.json is ${rootVersion}, expected ${version}`);

const cargo = readFileSync(path.join(root, "Cargo.toml"), "utf8");
const cargoVersion = cargo.match(/^version = "([^"]+)"$/m)?.[1];
if (cargoVersion !== version) problems.push(`Cargo.toml is ${cargoVersion}, expected ${version}`);

const expectedTag = process.argv[2];
if (expectedTag && expectedTag !== `v${version}`) {
  problems.push(`tag ${expectedTag} does not match package version ${version}`);
}

if (problems.length > 0) {
  console.error(`release version mismatch:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(version);
