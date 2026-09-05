// A real MCP client handshake against the server Pickforge configured.
//
// Speaks the stdio JSON-RPC protocol directly: initialize, initialized,
// tools/list. No SDK, no mock. Fails unless a named server answers with a
// non-empty tool list inside the timeout.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Overridable only so the timeout itself can be exercised against a server that
// never answers. Anything that is not a positive number keeps the real budget.
const override = Number(process.env.PICKFORGE_MCP_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(override) && override > 0 ? override : 120_000;
const KILL_GRACE_MS = 5_000;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    options[argv[index].replace(/^--/, "")] = argv[index + 1];
  }
  for (const key of ["project", "out"]) {
    if (!options[key]) {
      console.error(`mcp-handshake: --${key} is required`);
      process.exit(1);
    }
  }
  if (!options.command && !(options.config && options.server)) {
    console.error("mcp-handshake: pass --command, or --config with --server");
    process.exit(1);
  }
  return options;
}

// Either the server Pickforge wrote into a harness config, or a command given
// directly. Both paths spawn a real server; neither is mocked.
function resolveServer(options) {
  if (options.command) return { command: options.command, args: [] };
  const config = JSON.parse(readFileSync(options.config, "utf8"));
  const server = config.mcpServers?.[options.server];
  if (!server) throw new Error(`${options.config} has no MCP server named ${options.server}`);
  return server;
}

// A hung server must fail this gate at TIMEOUT_MS, not sit on the job until
// GitHub's own timeout. Every pending request rejects on timeout, on spawn
// failure, and on child exit, so nothing here can wait forever.
function failAllPending(pending, error) {
  for (const [id, entry] of pending) {
    pending.delete(id);
    entry.reject(error);
  }
}

function collectResponses(child, pending) {
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      // Servers are allowed to print human-readable banners on stdout.
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        entry.resolve(message);
      }
    }
  });
}

function request(child, pending, id, method, params) {
  const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return response;
}

function notify(child, method) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
}

// SIGTERM first so a well-behaved server can flush and exit, SIGKILL if it does
// not, and always wait for the exit so the smoke leaves no orphan behind.
async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const hard = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  try {
    await exited;
  } finally {
    clearTimeout(hard);
  }
}

function assertOk(message, label) {
  if (message.error) throw new Error(`${label} returned an MCP error: ${JSON.stringify(message.error)}`);
  return message.result;
}

async function handshake(options) {
  const server = resolveServer(options);
  const child = spawn(server.command, server.args ?? [], {
    cwd: options.project,
    env: { ...process.env, ...(server.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const pending = new Map();
  collectResponses(child, pending);

  // The deadline rejects the whole handshake, not just the in-flight request:
  // a server that answers `initialize` and then hangs on `tools/list` still
  // fails at TIMEOUT_MS.
  let expired;
  const deadline = new Promise((_, reject) => {
    expired = setTimeout(() => {
      reject(new Error(`no MCP response within ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
  });
  // Node keeps the process alive for a pending timer; the handshake owns the
  // lifetime, so let an early success exit rather than idle until the deadline.
  expired.unref?.();
  deadline.catch(() => {});

  child.on("error", (error) => {
    failAllPending(pending, new Error(`could not run ${server.command}: ${error.message}`));
  });
  // A server that died already makes stdin a broken pipe. That is a handshake
  // failure, not an unhandled stream error that takes the smoke down with it.
  child.stdin.on("error", (error) => {
    failAllPending(pending, new Error(`could not write to ${server.command}: ${error.message}`));
  });
  child.on("exit", (code, signal) => {
    failAllPending(pending, new Error(`the MCP server exited (code ${code}, signal ${signal}) mid-handshake`));
  });
  const race = (promise) => Promise.race([promise, deadline]);

  try {
    const initialized = assertOk(
      await race(
        request(child, pending, 1, "initialize", {
          protocolVersion: "2025-03-26",
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: "pickforge-candidate-smoke", version: "1" },
        }),
      ),
      "initialize",
    );
    notify(child, "notifications/initialized");
    const tools = assertOk(await race(request(child, pending, 2, "tools/list", {})), "tools/list");
    if (!initialized?.serverInfo?.name) throw new Error("initialize returned no server name");
    if (!tools?.tools?.length) throw new Error("the MCP server listed no tools");
    const reported = initialized.serverInfo.version;
    if (options["expect-version"] && reported !== options["expect-version"]) {
      throw new Error(`server reported version ${reported}, expected ${options["expect-version"]}`);
    }
    return {
      command: server.command,
      args: server.args ?? [],
      serverInfo: initialized.serverInfo,
      protocolVersion: initialized.protocolVersion,
      toolCount: tools.tools.length,
      tools: tools.tools.map((tool) => tool.name).sort(),
      stderr: Buffer.concat(stderr).toString("utf8").slice(0, 4096),
    };
  } catch (error) {
    const captured = Buffer.concat(stderr).toString("utf8").slice(-2048).trim();
    throw captured ? new Error(`${error.message}\nserver stderr:\n${captured}`) : error;
  } finally {
    clearTimeout(expired);
    child.stdin.end();
    await terminate(child);
  }
}

const options = parseArgs(process.argv.slice(2));
try {
  const result = await handshake(options);
  writeFileSync(path.resolve(options.out), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`MCP ${result.serverInfo.name} answered with ${result.toolCount} tools`);
} catch (error) {
  console.error(`mcp-handshake failed: ${error.message}`);
  process.exit(1);
}
