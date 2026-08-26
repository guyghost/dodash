import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        statements: 86,
        branches: 73,
        functions: 86,
        lines: 91,
      },
    },
  },
});
