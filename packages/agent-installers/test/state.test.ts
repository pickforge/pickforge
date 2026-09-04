import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentsState, recordAgentState } from "../src/state.js";

let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  fakeHome = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pickforge-lab-agentstate-fakehome-"),
  );
  homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
});

afterEach(async () => {
  homedirSpy.mockRestore();
  await fs.promises.rm(fakeHome, { recursive: true, force: true });
});

describe("readAgentsState legacy home fallback", () => {
  it("reads a legacy ~/.picklab/agents/state.json when PICKFORGE_HOME is unset", async () => {
    const legacyDir = path.join(fakeHome, ".picklab", "agents");
    await fs.promises.mkdir(legacyDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(legacyDir, "state.json"),
      JSON.stringify({
        agents: {
          "claude-code": {
            registered: true,
            configPath: "/legacy/.claude.json",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const state = await readAgentsState({});
    expect(state.agents["claude-code"]?.registered).toBe(true);
    expect(state.agents["claude-code"]?.configPath).toBe("/legacy/.claude.json");
  });

  it("reads the former ~/.pickforge/picklab state before ~/.picklab", async () => {
    for (const [dir, registered] of [
      [path.join(fakeHome, ".picklab", "agents"), false],
      [path.join(fakeHome, ".pickforge", "picklab", "agents"), true],
    ] as const) {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, "state.json"),
        JSON.stringify({
          agents: { codex: { registered, configPath: dir } },
        }),
      );
    }

    const state = await readAgentsState({});
    expect(state.agents.codex?.registered).toBe(true);
  });

  it("prefers the new home once it has its own state", async () => {
    await fs.promises.mkdir(path.join(fakeHome, ".picklab", "agents"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(fakeHome, ".picklab", "agents", "state.json"),
      JSON.stringify({
        agents: { codex: { registered: true, configPath: "/legacy/codex" } },
      }),
    );
    await recordAgentState(
      "codex",
      { registered: false, configPath: "/new/codex" },
      {},
    );

    const state = await readAgentsState({});
    expect(state.agents.codex?.registered).toBe(false);
    expect(state.agents.codex?.configPath).toBe("/new/codex");
  });

  it("does not fall back once PICKFORGE_HOME is set explicitly", async () => {
    await fs.promises.mkdir(path.join(fakeHome, ".picklab", "agents"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(fakeHome, ".picklab", "agents", "state.json"),
      JSON.stringify({
        agents: { codex: { registered: true, configPath: "/legacy/codex" } },
      }),
    );

    const state = await readAgentsState({ PICKFORGE_HOME: "/other" });
    expect(state.agents).toEqual({});
  });

  it("writes always target the new home, leaving legacy state untouched", async () => {
    const legacyPath = path.join(
      fakeHome,
      ".picklab",
      "agents",
      "state.json",
    );
    await fs.promises.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.promises.writeFile(
      legacyPath,
      JSON.stringify({
        agents: { codex: { registered: true, configPath: "/legacy/codex" } },
      }),
    );

    await recordAgentState(
      "cursor",
      { registered: true, configPath: "/new/cursor" },
      {},
    );

    const legacyRaw = JSON.parse(await fs.promises.readFile(legacyPath, "utf8"));
    expect(legacyRaw.agents.cursor).toBeUndefined();
    expect(
      fs.existsSync(
        path.join(fakeHome, ".pickforge", "lab", "agents", "state.json"),
      ),
    ).toBe(true);
  });
});
