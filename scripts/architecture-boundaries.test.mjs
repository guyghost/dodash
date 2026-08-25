import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(resolved);
      return /\.(?:ts|tsx|js|mjs)$/u.test(entry.name) ? [resolved] : [];
    }),
  );
  return nested.flat();
};

test("the production agent does not depend on the backtest package", async () => {
  const files = await sourceFiles(
    fileURLToPath(new URL("../apps/agent/src", import.meta.url)),
  );
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (source.includes('from "@dodash/backtest"')) violations.push(file);
  }
  assert.deepEqual(violations, []);
});
