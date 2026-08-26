import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        statements: 82,
        branches: 76,
        functions: 95,
        lines: 90,
      },
    },
  },
});
