import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SupervisedBrowserCommand {
  command: string;
  args: string[];
}

/** Where the supervisor publishes the session's CDP endpoint. */
export interface SupervisorCdpPaths {
  endpointFile: string;
  socketPath: string;
}

/**
 * Locate the supervisor script. Both builds copy `supervisor-main.js` next to
 * the bundled module, and a source checkout runs the same file from `src`.
 */
export function resolveSupervisorScript(moduleUrl: string = import.meta.url): string {
  const script = path.join(path.dirname(fileURLToPath(moduleUrl)), "supervisor-main.js");
  if (!fs.existsSync(script)) {
    throw new Error(`Browser supervisor script is missing: ${script}`);
  }
  return script;
}

export function buildSupervisedBrowserCommand(
  nodePath: string,
  binaryPath: string,
  browserArgs: string[],
  cdp: SupervisorCdpPaths,
  scriptPath: string = resolveSupervisorScript(),
): SupervisedBrowserCommand {
  if (nodePath === "") {
    throw new Error("Browser supervisor requires a Node.js executable path");
  }
  if (binaryPath === "") {
    throw new Error("Browser supervisor requires a browser binary path");
  }
  if (cdp.endpointFile === "" || cdp.socketPath === "") {
    throw new Error("Browser supervisor requires CDP endpoint and socket paths");
  }
  return {
    command: nodePath,
    args: [scriptPath, cdp.endpointFile, cdp.socketPath, binaryPath, ...browserArgs],
  };
}
