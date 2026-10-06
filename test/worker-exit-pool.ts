// Vitest's forks pool with one addition: a worker that exits outside vitest's
// own shutdown prints its exit code, signal and test files to stderr. Vitest
// itself reports such a worker only as "Worker exited unexpectedly", which
// cannot tell a crash from an exit call or an outside signal. See #253.

import type { ChildProcess } from "node:child_process";
import type { PoolOptions, PoolRunnerInitializer, WorkerRequest } from "vitest/node";
import { ForksPoolWorker } from "vitest/node";

const POOL_NAME = "forks-exit-logged";

function describeWorkerExit(
  pid: number | undefined,
  code: number | null,
  signal: NodeJS.Signals | null,
  files: readonly string[],
): string {
  const ran = files.length > 0 ? files.join(", ") : "no test file yet";
  return (
    `[worker-exit] ${new Date().toISOString()} vitest worker pid ${pid ?? "unknown"} exited ` +
    `unexpectedly: code ${code ?? "none"}, signal ${signal ?? "none"}; files: ${ran}\n`
  );
}

class ExitLoggingForksPoolWorker extends ForksPoolWorker {
  override readonly name = POOL_NAME;
  private files: string[] = [];
  // Vitest posts "stop" first; the worker may then exit by itself with code 0.
  private stopRequested = false;
  // Vitest's own stop() kills the fork; any exit after that is expected.
  private stopping = false;

  override send(message: WorkerRequest): void {
    if (message.type === "stop") this.stopRequested = true;
    if (message.type === "run" || message.type === "collect") {
      this.files = message.context.files.map((file) => file.filepath);
    }
    super.send(message);
  }

  override async start(): Promise<void> {
    this.stopRequested = false;
    this.stopping = false;
    await super.start();
    const report = (pid: number | undefined, code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.stopping || (this.stopRequested && signal === null)) return;
      process.stderr.write(describeWorkerExit(pid, code, signal, this.files));
    };
    // The listener is attached to the child process itself, so `this` is it.
    this.on("exit", function (this: ChildProcess, ...args: unknown[]) {
      const [code, signal] = args as [number | null, NodeJS.Signals | null];
      report(this.pid, code, signal);
    });
  }

  override async stop(): Promise<void> {
    this.stopping = true;
    await super.stop();
  }
}

export const exitLoggingForksPool: PoolRunnerInitializer = {
  name: POOL_NAME,
  createPoolWorker: (options: PoolOptions) => new ExitLoggingForksPoolWorker(options),
};
