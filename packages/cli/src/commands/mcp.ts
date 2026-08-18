import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "@pickforge/picklab-mcp-server";

class ClosingStdioServerTransport extends StdioServerTransport {
  onClosed?: () => void;

  override async close(): Promise<void> {
    await super.close();
    this.onClosed?.();
  }
}

export async function runMcpServe(): Promise<number> {
  return new Promise<number>((resolve) => {
    const transport = new ClosingStdioServerTransport();
    let settled = false;
    const handle = serveStdio(
      ({ era }) => createMcpServer({ era }),
      {
        legacy: "serve",
        transport,
        onerror: (error) => console.error("picklab mcp server:", error),
      },
    );
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.stdin.off("end", finish);
      process.stdin.off("close", finish);
      void handle.close().catch(() => {}).then(() => resolve(0));
    };
    transport.onClosed = finish;
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    console.error("picklab mcp server: listening on stdio");
  });
}
