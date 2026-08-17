import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "@pickforge/picklab-mcp-server";

export async function runMcpServe(): Promise<number> {
  const handle = serveStdio(
    ({ era }) => createMcpServer({ era }),
    {
      legacy: "serve",
      onerror: (error) => console.error("picklab mcp server:", error),
    },
  );
  console.error("picklab mcp server: listening on stdio");
  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      process.stdin.off("end", finish);
      process.stdin.off("close", finish);
      void handle
        .close()
        .catch(() => {})
        .then(() => resolve(0));
    };
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
  });
}
