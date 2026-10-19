import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TS sources (matches the
    // "development" exports condition used by tsx/node dev runs).
    conditions: ["development"],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
