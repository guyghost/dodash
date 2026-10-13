/** Offline, fixed protocol 64806af. Never imports network or trading shells. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { replayP7Scenario, summarizeP7Windows, validateP7Datasets, PRODUCTS } from "./p7-execution-robustness-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "packages/backtest/package.json"));
const { createActor } = await import(require.resolve("xstate"));
const { P7_EXECUTION_SCENARIOS, p7ExecutionRobustnessMachine } = await import(require.resolve("@dodash/models"));
const FILES = {
  "BTC-USD": "233ded0cc0d1db2ceebc9ceb635ad92e54c016ad43fc231a0a72a797af99890b",
  "ETH-USD": "560e32c3307bfd8efe23e65676cb84582dea80221f03b232fe11e2566698f43a",
};
const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output" || !args[1])) throw new Error("Usage: node p7-execution-robustness-2026-10-13.mjs [--output NEW_DIRECTORY]");
const output = resolve(root, args[1] ?? "docs/analysis/evidence-p7-execution-robustness-2026-10-13");
const actor = createActor(p7ExecutionRobustnessMachine).start();
try {
  actor.send({ type: "START" });
  const datasets = {}, hashes = {};
  for (const product of PRODUCTS) {
    const path = `docs/analysis/evidence-backtest-daily-long-2026-10-09/job--${product}.json`;
    const raw = readFileSync(resolve(root, path)); hashes[path] = sha256(raw);
    if (hashes[path] !== FILES[product]) throw new Error("DATASET_SHA_MISMATCH");
    const job = JSON.parse(raw.toString("utf8"));
    if (job.product !== product || job.timeframe !== "ONE_DAY" || !Array.isArray(job.candles) || job.dataset?.filled !== 0) throw new Error("INVALID_DATASET_IDENTITY");
    datasets[product] = job.candles.map((tuple) => {
      if (!Array.isArray(tuple) || tuple.length !== 3) throw new Error("INVALID_CANDLE_TUPLE");
      return { start: tuple[0], open: tuple[1], close: tuple[2] };
    });
    if (datasets[product].length !== job.dataset.candles || datasets[product].at(-1)?.start !== Date.UTC(2026, 8, 30) ||
      datasets[product][0]?.start !== (product === "BTC-USD" ? Date.UTC(2015, 6, 21) : Date.UTC(2016, 4, 19))) throw new Error("DATASET_PERIOD_MISMATCH");
  }
  validateP7Datasets(datasets); actor.send({ type: "DATA_READY" });
  const trajectories = P7_EXECUTION_SCENARIOS.map((scenario) => replayP7Scenario(datasets, scenario));
  const results = trajectories.map(({ equity, orders, ...result }) => {
    const windows = summarizeP7Windows({ equity });
    return { ...result, windows, windowDrawdowns: windows.map((w) => w.maxDrawdown),
      brokerReasons: Object.fromEntries(["INSUFFICIENT_CASH", "INSUFFICIENT_POSITION"].map((code) => [code, orders.filter((o) => o.outcome === code).length])) };
  });
  actor.send({ type: "REPLAY_READY", results });
  const snapshot = actor.getSnapshot();
  if (snapshot.value !== "completed") throw new Error(snapshot.context.assessment?.verdict ?? "INVALID_RUN");
  const sourcePaths = [
    "models/p7-execution-robustness.md", "models/p7-execution-robustness.ts", "models/target-exposure.ts",
    "docs/analysis/p7-execution-robustness-core.mjs", "docs/analysis/p7-execution-robustness-2026-10-13.mjs",
    "docs/operations/paper-p7-start.json", "packages/paper-execution/src/index.ts", "packages/risk/src/risk.ts", "pnpm-lock.yaml",
    "models/dist/p7-execution-robustness.js", "models/dist/target-exposure.js", "packages/paper-execution/dist/index.js", "packages/risk/dist/risk.js",
  ];
  for (const path of sourcePaths) hashes[path] = sha256(readFileSync(resolve(root, path)));
  const reference = results[0];
  const summary = { protocol: "models/p7-execution-robustness.md", protocolCommit: "64806af",
    codeCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    createdAt: new Date().toISOString(), researchOnly: true, observation: "KNOWN_HISTORY_NOT_OOS",
    period: { firstStart: datasets["BTC-USD"][0].start, lastStart: datasets["BTC-USD"].at(-1).start, btcCandles: datasets["BTC-USD"].length, ethCandles: datasets["ETH-USD"].length },
    assessment: snapshot.context.assessment, sourceHashes: hashes,
    results: results.map((r) => ({ ...r, deltaCagr: r.cagr - reference.cagr, deltaDrawdown: r.maxDrawdown - reference.maxDrawdown })),
  };
  // Exclusive creation: never overwrite a previous run or capture.
  mkdirSync(output);
  const files = {};
  for (const result of trajectories) {
    const name = `${result.id}.json`, body = `${JSON.stringify(result)}\n`;
    writeFileSync(resolve(output, name), body, { flag: "wx" }); files[name] = sha256(body);
  }
  const body = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(resolve(output, "summary.json"), body, { flag: "wx" }); files["summary.json"] = sha256(body);
  writeFileSync(resolve(output, "sha256.json"), `${JSON.stringify(files, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ assessment: summary.assessment, results: results.map((r) => ({ id: r.id, cagr: r.cagr, maxDrawdown: r.maxDrawdown, finalEquity: r.finalEquity, fees: r.fees, slippageCost: r.slippageCost, counters: r.counters, windows: r.windows })) }, null, 2));
} catch (error) {
  if (actor.getSnapshot().status === "active") actor.send({ type: "FAILED" });
  throw error;
} finally { actor.stop(); }
