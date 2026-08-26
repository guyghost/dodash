import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        statements: 75,
        branches: 67,
        functions: 85,
        lines: 77,
      },
    },
  },
});
