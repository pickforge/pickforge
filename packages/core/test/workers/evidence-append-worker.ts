// Separate-process append worker, run with `bun` (the repo's test runtime).
// It exercises the real `appendAction` from a distinct OS process so the
// journal's O_APPEND atomicity is proven under genuine concurrency, not just
// in-process Promise.all. It is not a `*.test.ts` file, so vitest never runs
// it directly.
import {
  appendAction,
  beginEvidenceRun,
  type EvidenceAction,
} from "../../src/evidence.js";

const projectDir = process.argv[2];
const sessionId = process.argv[3];
const worker = process.argv[4];
const count = Number(process.argv[5]);
if (
  projectDir === undefined ||
  sessionId === undefined ||
  worker === undefined ||
  !Number.isInteger(count)
) {
  console.error(
    "usage: evidence-append-worker <projectDir> <sessionId> <workerId> <count>",
  );
  process.exit(2);
}

const { run } = await beginEvidenceRun(projectDir, sessionId);

for (let index = 0; index < count; index += 1) {
  const action: EvidenceAction = {
    actionId: `${worker}-${index}`,
    source: "worker",
    tool: "append",
    startedAt: new Date().toISOString(),
    status: "ok",
    target: { worker, index },
  };
  const result = await appendAction(run, action, {
    // Large cap so this workload never truncates; we are testing atomicity.
    maxBytes: 1024 * 1024 * 1024,
  });
  if (result.outcome !== "appended") {
    console.error(`unexpected outcome ${result.outcome} at ${worker}-${index}`);
    process.exit(1);
  }
}
process.exit(0);
