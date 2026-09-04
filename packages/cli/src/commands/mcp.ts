import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "@pickforge/lab-mcp-server";

export async function runMcpServe(): Promise<number> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("pickforge-lab mcp server: listening on stdio");
  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      void server
        .close()
        .catch(() => {})
        .then(() => resolve(0));
    };
    server.server.onclose = finish;
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
  });
}
