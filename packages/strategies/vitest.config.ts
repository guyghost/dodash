import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        statements: 63,
        branches: 55,
        functions: 66,
        lines: 65,
      },
    },
  },
});
