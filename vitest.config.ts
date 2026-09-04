import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { readPickforgeEnv } from "./packages/core/src/env-compat.js";

const runLiveAndroid =
  readPickforgeEnv(process.env, "LIVE_ANDROID") === "1";

export default defineConfig({
  resolve: {
    alias: {
      "@pickforge/lab-core": fileURLToPath(
        new URL("packages/core/src/index.ts", import.meta.url),
      ),
      "@pickforge/lab-desktop-linux": fileURLToPath(
        new URL("packages/desktop-linux/src/index.ts", import.meta.url),
      ),
      "@pickforge/lab-browser": fileURLToPath(
        new URL("packages/browser/src/index.ts", import.meta.url),
      ),
      "@pickforge/lab-android": fileURLToPath(
        new URL("packages/android/src/index.ts", import.meta.url),
      ),
      "@pickforge/lab-agent-installers": fileURLToPath(
        new URL("packages/agent-installers/src/index.ts", import.meta.url),
      ),
      "@pickforge/lab-mcp-server": fileURLToPath(
        new URL("packages/mcp-server/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
    exclude: runLiveAndroid ? [] : ["packages/android/test/integration.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/test/**/*.test.ts"],
      thresholds: {
        branches: 86,
        functions: 79,
        lines: 82,
        statements: 73,
      },
    },
  },
});
