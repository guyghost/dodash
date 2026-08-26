import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = path.resolve("scripts/generate-release-evidence.mjs");
const run = (output, releaseSha = "a".repeat(40)) =>
  spawnSync(
    process.execPath,
    [
      script,
      "--release-sha",
      releaseSha,
      "--generated-at",
      "2026-08-26T12:00:00.000Z",
      "--output",
      output,
    ],
    { encoding: "utf8" },
  );

test("génère puis valide une preuve live-OFF liée au SHA", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dodash-release-"));
  const output = path.join(directory, "nested", "release-evidence.json");

  const result = run(output);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
    schemaVersion: 1,
    releaseSha: "a".repeat(40),
    generatedAt: "2026-08-26T12:00:00.000Z",
    liveTradingEnabled: false,
    gates: {
      install: "passed",
      audit: "passed",
      secretScan: "passed",
      check: "passed",
      test: "passed",
      build: "passed",
      artifactTest: "passed",
    },
  });
});

test("refuse un SHA invalide sans créer de preuve", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dodash-release-"));
  const output = path.join(directory, "release-evidence.json");

  const result = run(output, "main");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INVALID_RELEASE_SHA/);
});

test("refuse d'écraser une preuve existante", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dodash-release-"));
  const output = path.join(directory, "release-evidence.json");
  await writeFile(output, "existing", "utf8");

  const result = run(output);

  assert.notEqual(result.status, 0);
  assert.equal(await readFile(output, "utf8"), "existing");
});

test("la CI produit et publie la preuve uniquement après le gate qualité", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const qualityGate = workflow.indexOf("run: pnpm verify:push");
  const generation = workflow.indexOf("node scripts/generate-release-evidence.mjs");
  const upload = workflow.indexOf("uses: actions/upload-artifact@v6");

  assert.ok(qualityGate >= 0);
  assert.ok(generation > qualityGate);
  assert.ok(upload > generation);
  assert.match(workflow, /--output \.artifacts\/releases\/release-evidence\.json/);
});
