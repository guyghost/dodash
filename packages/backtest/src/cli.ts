import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";

import { parseBacktestCliOptions } from "./cli-options.js";
import { loadCoinbaseHistoricalDataset } from "./coinbase-history.js";
import { runModeledBacktest } from "./modeled-run.js";
import type { BacktestSuiteConfig } from "./suite.js";

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

const main = async (): Promise<void> => {
  const options = parseBacktestCliOptions(process.argv.slice(2));
  if (!options.ok) throw new Error(options.error.code);

  const dataset = await loadCoinbaseHistoricalDataset({
    productId: options.value.productId,
    timeframe: options.value.timeframe,
    startAt: options.value.startAt,
    endAt: options.value.endAt,
  });
  if (!dataset.ok) throw new Error(JSON.stringify(dataset.error));

  const runId = [
    "bt",
    options.value.productId,
    options.value.timeframe,
    options.value.startAt,
    options.value.endAt,
  ].join(":");
  const config: BacktestSuiteConfig = Object.freeze({
    runId,
    agentId: "dodash-backtest",
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    baseSize: 0.01,
    indicators: DEFAULT_INDICATOR_CONFIG,
    risk: Object.freeze({
      maxOrderNotional: 2_000,
      maxPositionNotional: 10_000,
      maxGrossExposure: 20_000,
      maxDailyLoss: 1_000,
      cooldownMs: 0,
      stopLossBps: 150,
      takeProfitBps: 300,
    }),
    broker: Object.freeze({ feeBps: 6, slippageBps: 2 }),
  });
  const result = await runModeledBacktest(dataset.value, config);
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  const artifact = Object.freeze({
    generatedAt: new Date().toISOString(),
    executionPolicy: "NEXT_CANDLE_OPEN" as const,
    market: "SPOT_LONG_ONLY" as const,
    workflow: result.value.workflow,
    ...result.value.report,
  });
  const outputPath = resolve(options.value.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Dataset: ${dataset.value.datasetId}`);
  console.log(
    `Benchmark buy-and-hold: ${percent(result.value.report.benchmark.totalReturn)}`,
  );
  for (const scenario of result.value.report.scenarios) {
    console.log(
      `${scenario.id}: return=${percent(scenario.metrics.totalReturn)} excess=${percent(scenario.excessReturn)} drawdown=${percent(scenario.metrics.maxDrawdown)} trades=${scenario.tradeCount}`,
    );
  }
  console.log(`Report: ${outputPath}`);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_BACKTEST_ERROR";
  console.error(`Backtest failed: ${message}`);
  process.exitCode = 1;
});
