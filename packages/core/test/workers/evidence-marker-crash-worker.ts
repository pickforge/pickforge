// Separate-process crash worker, run with `bun`. It crosses the evidence cap,
// stamps the truncation-marker claim, then exits abruptly *before* the marker is
// appended — modelling a real process crash in the window the P3 finding is
// about. It leaves an uncommitted claim whose owner (this pid) is then dead, so
// a later append must reclaim it and write the marker. Not a `*.test.ts` file,
// so vitest never runs it directly.
import {
  appendAction,
  beginEvidenceRun,
  type EvidenceAction,
} from "../../src/evidence.js";

const projectDir = process.argv[2];
const sessionId = process.argv[3];
const maxBytes = Number(process.argv[4]);
if (
  projectDir === undefined ||
  sessionId === undefined ||
  !Number.isInteger(maxBytes)
) {
  console.error(
    "usage: evidence-marker-crash-worker <projectDir> <sessionId> <maxBytes>",
  );
  process.exit(2);
}

const action: EvidenceAction = {
  actionId: "crasher",
  source: "worker",
  tool: "truncate",
  startedAt: new Date().toISOString(),
  status: "ok",
};

const { run } = await beginEvidenceRun(projectDir, sessionId);

// `_afterMarkerClaim` runs after the claim identity is stamped but before the
// marker append. Exiting here leaves the sentinel holding this pid's uncommitted
// claim with no marker in the journal — exactly the crash-mid-claim state.
await appendAction(run, action, {
  maxBytes,
  maxLineBytes: 4096,
  _afterMarkerClaim: () => {
    process.exit(42);
  },
});
// Unreachable: the hook above terminates the process.
process.exit(0);
