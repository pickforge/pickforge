import { readFileSync, readdirSync } from "node:fs";
import { SourceMap } from "node:module";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { ensureCliBuilt } from "./build-once.js";

const dist = new URL("../dist/", import.meta.url);

beforeAll(ensureCliBuilt, 300_000);

it("emits ESM bundles and linked sourcemaps for every CLI chunk", () => {
  const files = readdirSync(dist).filter((file) => file.endsWith(".js"));
  expect(files).toEqual(expect.arrayContaining(["pickforge-lab.js", "pickforge-mcp.js"]));
  for (const file of files) {
    const code = readFileSync(new URL(file, dist), "utf8");
    expect(code).toContain(`//# sourceMappingURL=${file}.map`);
    expect(code).not.toMatch(/(?:from\s*|import\s*\()["']@pickforge\//);
    const map = JSON.parse(readFileSync(new URL(`${file}.map`, dist), "utf8"));
    expect(map.version).toBe(3);
    // esbuild's generated runtime helpers have no original source to map.
    if (map.sources.length > 0) expect(map.mappings.length).toBeGreaterThan(0);
    expect(map.sourcesContent).toHaveLength(map.sources.length);
  }
});

it.each(["pickforge-lab", "pickforge-mcp"])(
  "maps %s entrypoint code back to the original TypeScript line",
  (entry) => {
    const code = readFileSync(new URL(`${entry}.js`, dist), "utf8");
    expect(code.startsWith("#!/usr/bin/env node\n")).toBe(true);
    const lines = code.split("\n");
    const line = lines.indexOf("initTelemetry();");
    expect(line).toBeGreaterThan(0);
    const payload = JSON.parse(readFileSync(new URL(`${entry}.js.map`, dist), "utf8"));
    const mapped = new SourceMap(payload).findEntry(line, 0);
    if (!("originalSource" in mapped)) throw new Error("Entrypoint mapping is missing");
    expect(mapped.originalSource).toBe(`../src/${entry}.ts`);
    const source = readFileSync(fileURLToPath(new URL(mapped.originalSource, dist)), "utf8");
    expect(source.split("\n")[mapped.originalLine]).toBe("initTelemetry();");
    expect(mapped.originalColumn).toBe(0);
  },
);
