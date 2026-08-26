import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        statements: 74,
        branches: 51,
        functions: 95,
        lines: 78,
      },
    },
  },
});
