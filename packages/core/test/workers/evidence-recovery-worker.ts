import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appendAction, beginEvidenceRun } from "../../src/evidence.js";
import { finalizeOrphanedEvidenceRuns } from "../../src/evidence-recovery.js";
import { DirHandle } from "../../src/dir-handle.js";

const [project, mode, source = "cli"] = process.argv.slice(2);
if (project === undefined) throw new Error("project required");
if (mode === "recover" || mode === "crash-report") {
  if (mode === "crash-report") {
    const write = DirHandle.prototype.writeFileAtomic;
    DirHandle.prototype.writeFileAtomic = async function (name, content) {
      await write.call(this, name, content);
      if (name === "report.html") process.kill(process.pid, "SIGKILL");
    };
  }
  console.log(JSON.stringify(await finalizeOrphanedEvidenceRuns(project)));
} else {
  const { run } = await beginEvidenceRun(project, "brow-synthetic", { slug: "computer-use" });
  await fs.promises.writeFile(path.join(run.dir, "screenshots", `${source}.png`), "synthetic pixels");
  await appendAction(run, {
    actionId: `${source}-${process.pid}`,
    source,
    tool: "synthetic_action",
    sessionId: "brow-synthetic",
    startedAt: new Date().toISOString(),
    status: "ok",
    artifacts: [`screenshots/${source}.png`],
  });
  console.log(JSON.stringify({ runId: run.runId, dir: run.dir }));
  if (mode === "torn") {
    await fs.promises.appendFile(path.join(run.dir, "actions.jsonl"), '{"actionId":"interrupted');
    process.kill(process.pid, "SIGKILL");
  }
  if (mode === "hold") await delay(30_000);
}
