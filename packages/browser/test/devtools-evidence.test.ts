import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listRuns,
  readActions,
  saveProjectConfig,
  type EvidenceAction,
} from "@pickforge/lab-core";
import { createDevtoolsEvidenceRecorder } from "../src/devtools-evidence.js";
import type { JsonRpcMessage } from "../src/ndjson.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SECRET = "pickforge-lab-devtools-secret";
let projectDir: string;

beforeEach(async () => {
  projectDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pickforge-lab-devtools-evidence-"),
  );
  // These tests assert against the literal `.picklab/runs` layout.
  vi.stubEnv("PICKLAB_STORAGE_MODE", "project-local");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.promises.rm(projectDir, { recursive: true, force: true });
});

function call(
  id: string | number,
  name: string,
  args: Record<string, unknown>,
): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function response(
  id: string | number,
  result: Record<string, unknown>,
): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

async function recorder(reportFailure?: (detail: string) => void) {
  const created = await createDevtoolsEvidenceRecorder({
    projectDir,
    sessionId: "browser-evidence",
    reportFailure,
  });
  expect(created).toBeDefined();
  return created!;
}

async function actions(): Promise<EvidenceAction[]> {
  const [manifest] = await listRuns(projectDir);
  expect(manifest).toBeDefined();
  const records = await readActions(
    path.join(projectDir, ".picklab", "runs", manifest!.runId),
  );
  return records.filter(
    (record): record is EvidenceAction => "tool" in record,
  );
}

describe("DevTools evidence recorder", () => {
  it("correlates tool responses without persisting typed values or URL queries", async () => {
    const evidence = await recorder();
    await evidence.beforeForward(
      call(1, "fill", { uid: "1_1", value: SECRET }),
    );
    await evidence.afterResponse(response(1, { content: [] }));
    await evidence.beforeForward(
      call(2, "navigate_page", {
        type: "url",
        url: `https://user:${SECRET}@example.com/path?token=${SECRET}#hash`,
      }),
    );
    await evidence.afterResponse(response(2, { content: [] }));

    const records = await actions();
    expect(records).toMatchObject([
      {
        source: "devtools",
        tool: "chrome_devtools/fill",
        status: "ok",
        target: {
          selector: "1_1",
          length: SECRET.length,
          inputType: "other",
        },
      },
      {
        source: "devtools",
        tool: "chrome_devtools/navigate_page",
        status: "ok",
        target: { name: "url", url: "https://example.com/path" },
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });

  it("records redacted JSON-RPC and tool-result failures", async () => {
    const evidence = await recorder();
    await evidence.beforeForward(call(1, "click", { uid: "button" }));
    await evidence.afterResponse({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32_000, message: `token=${SECRET}` },
    });
    await evidence.beforeForward(call(2, "hover", { uid: "card" }));
    await evidence.afterResponse(
      response(2, {
        isError: true,
        content: [{ type: "text", text: `Authorization: Bearer ${SECRET}` }],
      }),
    );

    const records = await actions();
    expect(records).toMatchObject([
      { tool: "chrome_devtools/click", status: "error", error: "DevTools tool failed" },
      { tool: "chrome_devtools/hover", status: "error" },
    ]);
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });

  it("associates only explicit inline PNG screenshots", async () => {
    const evidence = await recorder();
    await evidence.beforeForward(call(1, "take_screenshot", {}));
    await evidence.afterResponse(
      response(1, {
        content: [
          { type: "image", mimeType: "image/png", data: PNG.toString("base64") },
        ],
      }),
    );

    const [record] = await actions();
    expect(record?.artifacts).toHaveLength(1);
    const [relative] = record!.artifacts!;
    expect(relative).toMatch(/^screenshots\/devtools-.+\.png$/);
    expect(fs.readFileSync(path.join(projectDir, ".picklab", "runs", (await listRuns(projectDir))[0]!.runId, relative!))).toEqual(PNG);
  });

  it("records only sanitized failed network and relevant console diagnostics", async () => {
    const evidence = await recorder();
    await evidence.beforeForward(call(1, "list_network_requests", {}));
    await evidence.afterResponse(
      response(1, {
        content: [],
        structuredContent: {
          networkRequests: [
            { method: "GET", url: "https://example.com/ok?token=secret", status: "200" },
            {
              method: "POST",
              url: `https://example.com/fail?token=${SECRET}`,
              status: "503",
              requestHeaders: { authorization: SECRET },
              responseBody: SECRET,
            },
            { method: "GET", url: "https://example.com/offline", status: `net::${SECRET}` },
            {
              method: "GET",
              url: "https://example.com/missing?private=value",
              status: 404,
              resourceType: "fetch",
              durationMs: 12.4,
            },
            {
              method: "GET",
              url: "https://example.com/dns",
              status: "net::ERR_NAME_NOT_RESOLVED",
            },
          ],
          consoleMessages: [
            { type: "log", text: SECRET },
            { type: "warning", text: `token=${SECRET}` },
            { type: "error", text: `Authorization: Bearer ${SECRET}` },
          ],
        },
      }),
    );

    const records = await actions();
    expect(records).toHaveLength(7);
    expect(records.slice(1)).toMatchObject([
      {
        tool: "network_failure",
        target: { method: "POST", url: "https://example.com/fail", status: 503 },
      },
      {
        tool: "network_failure",
        target: { method: "GET", url: "https://example.com/offline" },
      },
      {
        tool: "network_failure",
        target: {
          method: "GET",
          url: "https://example.com/missing",
          status: 404,
          resourceType: "fetch",
          durationMs: 12,
        },
      },
      {
        tool: "network_failure",
        target: {
          method: "GET",
          url: "https://example.com/dns",
          error: "net::ERR_NAME_NOT_RESOLVED",
        },
      },
      {
        tool: "console_message",
        target: { role: "warning" },
        error: "Console warning",
      },
      {
        tool: "console_message",
        target: { role: "error" },
        error: "Console error",
      },
    ]);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("requestHeaders");
    expect(serialized).not.toContain("responseBody");
  });

  it("flushes unanswered calls without persisting raw arguments", async () => {
    const evidence = await recorder();
    await evidence.beforeForward(call(7, "press_key", { key: SECRET }));

    await evidence.flushPending("timeout");

    const [record] = await actions();
    expect(record).toMatchObject({
      tool: "chrome_devtools/press_key",
      status: "timeout",
      target: { length: SECRET.length, inputType: "other" },
    });
    expect(JSON.stringify(record)).not.toContain(SECRET);
  });


  it("handles aggregate typing, coordinates, and unsafe tool names", async () => {
    const evidence = await recorder();
    await evidence.beforeForward(
      call(1, "fill_form", {
        elements: [
          { uid: "a", value: SECRET },
          { uid: "b", value: "two" },
          null,
          { uid: "ignored", value: 42 },
        ],
      }),
    );
    await evidence.afterResponse(response(1, { content: [] }));
    await evidence.beforeForward(call(2, `bad\n${SECRET}`, { x: 10, y: 20 }));
    await evidence.afterResponse(response(2, { content: [] }));
    await evidence.beforeForward(call(3, "click", { uid: SECRET }));
    await evidence.afterResponse(response(3, { content: [] }));
    await evidence.beforeForward(
      call(4, "navigate_page", {
        type: SECRET,
        url: `https://example.com/safe?secret=${SECRET}`,
      }),
    );
    await evidence.afterResponse(response(4, { content: [] }));
    await evidence.beforeForward(call(5, SECRET, {}));
    await evidence.afterResponse(response(5, { content: [] }));

    expect(await actions()).toMatchObject([
      {
        tool: "chrome_devtools/fill_form",
        target: {
          length: SECRET.length + 3,
          inputType: "other",
          fieldCount: 2,
        },
      },
      {
        tool: "chrome_devtools/unknown",
        target: { x: 10, y: 20 },
      },
      {
        tool: "chrome_devtools/click",
      },
      {
        tool: "chrome_devtools/navigate_page",
        target: { url: "https://example.com/safe" },
      },
      {
        tool: "chrome_devtools/unknown",
      },
    ]);
    expect(JSON.stringify(await actions())).not.toContain(SECRET);
  });

  it("ignores malformed and unmatched JSON-RPC traffic", async () => {
    const evidence = await recorder();
    await evidence.beforeForward({ jsonrpc: "2.0", method: "tools/list" });
    await evidence.beforeForward({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "click", arguments: {} },
    });
    await evidence.beforeForward({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: [],
    });
    await evidence.beforeForward({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: 42, arguments: SECRET },
    });
    await evidence.afterResponse(response(99, { content: [] }));
    await evidence.afterResponse({
      jsonrpc: "2.0",
      id: null,
      result: { content: [] },
    });

    expect(await actions()).toEqual([]);
  });

  it("fails closed on malformed JSON-RPC error members", async () => {
    const evidence = await recorder();
    await evidence.beforeForward(call(1, "click", {}));
    await evidence.afterResponse({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32_000 },
    });
    await evidence.beforeForward(call(2, "hover", {}));
    await evidence.afterResponse({
      jsonrpc: "2.0",
      id: 2,
      error: SECRET,
    });

    expect(await actions()).toMatchObject([
      { status: "error", error: "DevTools tool failed" },
      { status: "error", error: "DevTools tool failed" },
    ]);
    expect(JSON.stringify(await actions())).not.toContain(SECRET);
  });

  it("omits invalid inline screenshot payloads but records their calls", async () => {
    const evidence = await recorder();
    const payloads = [
      { type: "text", text: "not an image" },
      { type: "image", mimeType: "image/jpeg", data: PNG.toString("base64") },
      { type: "image", mimeType: "image/png", data: "not base64!" },
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.from("not a png").toString("base64"),
      },
    ];
    for (const [index, payload] of payloads.entries()) {
      await evidence.beforeForward(call(index, "take_screenshot", {}));
      await evidence.afterResponse(
        response(index, { content: [payload] }),
      );
    }

    const records = await actions();
    expect(records).toHaveLength(payloads.length);
    expect(records.every((record) => record.artifacts === undefined)).toBe(true);
  });

  it("rejects a swapped screenshot directory without writing outside the run", async () => {
    const failures: string[] = [];
    const evidence = await recorder((detail) => failures.push(detail));
    const [manifest] = await listRuns(projectDir);
    const runDir = path.join(
      projectDir,
      ".picklab",
      "runs",
      manifest!.runId,
    );
    const outside = path.join(projectDir, "outside");
    await fs.promises.mkdir(outside);
    await fs.promises.rm(path.join(runDir, "screenshots"), {
      recursive: true,
    });
    await fs.promises.symlink(outside, path.join(runDir, "screenshots"));

    await evidence.beforeForward(call(1, "take_screenshot", {}));
    await evidence.afterResponse(
      response(1, {
        content: [
          { type: "image", mimeType: "image/png", data: PNG.toString("base64") },
        ],
      }),
    );

    expect(await fs.promises.readdir(outside)).toEqual([]);
    expect((await actions())[0]?.artifacts).toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  it("removes inline screenshots rejected by the evidence cap", async () => {
    const evidence = await createDevtoolsEvidenceRecorder({
      projectDir,
      sessionId: "browser-capped",
      maxBytes: 1,
    });
    expect(evidence).toBeDefined();
    await evidence!.beforeForward(call(1, "take_screenshot", {}));
    await evidence!.afterResponse(
      response(1, {
        content: [
          { type: "image", mimeType: "image/png", data: PNG.toString("base64") },
        ],
      }),
    );

    const [manifest] = await listRuns(projectDir);
    const screenshots = await fs.promises.readdir(
      path.join(projectDir, ".picklab", "runs", manifest!.runId, "screenshots"),
    );
    expect(screenshots).toEqual([]);
  });

  it("keeps inline screenshots whose action crosses the evidence cap", async () => {
    const evidence = await createDevtoolsEvidenceRecorder({
      projectDir,
      sessionId: "browser-truncated",
      maxBytes: PNG.length + 50,
    });
    expect(evidence).toBeDefined();
    await evidence!.beforeForward(call(1, "take_screenshot", {}));
    await evidence!.afterResponse(
      response(1, {
        content: [
          { type: "image", mimeType: "image/png", data: PNG.toString("base64") },
        ],
      }),
    );

    const [record] = await actions();
    expect(record?.artifacts).toHaveLength(1);
    const [manifest] = await listRuns(projectDir);
    expect(
      fs.existsSync(
        path.join(
          projectDir,
          ".picklab",
          "runs",
          manifest!.runId,
          record!.artifacts![0]!,
        ),
      ),
    ).toBe(true);
  });
  it("is disabled by project configuration", async () => {
    await saveProjectConfig(projectDir, { evidence: { enabled: false } });

    expect(
      await createDevtoolsEvidenceRecorder({
        projectDir,
        sessionId: "browser-disabled",
      }),
    ).toBeUndefined();
    expect(await listRuns(projectDir)).toEqual([]);
  });

  it("reports evidence-write failures without rejecting relay hooks", async () => {
    const failures: string[] = [];
    const evidence = await recorder((detail) => failures.push(detail));
    await evidence.beforeForward(call(1, "click", { uid: "button" }));
    const [manifest] = await listRuns(projectDir);
    await fs.promises.rm(
      path.join(projectDir, ".picklab", "runs", manifest!.runId),
      { recursive: true, force: true },
    );

    await expect(
      evidence.afterResponse(response(1, { content: [] })),
    ).resolves.toBeUndefined();
    expect(failures).toHaveLength(1);
  });
});
