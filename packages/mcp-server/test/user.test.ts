import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import type { ElicitResult } from "@modelcontextprotocol/server";
import { createMcpServer } from "../src/index.js";
import {
  connectLab,
  makeLabDirs,
  parseToolJson,
  removeLabDirs,
  type ConnectedLab,
  type LabDirs,
} from "./helpers.js";

interface ElicitingLab {
  client: Client;
  requests: Array<{ message: string; requestedSchema: unknown }>;
  respondWith(result: ElicitResult): void;
  close(): Promise<void>;
}

async function connectElicitingLab(dirs: LabDirs): Promise<ElicitingLab> {
  const server = createMcpServer({
    era: "legacy",
    projectDir: dirs.projectDir,
    env: { PICKLAB_HOME: dirs.home, PATH: dirs.binDir },
  });
  const client = new Client(
    { name: "picklab-test", version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  const requests: Array<{ message: string; requestedSchema: unknown }> = [];
  let nextResult: ElicitResult = { action: "cancel" };
  client.setRequestHandler("elicitation/create", async (request) => {
    const params = request.params as {
      message: string;
      requestedSchema: unknown;
    };
    requests.push({
      message: params.message,
      requestedSchema: params.requestedSchema,
    });
    return nextResult;
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    requests,
    respondWith(result) {
      nextResult = result;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("request_user_input with an elicitation-capable client", () => {
  let dirs: LabDirs;
  let lab: ElicitingLab;

  beforeEach(async () => {
    dirs = makeLabDirs();
    lab = await connectElicitingLab(dirs);
  });

  afterEach(async () => {
    await lab.close();
    removeLabDirs(dirs);
  });

  it("returns the user's text answer on accept", async () => {
    lab.respondWith({ action: "accept", content: { answer: "use the blue theme" } });
    const result = await lab.client.callTool({
      name: "request_user_input",
      arguments: {
        question: "Which theme should the settings screen use?",
        context: "Two themes are defined and the spec does not pick one.",
      },
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(true);
    expect(report.action).toBe("accept");
    expect(report.value).toBe("use the blue theme");
    expect(lab.requests).toHaveLength(1);
    expect(lab.requests[0]?.message).toContain(
      "Which theme should the settings screen use?",
    );
    expect(lab.requests[0]?.message).toContain(
      "Two themes are defined and the spec does not pick one.",
    );
  });

  it("returns the user's boolean answer for confirm questions", async () => {
    lab.respondWith({ action: "accept", content: { confirmed: true } });
    const result = await lab.client.callTool({
      name: "request_user_input",
      arguments: {
        question: "I've entered the password, continue?",
        kind: "confirm",
      },
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(true);
    expect(report.action).toBe("accept");
    expect(report.value).toBe(true);
    const schema = lab.requests[0]?.requestedSchema as {
      properties: Record<string, { type: string }>;
    };
    expect(Object.values(schema.properties)[0]?.type).toBe("boolean");
  });

  it("reports a decline without inventing an answer", async () => {
    lab.respondWith({ action: "decline" });
    const result = await lab.client.callTool({
      name: "request_user_input",
      arguments: { question: "Should I delete the old baselines?" },
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(false);
    expect(report.action).toBe("decline");
    expect(report.value).toBeUndefined();
    expect(report.errors[0]).toContain("declined");
  });

  it("reports a cancel without inventing an answer", async () => {
    lab.respondWith({ action: "cancel" });
    const result = await lab.client.callTool({
      name: "request_user_input",
      arguments: { question: "Should I delete the old baselines?" },
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(false);
    expect(report.action).toBe("cancel");
    expect(report.errors[0]).toContain("dismissed");
  });

  it("blocks text questions that ask for secrets, with VNC guidance", async () => {
    const result = await lab.client.callTool({
      name: "request_user_input",
      arguments: { question: "What is your GitHub API key?" },
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/vnc/i);
    expect(report.errors[0]).toContain('"confirm"');
    expect(lab.requests).toHaveLength(0);
  });

  it("allows confirm questions that mention secrets", async () => {
    lab.respondWith({ action: "accept", content: { confirmed: true } });
    const result = await lab.client.callTool({
      name: "request_user_input",
      arguments: {
        question: "I've typed the API key into the app, continue?",
        kind: "confirm",
      },
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(true);
    expect(report.value).toBe(true);
  });
});

describe("request_user_input without elicitation support", () => {
  let dirs: LabDirs;
  let lab: ConnectedLab;

  beforeEach(async () => {
    dirs = makeLabDirs();
    lab = await connectLab({
      era: "legacy",
      projectDir: dirs.projectDir,
      env: { PICKLAB_HOME: dirs.home, PATH: dirs.binDir },
    });
  });

  afterEach(async () => {
    await lab.close();
    removeLabDirs(dirs);
  });

  it("tells the agent to relay the question in the conversation", async () => {
    const result = await lab.client.callTool({
      name: "request_user_input",
      arguments: { question: "Which AVD should I use?" },
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toContain("does not support elicitation");
    expect(report.errors[0]).toContain("Relay the question");
  });

  it("still blocks secret-pattern questions before checking capabilities", async () => {
    const result = await lab.client.callTool({
      name: "request_user_input",
      arguments: { question: "Please give me the 2FA code" },
    });
    const report = parseToolJson(result);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/vnc/i);
  });
});

describe("request_user_input in the modern era", () => {
  it("returns deterministic relay guidance without push elicitation", async () => {
    const dirs = makeLabDirs();
    const lab = await connectLab({
      era: "modern",
      projectDir: dirs.projectDir,
      env: { PICKLAB_HOME: dirs.home, PATH: dirs.binDir },
    });
    try {
      const result = await lab.client.callTool({
        name: "request_user_input",
        arguments: { question: "Which AVD should I use?" },
      });
      const report = parseToolJson(result);
      expect(report.ok).toBe(false);
      expect(report.errors[0]).toContain("Modern MCP");
      expect(report.errors[0]).toContain("Relay the question");
      expect(report.errors[0]).toContain("retry this tool");
    } finally {
      await lab.close();
      removeLabDirs(dirs);
    }
  });
});
