import { err, ok, type Result } from "@dodash/domain";
import {
  backtestRunMachine,
  type BacktestRunContext,
} from "@dodash/models";
import { createActor } from "xstate";

import type { HistoricalDataset } from "./coinbase-history.js";
import {
  runBacktestSuite,
  type BacktestSuiteConfig,
  type BacktestSuiteReport,
} from "./suite.js";

export interface ModeledBacktestResult {
  readonly report: BacktestSuiteReport;
  readonly workflow: {
    readonly state: "completed";
    readonly context: BacktestRunContext;
  };
}

export type ModeledBacktestError =
  | { readonly code: "BACKTEST_WORKFLOW_STATE_INVALID" }
  | { readonly code: "BACKTEST_SUITE_FAILED"; readonly cause: unknown };

export const runModeledBacktest = async (
  dataset: HistoricalDataset,
  config: BacktestSuiteConfig,
): Promise<Result<ModeledBacktestResult, ModeledBacktestError>> => {
  const actor = createActor(backtestRunMachine, {
    input: { maxLoadRetries: 0 },
  }).start();
  actor.send({
    type: "START_REQUESTED",
    runId: config.runId,
    permissions: { canRunBacktest: true },
  });
  if (!actor.getSnapshot().matches("loadingHistoricalData")) {
    return err({ code: "BACKTEST_WORKFLOW_STATE_INVALID" });
  }
  actor.send({
    type: "HISTORICAL_DATA_READY",
    datasetId: dataset.datasetId,
    candleCount: dataset.candles.length,
  });
  if (!actor.getSnapshot().matches("replaying")) {
    return err({ code: "BACKTEST_WORKFLOW_STATE_INVALID" });
  }

  const suite = await runBacktestSuite(dataset, config);
  if (!suite.ok) {
    actor.send({
      type: "REPLAY_FAILED",
      error: { code: "REPLAY_FAILED", retryable: false },
    });
    return err({ code: "BACKTEST_SUITE_FAILED", cause: suite.error });
  }
  actor.send({
    type: "REPLAY_PROGRESS",
    processedCandles: dataset.candles.length,
  });
  actor.send({
    type: "REPLAY_COMPLETED",
    tradesId: `${config.runId}:trades`,
    tradeCount: suite.value.scenarios.reduce(
      (total, scenario) => total + scenario.tradeCount,
      0,
    ),
  });
  if (!actor.getSnapshot().matches("computingMetrics")) {
    return err({ code: "BACKTEST_WORKFLOW_STATE_INVALID" });
  }
  actor.send({ type: "METRICS_COMPUTED", metricsId: `${config.runId}:metrics` });
  const snapshot = actor.getSnapshot();
  if (!snapshot.matches("completed")) {
    return err({ code: "BACKTEST_WORKFLOW_STATE_INVALID" });
  }
  return ok(
    Object.freeze({
      report: suite.value,
      workflow: Object.freeze({
        state: "completed" as const,
        context: snapshot.context,
      }),
    }),
  );
};
