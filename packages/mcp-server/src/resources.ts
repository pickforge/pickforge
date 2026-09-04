import fs from "node:fs";
import path from "node:path";
import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import {
  EVIDENCE_ACTION_LOG,
  EVIDENCE_REPORT,
  getSession,
  isEvidenceRun,
  listSessions,
  openRunCatalog,
  parseActionsJournal,
  redactSecrets,
  sortEvidenceRecords,
  type RunCatalog,
  type RunCatalogEntry,
} from "@pickforge/lab-core";
import type { ServerContext } from "./context.js";
import { sessionStatusEntry } from "./tools/session.js";

const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
/** Upper bound on how many trailing bytes of an oversized run log are read into memory. */
const MAX_LOG_TAIL_BYTES = 1 * 1024 * 1024;

function decodeVariable(variables: Variables, label: string): string {
  const raw = variables[label];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    throw new Error(`Missing "${label}" in resource URI`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`Invalid "${label}" in resource URI`);
  }
  if (
    !SAFE_NAME_PATTERN.test(decoded) ||
    decoded === "." ||
    decoded.includes("..")
  ) {
    throw new Error(`Invalid "${label}" in resource URI: ${decoded}`);
  }
  return decoded;
}

function runFilePath(
  entry: RunCatalogEntry,
  subdir: "screenshots" | "logs",
  name: string,
): string {
  const base = path.join(entry.dir, subdir);
  const resolved = path.resolve(base, name);
  if (resolved !== path.join(base, name)) {
    throw new Error(`Invalid resource path: ${name}`);
  }
  return resolved;
}

// Reject a run directory that is itself a symlink (or otherwise resolves
// outside the runs root). Returns true when the run dir is safe, false when it
// is missing or escapes the runs root via symlinks.
async function isRunDirSafe(
  catalog: RunCatalog,
  entry: RunCatalogEntry,
): Promise<boolean> {
  if ((await catalog.refresh(entry)) === undefined) return false;
  const root = catalog.roots[entry.rootPrecedence];
  if (root === undefined) return false;
  try {
    const realRoot = await fs.promises.realpath(entry.rootDir);
    if (realRoot !== root.expectedRealDir) return false;
    const realRunDir = await fs.promises.realpath(entry.dir);
    return realRunDir === path.join(realRoot, entry.dirName);
  } catch {
    return false;
  }
}

// Reject paths whose real location escapes the run subdir via symlinks. When
// the file (or subdir) does not exist, return so the caller's read produces its
// usual not-found error.
async function assertWithinSubdir(
  catalog: RunCatalog,
  entry: RunCatalogEntry,
  subdir: "screenshots" | "logs",
  filePath: string,
  notFound: () => Error,
): Promise<void> {
  if (!(await isRunDirSafe(catalog, entry))) {
    throw notFound();
  }
  // Reject a symlinked artifact file even when its target stays inside the run
  // subdir; direct log/screenshot reads must not follow symlinks.
  try {
    const lst = await fs.promises.lstat(filePath);
    if (lst.isSymbolicLink()) {
      throw notFound();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === undefined) {
      throw err;
    }
    return;
  }
  const runDir = entry.dir;
  const base = path.join(runDir, subdir);
  let realRunDir: string;
  let realBase: string;
  let realFile: string;
  try {
    realRunDir = await fs.promises.realpath(runDir);
    realBase = await fs.promises.realpath(base);
    realFile = await fs.promises.realpath(filePath);
  } catch {
    return;
  }
  // The subdir itself must resolve to a real location inside the run dir, so a
  // symlinked logs/screenshots directory cannot redirect reads outside.
  const expectedBase = path.join(realRunDir, subdir);
  if (realBase !== expectedBase) {
    throw notFound();
  }
  if (realFile !== realBase && !realFile.startsWith(realBase + path.sep)) {
    throw notFound();
  }
}

// Read only the trailing `maxBytes` of a file (tail semantics), so an
// oversized log never gets pulled fully into memory just to redact secrets
// from it. Drops a partial leading line so the returned text starts cleanly.
async function readTailUtf8(
  filePath: string,
  fileSize: number,
  maxBytes: number,
): Promise<string> {
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const length = Math.min(maxBytes, fileSize);
    const position = fileSize - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (position === 0) return text;
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? text : text.slice(firstNewline + 1);
  } finally {
    await handle.close();
  }
}

async function listEvidenceRunFiles(
  ctx: ServerContext,
  fileName: typeof EVIDENCE_ACTION_LOG | typeof EVIDENCE_REPORT,
): Promise<string[]> {
  const catalog = await openRunCatalog(ctx.projectDir, ctx.env);
  const runIds: string[] = [];
  for (const entry of await catalog.list()) {
    if (!isEvidenceRun(entry.manifest)) continue;
    if (!(await catalog.hasRootFile(entry, fileName))) continue;
    runIds.push(entry.manifest.runId);
  }
  return runIds;
}

async function listRunFiles(
  ctx: ServerContext,
  subdir: "screenshots" | "logs",
): Promise<Array<{ runId: string; name: string }>> {
  const entries: Array<{ runId: string; name: string }> = [];
  const catalog = await openRunCatalog(ctx.projectDir, ctx.env);
  for (const entry of await catalog.list()) {
    const runDir = entry.dir;
    const dir = path.join(runDir, subdir);
    try {
      const realRunDir = await fs.promises.realpath(runDir);
      const realDir = await fs.promises.realpath(dir);
      // Skip a symlinked subdir that resolves outside the run dir.
      if (realDir !== path.join(realRunDir, subdir)) continue;
    } catch {
      continue;
    }
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!SAFE_NAME_PATTERN.test(name) || name.includes("..")) continue;
      let fileStat: fs.Stats;
      try {
        fileStat = await fs.promises.lstat(path.join(dir, name));
      } catch {
        continue;
      }
      if (fileStat.isSymbolicLink()) continue;
      entries.push({ runId: entry.manifest.runId, name });
    }
  }
  return entries;
}

function registerResource1(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "runs",
    "pickforge://runs",
    {
      title: "Pickforge runs",
      description: "Index of recorded runs (see pickforge-lab doctor for the resolved storage path)",
      mimeType: "application/json",
    },
    async (uri) => {
      const catalog = await openRunCatalog(ctx.projectDir, ctx.env);
      const runs = (await catalog.list()).map(({ manifest }) => ({
        runId: manifest.runId,
        slug: manifest.slug,
        createdAt: manifest.createdAt,
        status: manifest.status,
        artifacts: manifest.artifacts.length,
      }));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(runs, null, 2),
          },
        ],
      };
    },
  );
}

function registerResource2(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "run-manifest",
    new ResourceTemplate("pickforge://runs/{runId}/manifest", {
      list: async () => ({
        resources: (
          await (await openRunCatalog(ctx.projectDir, ctx.env)).list()
        ).map(({ manifest }) => ({
          uri: `pickforge://runs/${manifest.runId}/manifest`,
          name: `Run ${manifest.runId} manifest`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Run manifest",
      description: "Manifest (status and artifacts) of a recorded run",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const runId = decodeVariable(variables, "runId");
      const catalog = await openRunCatalog(ctx.projectDir, ctx.env);
      const entry = await catalog.find(runId);
      if (entry === undefined) throw new Error(`Run not found: ${runId}`);
      let raw: string;
      try {
        raw = await catalog.readRootText(entry, "manifest.json");
      } catch {
        throw new Error(`Run not found: ${runId}`);
      }
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: raw },
        ],
      };
    },
  );
}

function registerResource3(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "run-actions",
    new ResourceTemplate("pickforge://runs/{runId}/actions", {
      list: async () => ({
        resources: (await listEvidenceRunFiles(ctx, EVIDENCE_ACTION_LOG)).map(
          (runId) => ({
            uri: `pickforge://runs/${runId}/actions`,
            name: `Run ${runId} actions`,
            mimeType: "application/json",
          }),
        ),
      }),
    }),
    {
      title: "Run actions",
      description: "Deterministically ordered evidence actions for a run",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const runId = decodeVariable(variables, "runId");
      const catalog = await openRunCatalog(ctx.projectDir, ctx.env);
      const entry = await catalog.find(runId);
      if (entry === undefined || !isEvidenceRun(entry.manifest)) {
        throw new Error(`Actions not found: ${runId}`);
      }
      let raw: string;
      try {
        raw = await catalog.readRootText(entry, EVIDENCE_ACTION_LOG);
      } catch {
        throw new Error(`Actions not found: ${runId}`);
      }
      let records;
      try {
        records = parseActionsJournal(raw, `run ${runId}`);
      } catch (error) {
        throw new Error(
          `Could not read actions for ${runId}: ${(error as Error).message}`,
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: redactSecrets(
              JSON.stringify(sortEvidenceRecords(records), null, 2),
            ),
          },
        ],
      };
    },
  );
}

function registerResource4(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "run-report",
    new ResourceTemplate("pickforge://runs/{runId}/report", {
      list: async () => ({
        resources: (await listEvidenceRunFiles(ctx, EVIDENCE_REPORT)).map(
          (runId) => ({
            uri: `pickforge://runs/${runId}/report`,
            name: `Run ${runId} HTML report`,
            mimeType: "text/html",
          }),
        ),
      }),
    }),
    {
      title: "Run HTML report",
      description: "Static evidence filmstrip for a recorded run",
      mimeType: "text/html",
    },
    async (uri, variables) => {
      const runId = decodeVariable(variables, "runId");
      const catalog = await openRunCatalog(ctx.projectDir, ctx.env);
      const entry = await catalog.find(runId);
      if (entry === undefined || !isEvidenceRun(entry.manifest)) {
        throw new Error(`Report not found: ${runId}`);
      }
      let html: string;
      try {
        html = await catalog.readRootText(entry, EVIDENCE_REPORT);
      } catch {
        throw new Error(`Report not found: ${runId}`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/html",
            text: redactSecrets(html),
          },
        ],
      };
    },
  );
}

function registerResource5(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "run-screenshot",
    new ResourceTemplate("pickforge://runs/{runId}/screenshots/{name}", {
      list: async () => ({
        resources: (await listRunFiles(ctx, "screenshots")).map((entry) => ({
          uri: `pickforge://runs/${entry.runId}/screenshots/${entry.name}`,
          name: `Run ${entry.runId} screenshot ${entry.name}`,
          mimeType: "image/png",
        })),
      }),
    }),
    {
      title: "Run screenshot",
      description: "PNG screenshot captured during a run",
      mimeType: "image/png",
    },
    async (uri, variables) => {
      const runId = decodeVariable(variables, "runId");
      const name = decodeVariable(variables, "name");
      if (!name.endsWith(".png")) {
        throw new Error(`Not a PNG screenshot: ${name}`);
      }
      const catalog = await openRunCatalog(ctx.projectDir, ctx.env);
      const entry = await catalog.find(runId);
      if (entry === undefined) {
        throw new Error(`Screenshot not found: ${runId}/${name}`);
      }
      const filePath = runFilePath(entry, "screenshots", name);
      await assertWithinSubdir(
        catalog,
        entry,
        "screenshots",
        filePath,
        () => new Error(`Screenshot not found: ${runId}/${name}`),
      );
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        throw new Error(`Screenshot not found: ${runId}/${name}`);
      }
      if (stat.size > MAX_BLOB_BYTES) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text:
                `Screenshot ${runId}/${name} is ${stat.size} bytes, over ` +
                `the ${MAX_BLOB_BYTES} byte inline limit; read the file ` +
                `directly at ${filePath}`,
            },
          ],
        };
      }
      let data: Buffer;
      try {
        data = await fs.promises.readFile(filePath);
      } catch {
        throw new Error(`Screenshot not found: ${runId}/${name}`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "image/png",
            blob: data.toString("base64"),
          },
        ],
      };
    },
  );
}

function registerResource6(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "run-log",
    new ResourceTemplate("pickforge://runs/{runId}/logs/{name}", {
      list: async () => ({
        resources: (await listRunFiles(ctx, "logs")).map((entry) => ({
          uri: `pickforge://runs/${entry.runId}/logs/${entry.name}`,
          name: `Run ${entry.runId} log ${entry.name}`,
          mimeType: "text/plain",
        })),
      }),
    }),
    {
      title: "Run log",
      description: "Log captured during a run (secrets redacted)",
      mimeType: "text/plain",
    },
    async (uri, variables) => {
      const runId = decodeVariable(variables, "runId");
      const name = decodeVariable(variables, "name");
      const catalog = await openRunCatalog(ctx.projectDir, ctx.env);
      const entry = await catalog.find(runId);
      if (entry === undefined) {
        throw new Error(`Log not found: ${runId}/${name}`);
      }
      const filePath = runFilePath(entry, "logs", name);
      await assertWithinSubdir(
        catalog,
        entry,
        "logs",
        filePath,
        () => new Error(`Log not found: ${runId}/${name}`),
      );
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        throw new Error(`Log not found: ${runId}/${name}`);
      }
      let raw: string;
      let truncated = false;
      try {
        if (stat.size > MAX_LOG_TAIL_BYTES) {
          truncated = true;
          raw = await readTailUtf8(filePath, stat.size, MAX_LOG_TAIL_BYTES);
        } else {
          raw = await fs.promises.readFile(filePath, "utf8");
        }
      } catch {
        throw new Error(`Log not found: ${runId}/${name}`);
      }
      const text = redactSecrets(raw);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: truncated
              ? `[truncated: showing last ${MAX_LOG_TAIL_BYTES} of ${stat.size} bytes]\n${text}`
              : text,
          },
        ],
      };
    },
  );
}

function registerResource7(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "session-status",
    new ResourceTemplate("pickforge://sessions/{sessionId}/status", {
      list: async () => ({
        resources: (await listSessions(ctx.env)).map((record) => ({
          uri: `pickforge://sessions/${record.id}/status`,
          name: `Session ${record.id} status`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Session status",
      description: "Liveness and details of a lab session",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const sessionId = decodeVariable(variables, "sessionId");
      const record = await getSession(sessionId, ctx.env);
      if (record === undefined) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const entry = await sessionStatusEntry(ctx, record);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(entry, null, 2),
          },
        ],
      };
    },
  );
}

export function registerResources(server: McpServer, ctx: ServerContext): void {
  registerResource1(server, ctx);
  registerResource2(server, ctx);
  registerResource3(server, ctx);
  registerResource4(server, ctx);
  registerResource5(server, ctx);
  registerResource6(server, ctx);
  registerResource7(server, ctx);
}
