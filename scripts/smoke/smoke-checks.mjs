// Assertions for the candidate artifact smoke. Each command reads one CLI
// report and fails loudly; nothing here writes outside the paths it is given.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const HARNESS_TARGETS = [
  ".claude.json",
  ".codex/config.toml",
  ".config/mcp/mcp.json",
  ".claude/skills/pickforge-flutter/SKILL.md",
  ".agents/skills/pickforge-flutter/SKILL.md",
];

// A real 1x1 PNG. The evidence recorder decodes artifacts, so bytes matter.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQDJ4KAAFyAPr" +
  "WhXSFAAAAAElFTkSuQmCC";

function fail(message) {
  console.error(`candidate smoke check failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert(argv[index].startsWith("--"), `unexpected argument ${argv[index]}`);
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`could not parse ${file}: ${error.message}`);
  }
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function checkDoctor(file, options) {
  const report = readJson(file);
  assert(report.project.framework === "flutter", `doctor did not detect Flutter: ${file}`);
  assert(
    isInside(report.project.stateDir, options.state),
    `doctor state dir ${report.project.stateDir} is outside ${options.state}`,
  );
  assert(
    !isInside(report.project.stateDir, options.project),
    `doctor state dir ${report.project.stateDir} is inside the project`,
  );
  const failed = report.checks.filter((check) => check.status === "fail");
  const expectedStatus = report.ready ? 0 : 1;
  assert(
    Number(options["exit-status"]) === expectedStatus,
    `doctor exited ${options["exit-status"]} while reporting ready=${report.ready}`,
  );
  // A clean image has no agent harness. That is the only readiness gap the
  // smoke tolerates: everything else must pass, and doctor must not claim
  // readiness while it fails.
  const tolerated = failed.every((check) => check.id === "harness.available");
  assert(tolerated, `unexpected doctor failures: ${failed.map((check) => check.id).join(", ")}`);
  assert(!existsSync(report.project.stateDir), "doctor created state; it must be read-only");
  console.log(`doctor: ready=${report.ready}, gaps=${failed.map((check) => check.id).join(",") || "none"}`);
}

function planTargets(report) {
  return report.plan.actions.map((action) => action.target);
}

function checkPlan(file, options) {
  const report = readJson(file);
  assert(report.plan.pack.name === "pickforge-flutter", "init plan is not the Flutter pack");
  const targets = planTargets(report);
  for (const expected of HARNESS_TARGETS) {
    assert(
      targets.some((target) => target.endsWith(expected)),
      `init plan is missing ${expected}: ${targets.join(", ")}`,
    );
    assert(
      targets.every((target) => !target.endsWith(expected) || isInside(target, options.home)),
      `init plan targets ${expected} outside the isolated home`,
    );
  }
  return { report, targets };
}

function checkDryRun(file, options) {
  const { report } = checkPlan(file, options);
  assert(report.outcome === undefined, "a dry run reported an apply outcome");
  console.log(`init dry run: ${planTargets(report).length} planned actions, nothing applied`);
}

function readDartServer(home) {
  const claude = readJson(path.join(home, ".claude.json"));
  const server = claude.mcpServers?.["pickforge-dart"];
  assert(server, "init did not configure the pickforge-dart MCP server");
  assert(server.command === "dart", `pickforge-dart command is ${server.command}, expected dart`);
  assert(server.args?.[0] === "mcp-server", `pickforge-dart args are ${JSON.stringify(server.args)}`);
  return server;
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function checkApply(file, options) {
  const { report, targets } = checkPlan(file, options);
  assert(report.outcome?.changed === true, "init reported no change on a clean home");
  for (const target of targets) {
    assert(statSync(target, { throwIfNoEntry: false })?.isFile(), `init did not write ${target}`);
  }
  readDartServer(options.home);
  const hashes = Object.fromEntries(targets.map((target) => [target, hashFile(target)]));
  writeFileSync(path.join(path.dirname(file), "init-hashes.json"), JSON.stringify(hashes, null, 2));
  console.log(`init apply: ${targets.length} files written under ${options.home}`);
}

function checkRepeat(file, options) {
  const report = readJson(file);
  assert(report.outcome?.changed === false, "a second init reported changes; init is not idempotent");
  const hashes = readJson(path.join(path.dirname(file), "init-hashes.json"));
  for (const [target, expected] of Object.entries(hashes)) {
    assert(hashFile(target) === expected, `init rewrote ${target}`);
  }
  readDartServer(options.home);
  console.log("init repeat: no changes, every generated file is byte-identical");
}

function writeEvidenceInput(file, options) {
  writeFileSync(options.artifact, Buffer.from(PNG_BASE64, "base64"));
  const document = {
    schemaVersion: 1,
    scenario: "Candidate artifact smoke",
    outcome: "passed",
    before: {
      summary: `Before token: ${options.secret}`,
      observations: [],
      artifacts: [{ kind: "screenshot", label: "Before", source: options.artifact }],
    },
    after: { summary: "The Dart MCP server listed its tools.", observations: [], artifacts: [] },
    sourceChanges: [],
    checks: [
      {
        name: "MCP handshake",
        status: "passed",
        summary: "Server initialized and listed tools.",
      },
    ],
    limitations: [],
  };
  writeFileSync(file, JSON.stringify(document));
  console.log(`evidence input written to ${file}`);
}

function checkEvidenceResult(file, options) {
  const result = readJson(file);
  for (const key of ["evidencePath", "reportPath"]) {
    const target = result[key];
    assert(target, `evidence result is missing ${key}`);
    assert(statSync(target, { throwIfNoEntry: false })?.isFile(), `missing evidence output ${target}`);
    assert(isInside(target, options.state), `${key} ${target} escaped PICKFORGE_HOME`);
    assert(!isInside(target, options.project), `${key} ${target} was written into the project`);
    assert(
      !readFileSync(target).includes(options.secret),
      `${key} ${target} leaked the planted secret`,
    );
  }
  const document = readJson(result.evidencePath);
  const artifact = document.before.artifacts[0];
  const copied = path.join(path.dirname(result.evidencePath), artifact.path);
  assert(hashFile(copied) === artifact.sha256, "recorded artifact hash does not match its copy");
  console.log(`evidence: recorded run ${result.runId} under ${options.state}`);
}

const COMMANDS = {
  doctor: checkDoctor,
  "init-plan": checkDryRun,
  "init-apply": checkApply,
  "init-repeat": checkRepeat,
  "evidence-input": writeEvidenceInput,
  "evidence-result": checkEvidenceResult,
};

const [command, file, ...rest] = process.argv.slice(2);
const handler = COMMANDS[command];
if (!handler) fail(`unknown command ${command}; expected one of ${Object.keys(COMMANDS).join(", ")}`);
handler(file, parseArgs(rest));
