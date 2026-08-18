import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "@pickforge/picklab-mcp-server";

// serveStdio owns `onclose`, so observe shutdown by wrapping close instead.
class ClosingStdioServerTransport extends StdioServerTransport {
  constructor(private readonly onClosed: () => void) {
    super();
  }

  override async close(): Promise<void> {
    await super.close();
    this.onClosed();
  }
}

export async function runMcpServe(): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    let handle: StdioServerHandle | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.stdin.off("end", finish);
      process.stdin.off("close", finish);
      void (handle?.close() ?? Promise.resolve()).catch(() => {}).then(() => resolve(0));
    };
    const transport = new ClosingStdioServerTransport(finish);
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    handle = serveStdio(
      ({ era }) => createMcpServer({ era }),
      {
        legacy: "serve",
        transport,
        onerror: (error) => console.error("picklab mcp server:", error),
      },
    );
    if (settled) void handle.close().catch(() => {});
    console.error("picklab mcp server: listening on stdio");
  });
}
