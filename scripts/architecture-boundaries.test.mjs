import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  collectPublicExports,
  diffPublicExports,
} from "./public-exports.mjs";

const packagesRoot = fileURLToPath(new URL("../packages", import.meta.url));
const registryPath = fileURLToPath(
  new URL("../scripts/public-exports.json", import.meta.url),
);

// Library packages only: apps are deployables, not consumed as libraries.
const workspacePackages = async () => {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const manifest = JSON.parse(
      await readFile(path.join(packagesRoot, entry.name, "package.json"), "utf8"),
    );
    if (manifest.name.startsWith("@dodash/")) {
      packages.push({ name: manifest.name, dir: entry.name });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
};

const readRegistry = async () => readFile(registryPath, "utf8").then(JSON.parse);

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

// The public surface of a workspace package is a contract: removing a symbol
// must be a deliberate decision, not a silent side effect of a refactor.
// Update scripts/public-exports.json in the same commit as any intended change.
test("every workspace package exposes exactly its registered public surface", async () => {
  const registry = await readRegistry();
  const packages = await workspacePackages();
  const unregistered = packages
    .filter((pkg) => !Object.hasOwn(registry, pkg.name))
    .map((pkg) => pkg.name);
  assert.deepEqual(
    unregistered,
    [],
    "packages missing from scripts/public-exports.json — register their surface",
  );
  const drifted = [];
  for (const pkg of packages) {
    const barrel = path.join(packagesRoot, pkg.dir, "src", "index.ts");
    const collected = collectPublicExports(await readFile(barrel, "utf8"));
    const { missing, added } = diffPublicExports(collected, registry[pkg.name]);
    if (missing.length > 0 || added.length > 0) {
      drifted.push(
        `${pkg.name}: removed=[${missing.join(", ")}] added=[${added.join(", ")}]`,
      );
    }
  }
  assert.deepEqual(
    drifted,
    [],
    "public export surface changed — update scripts/public-exports.json deliberately",
  );
});

// Non-regression proof of the mechanism itself: this is exactly the change
// that went unnoticed in @dodash/domain (mapResult and createPosition removed
// with an entirely green CI).
test("the export freeze reports a removed public symbol", () => {
  const before = [
    'export { createPosition, createSignal } from "./trading.js";',
    'export { err, mapResult, ok } from "./result.js";',
  ].join("\n");
  const after = [
    'export { createSignal } from "./trading.js";',
    'export { err, ok } from "./result.js";',
  ].join("\n");
  const registered = collectPublicExports(before);
  assert.deepEqual(registered, [
    "createPosition",
    "createSignal",
    "err",
    "mapResult",
    "ok",
  ]);
  const { missing, added } = diffPublicExports(
    collectPublicExports(after),
    registered,
  );
  assert.deepEqual(missing, ["createPosition", "mapResult"]);
  assert.deepEqual(added, []);
});

test("the export collector fails closed on shapes it cannot classify", () => {
  assert.throws(
    () => collectPublicExports('export * from "./trading.js";'),
    /export \*/u,
  );
  assert.throws(
    () => collectPublicExports("export default 1;"),
    /export default/u,
  );
});
