import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: "test",
      APP_SECRET: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
      DATA_DIR: ".data-test",
      PUBLIC_ORIGIN: "http://localhost:3000",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
