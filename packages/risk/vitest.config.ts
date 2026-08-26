import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        statements: 83,
        branches: 87,
        functions: 95,
        lines: 88,
      },
    },
  },
});
