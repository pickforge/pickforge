import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireHumanLease,
  createSession,
  releaseHumanLease,
  type EnvLike,
} from "@pickforge/lab-core";
import { takeoverStatus } from "../src/commands/takeover.js";

let root: string;
let env: EnvLike;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pickforge-lab-takeover-status-"));
  env = { PICKFORGE_HOME: path.join(root, "home") };
  process.env.PICKFORGE_HOME = env.PICKFORGE_HOME;
});

afterEach(async () => {
  delete process.env.PICKFORGE_HOME;
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function createDesktop(): Promise<string> {
  const record = await createSession(
    { type: "desktop", projectDir: root, status: "running", desktop: { display: ":42" } },
    env,
  );
  return record.id;
}

describe("takeoverStatus", () => {
  it("reports agent-active when no lease exists", async () => {
    const id = await createDesktop();
    const result = await takeoverStatus({ session: id, projectDir: root });
    expect(result.data).toEqual({ sessionId: id, active: false });
    expect(result.lines?.join("\n")).toContain("agent-active");
  });

  it("reports human-active with lease details while a live lease is held", async () => {
    const id = await createDesktop();
    const lease = await acquireHumanLease(id, env);
    const result = await takeoverStatus({ session: id, projectDir: root });
    expect(result.data).toMatchObject({
      sessionId: id,
      active: true,
      lease: { leaseId: lease.leaseId, ownerPid: lease.ownerPid },
    });
    expect(result.lines?.join("\n")).toContain("under human control");
    await releaseHumanLease(id, lease.leaseId, env);
  });

  it("reports a stale lease as recoverable, not active", async () => {
    const id = await createDesktop();
    const lease = await acquireHumanLease(id, env);
    const stalePath = path.join(env.PICKFORGE_HOME as string, "sessions", id, "human.lease.json");
    const stale = { ...lease, ownerPid: 999_999 };
    await fs.promises.writeFile(stalePath, `${JSON.stringify(stale)}\n`);

    const result = await takeoverStatus({ session: id, projectDir: root });
    expect(result.data).toMatchObject({ sessionId: id, active: false, stale: true });
    expect(result.lines?.join("\n")).toContain("stale human lease");
  });
});
