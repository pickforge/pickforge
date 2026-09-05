import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { redactSecrets } from "@pickforge/lab-core";
import { createMcpServer } from "@pickforge/lab-mcp-server";

const MAX_ERROR_CHARS = 2_048;
const MAX_ERROR_REPORTS = 8;
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

export function createMcpErrorReporter(
  write: (message: string) => void = (message) => process.stderr.write(message),
): (error: unknown) => void {
  let reports = 0;
  return (error) => {
    if (reports >= MAX_ERROR_REPORTS) return;
    reports += 1;
    const raw = error instanceof Error ? error.message : String(error);
    const suffix = raw.length > MAX_ERROR_CHARS ? " [truncated]" : "";
    const detail = redactSecrets(raw.slice(0, MAX_ERROR_CHARS)).replace(
      /[\r\n]+/g,
      " ",
    );
    write(`pickforge-lab mcp server: ${detail}${suffix}\n`);
    if (reports === MAX_ERROR_REPORTS) {
      write("pickforge-lab mcp server: further errors suppressed\n");
    }
  };
}

// serveStdio owns `onclose`, so observe shutdown through the transport's close.
class ObservedStdioServerTransport extends StdioServerTransport {
  private observed = false;

  constructor(private readonly onClosed: () => void) {
    super();
  }

  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      if (!this.observed) {
        this.observed = true;
        this.onClosed();
      }
    }
  }
}

export async function runMcpServe(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const reportError = createMcpErrorReporter();
    let handle: StdioServerHandle | undefined;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.stdin.off("end", finish);
      process.stdin.off("close", finish);
      for (const signal of SHUTDOWN_SIGNALS) process.off(signal, finish);
      queueMicrotask(() => {
        void (handle?.close() ?? Promise.resolve())
          .catch(reportError)
          .then(() => resolve(0));
      });
    };

    const transport = new ObservedStdioServerTransport(finish);
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    for (const signal of SHUTDOWN_SIGNALS) process.on(signal, finish);

    try {
      handle = serveStdio(() => createMcpServer(), {
        legacy: "serve",
        transport,
        onerror: reportError,
      });
    } catch (error) {
      process.stdin.off("end", finish);
      process.stdin.off("close", finish);
      for (const signal of SHUTDOWN_SIGNALS) process.off(signal, finish);
      reject(error);
      return;
    }

    process.stderr.write("pickforge-lab mcp server: listening on stdio\n");
  });
}
