import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/pickforge-lab.ts", "src/pickforge-mcp.ts"],
  format: ["esm"],
  platform: "node",
  clean: true,
  sourcemap: true,
  noExternal: [/^@pickforge\//],
});
