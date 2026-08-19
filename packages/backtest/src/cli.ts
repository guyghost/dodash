import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { DEFAULT_INDICATOR_CONFIG } from "@dodash/indicators-prolog";

import {
  createBacktestRunId,
  parseBacktestCliOptions,
} from "./cli-options.js";
import { loadCoinbaseHistoricalDataset } from "./coinbase-history.js";
import { runModeledBacktest } from "./modeled-run.js";
import type { BacktestSuiteConfig } from "./suite.js";

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
const diagnosticValue = (value: number | null): string =>
  value === null ? "n/a" : value.toFixed(2);
const diagnosticPercent = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(4)}%`;

const main = async (): Promise<void> => {
  const options = parseBacktestCliOptions(process.argv.slice(2));
  if (!options.ok) throw new Error(options.error.code);

  const loadDataset = (timeframe: typeof options.value.timeframe) =>
    loadCoinbaseHistoricalDataset({
      productId: options.value.productId,
      timeframe,
      startAt: options.value.startAt,
      endAt: options.value.endAt,
    });
  const [dataset, executionDatasetResult] = await Promise.all([
    loadDataset(options.value.timeframe),
    options.value.executionTimeframe === null
      ? Promise.resolve(null)
      : loadDataset(options.value.executionTimeframe),
  ]);
  if (!dataset.ok) {
    throw new Error(JSON.stringify({ dataset: "PRIMARY", cause: dataset.error }));
  }
  if (executionDatasetResult !== null && !executionDatasetResult.ok) {
    throw new Error(
      JSON.stringify({ dataset: "EXECUTION", cause: executionDatasetResult.error }),
    );
  }
  const executionDataset = executionDatasetResult?.ok
    ? executionDatasetResult.value
    : null;

  const runId = createBacktestRunId(options.value);
  const config: BacktestSuiteConfig = Object.freeze({
    runId,
    agentId: "dodash-backtest",
    initialCapital: 10_000,
    maxDecisionNotional: 2_000,
    minNetQuantity: 0.000_001,
    targetSignalNotional: options.value.targetSignalNotional,
    confidenceCalibration: options.value.confidenceCalibration,
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
    protectiveExit: options.value.protectiveExit,
  });
  const result = await runModeledBacktest(
    dataset.value,
    config,
    executionDataset === null ? undefined : { executionDataset },
  );
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
  if (executionDataset !== null) {
    console.log(`Execution dataset: ${executionDataset.datasetId}`);
  }
  console.log(`Protective exit: ${options.value.protectiveExit.mode}`);
  console.log(`Target signal notional: ${options.value.targetSignalNotional}`);
  console.log(`Confidence calibration: ${options.value.confidenceCalibration}`);
  console.log(
    `Benchmark buy-and-hold: ${percent(result.value.report.benchmark.totalReturn)}`,
  );
  for (const scenario of result.value.report.scenarios) {
    console.log(
      `${scenario.id}: return=${percent(scenario.metrics.totalReturn)} excess=${percent(scenario.excessReturn)} drawdown=${percent(scenario.metrics.maxDrawdown)} trades=${scenario.tradeCount} stops=${scenario.stopLossExitCount} takes=${scenario.takeProfitExitCount} ambiguous=${scenario.ambiguousExitCount} cap=${percent(scenario.diagnostics.allocation.capRate)} risk-reject=${percent(scenario.diagnostics.allocation.riskRejectionRate)}`,
    );
    for (const signal of scenario.diagnostics.signals.byStrategy) {
      console.log(
        `  ${signal.strategyId}: active=${signal.activeSignalCount}/${signal.evaluationCount} confidence-p50=${diagnosticPercent(signal.confidence.median)} confidence-p95=${diagnosticPercent(signal.confidence.p95)} requested-p50=${diagnosticValue(signal.requestedNotional.median)} requested-p95=${diagnosticValue(signal.requestedNotional.p95)}`,
      );
    }
  }
  console.log(`Report: ${outputPath}`);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "UNKNOWN_BACKTEST_ERROR";
  console.error(`Backtest failed: ${message}`);
  process.exitCode = 1;
});
