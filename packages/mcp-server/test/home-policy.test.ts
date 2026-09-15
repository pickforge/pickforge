import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSession, resolveActivePointer, type EnvLike } from "@pickforge/lab-core";
import { destroyDesktopSession } from "@pickforge/lab-desktop-linux";
import { connectLab, makeLabDirs, parseToolJson, removeLabDirs, type ConnectedLab, type LabDirs } from "./helpers.js";

let dirs: LabDirs;
let lab: ConnectedLab;
let env: EnvLike;
let sessionId: string | undefined;
beforeEach(async () => {
  dirs = makeLabDirs();
  const host = path.join(dirs.root, "synthetic-host");
  fs.mkdirSync(host);
  env = { HOME: host, PICKFORGE_HOME: dirs.home, PATH: process.env.PATH, PICKFORGE_STORAGE_MODE: "project-local" };
  lab = await connectLab({ projectDir: dirs.projectDir, env });
});
afterEach(async () => {
  if (sessionId !== undefined) await destroyDesktopSession(sessionId, env);
  sessionId = undefined;
  await lab.close();
  removeLabDirs(dirs);
});

describe("MCP session home policy", () => {
  it("describes immutable consent and the human-control agent pause", async () => {
    const { tools } = await lab.client.listTools();
    const schema = tools.find((tool) => tool.name === "session_create")?.inputSchema;
    const policy = schema?.properties?.inheritHome as { description: string };
    expect(policy.description).toContain("immutable");
    expect(policy.description).toContain("Human takeover remains available and pauses agent actions");
    expect(policy.description).not.toContain("disables human takeover");
  });

  it.each([false, true])("applies inheritHome=%s from creation to launch, status and evidence", async (inheritHome) => {
    const created = parseToolJson(await lab.client.callTool({
      name: "session_create", arguments: { type: "desktop", inheritHome },
    }));
    expect(created.ok).toBe(true);
    sessionId = created.sessions[0].id as string;
    const record = await getSession(sessionId, env);
    const policy = inheritHome ? "inherit" : "private";
    expect(record?.desktop?.homePolicy).toBe(policy);
    const capture = path.join(dirs.projectDir, "home.txt");
    const launched = parseToolJson(await lab.client.callTool({
      name: "desktop_launch", arguments: {
        session: sessionId, command: "/bin/sh",
        args: ["-c", `printf '%s' "$HOME" > '${capture}'; exec /bin/sleep 30`],
      },
    }));
    expect(launched.ok).toBe(true);
    expect(fs.readFileSync(capture, "utf8")).toBe(inheritHome ? env.HOME : path.join(record!.desktop!.runtimeDir!, "home"));
    const status = parseToolJson(await lab.client.callTool({ name: "session_status", arguments: { sessionId } }));
    expect(status.sessions[0].desktop.homePolicy).toBe(policy);
    const evidence = await resolveActivePointer(dirs.projectDir, sessionId, env);
    expect(evidence.status).toBe("active");
    if (evidence.status !== "active") throw new Error("missing evidence");
    expect(evidence.manifest.meta?.desktopHomePolicy).toBe(policy);
    expect(JSON.stringify(evidence.manifest)).not.toContain(env.HOME);
  }, 30_000);
});
