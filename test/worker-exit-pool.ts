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
  private stopping = false;

  override send(message: WorkerRequest): void {
    if (message.type === "stop") this.stopping = true;
    if (message.type === "run" || message.type === "collect") {
      this.files = message.context.files.map((file) => file.filepath);
    }
    super.send(message);
  }

  override async start(): Promise<void> {
    this.stopping = false;
    await super.start();
    // The base class keeps its child process private; read only its pid.
    const pid = (Reflect.get(this, "_fork") as ChildProcess | undefined)?.pid;
    this.on("exit", (...args: unknown[]) => {
      if (this.stopping) return;
      const [code, signal] = args as [number | null, NodeJS.Signals | null];
      process.stderr.write(describeWorkerExit(pid, code, signal, this.files));
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
